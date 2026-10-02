-- ============================================================================
-- StudyHub — migration: support phone-number sign-ups
-- Run this once in the SQL Editor, after schema.sql has already been applied.
-- It replaces two trigger functions and adds a matching trigger for phone
-- confirmation, so phone-based accounts get verified exactly like email ones.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. handle_new_user(): a brand-new user can now arrive with an email OR a
--    phone number (never both, in this app). Treat whichever confirmation
--    timestamp exists as "already verified" — relevant for the Google OAuth
--    path, where Google confirms the email for us up front.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role  text;
    v_inst  uuid;
    v_class text;
    v_name  text;
begin
    v_role := lower(coalesce(new.raw_user_meta_data ->> 'role', 'student'));
    if v_role not in ('student', 'teacher') then
        v_role := 'student';
    end if;

    begin
        v_inst := nullif(new.raw_user_meta_data ->> 'institution_id', '')::uuid;
    exception when others then
        v_inst := null;
    end;

    v_class := nullif(new.raw_user_meta_data ->> 'class_level', '');
    v_name  := coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 'StudyHub member');

    insert into public.profiles
        (user_id, full_name, phone, role, institution_id, class_level, verification_status)
    values
        (new.id,
         left(v_name, 120),
         left(coalesce(nullif(new.raw_user_meta_data ->> 'phone', ''), new.phone), 32),
         v_role,
         v_inst,
         left(v_class, 32),
         case
             when coalesce(new.email_confirmed_at, new.phone_confirmed_at) is not null
                 then 'verified'
             else 'pending'
         end)
    on conflict (user_id) do nothing;

    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Confirmation triggers: one for email, one for phone, sharing the same
--    underlying function so the "bypass" flag logic isn't duplicated.
-- ---------------------------------------------------------------------------
create or replace function public.handle_user_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if coalesce(new.email_confirmed_at, new.phone_confirmed_at) is not null then
        perform set_config('studyhub.bypass_profile_guard', 'on', true);

        update public.profiles
           set verification_status = 'verified',
               updated_at          = now()
         where user_id = new.id
           and verification_status <> 'verified';

        perform set_config('studyhub.bypass_profile_guard', 'off', true);
    end if;

    return new;
end;
$$;

drop trigger if exists on_auth_user_email_confirmed on auth.users;
drop trigger if exists on_auth_user_phone_confirmed on auth.users;

create trigger on_auth_user_email_confirmed
    after update of email_confirmed_at on auth.users
    for each row execute function public.handle_user_verified();

create trigger on_auth_user_phone_confirmed
    after update of phone_confirmed_at on auth.users
    for each row execute function public.handle_user_verified();

-- The old function name is superseded by handle_user_verified() above.
drop function if exists public.handle_user_email_confirmed();
