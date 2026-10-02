-- ============================================================================
-- StudyHub — authentication schema
-- Run this whole file once in: Supabase Dashboard -> SQL Editor -> New query
-- It is idempotent-ish: safe to re-run after a "drop" pass (see bottom).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. INSTITUTIONS (public reference data: schools / colleges)
-- ---------------------------------------------------------------------------
create table if not exists public.institutions (
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    type       text not null default 'school'
               check (type in ('school', 'college', 'university', 'other')),
    city       text,
    created_at timestamptz not null default now()
);

create unique index if not exists institutions_name_city_key
    on public.institutions (lower(name), coalesce(lower(city), ''));

alter table public.institutions enable row level security;

-- Reference data only (name / city). No private user data lives here,
-- so a read-for-everyone policy is correct and intentional.
drop policy if exists "institutions_select_public" on public.institutions;
create policy "institutions_select_public"
    on public.institutions
    for select
    to anon, authenticated
    using (true);

-- Nobody may write from the browser. Add rows from the SQL editor.
revoke insert, update, delete on public.institutions from anon, authenticated;

-- Seed a few rows so the dropdown is not empty. Replace with your own list.
insert into public.institutions (name, type, city) values
    ('Budhanilkantha School',              'school',     'Kathmandu'),
    ('St. Xavier''s College',              'college',    'Kathmandu'),
    ('Kathmandu Model College',            'college',    'Kathmandu'),
    ('Trinity International College',      'college',    'Kathmandu'),
    ('Little Angels'' School',             'school',     'Lalitpur'),
    ('Nepal Commerce Campus',              'college',    'Kathmandu'),
    ('Tribhuvan University',               'university', 'Kirtipur'),
    ('Kathmandu University',               'university', 'Dhulikhel'),
    ('Pokhara University',                 'university', 'Pokhara'),
    ('Other / not listed',                 'other',      null)
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- 2. PROFILES
--    Passwords are NEVER stored here. Supabase Auth owns credentials.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
    id                  uuid primary key default gen_random_uuid(),

    user_id             uuid not null unique
                        references auth.users(id) on delete cascade,

    full_name           text not null,

    phone               text,

    role                text not null default 'student'
                        check (role in ('student', 'teacher', 'admin')),

    institution_id      uuid references public.institutions(id) on delete set null,

    class_level         text,

    verification_status text not null default 'pending'
                        check (verification_status in ('pending', 'verified', 'rejected')),

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists profiles_user_id_idx on public.profiles (user_id);


-- ---------------------------------------------------------------------------
-- 3. AUTO-CREATE THE PROFILE WHEN AN AUTH USER IS CREATED
--    The browser sends full_name / phone / role / etc. as sign-up metadata.
--    We read it here, sanitise it, and write the profile with elevated rights.
--    This is why the frontend never has to INSERT into profiles itself.
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
    -- Role is clamped to student/teacher. 'admin' can never arrive this way.
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
         left(nullif(new.raw_user_meta_data ->> 'phone', ''), 32),
         v_role,
         v_inst,
         left(v_class, 32),
         case when new.email_confirmed_at is not null then 'verified' else 'pending' end)
    on conflict (user_id) do nothing;

    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();


-- ---------------------------------------------------------------------------
-- 4. FLIP verification_status -> 'verified' ONLY WHEN SUPABASE CONFIRMS
--    THE EMAIL. The browser can never do this itself (see the guard below).
-- ---------------------------------------------------------------------------
create or replace function public.handle_user_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.email_confirmed_at is not null and old.email_confirmed_at is null then
        -- Tell the profiles guard trigger that this particular update is
        -- coming from the trusted path, not from a browser request.
        perform set_config('studyhub.bypass_profile_guard', 'on', true);

        update public.profiles
           set verification_status = 'verified',
               updated_at          = now()
         where user_id = new.id;

        perform set_config('studyhub.bypass_profile_guard', 'off', true);
    end if;

    return new;
end;
$$;

drop trigger if exists on_auth_user_email_confirmed on auth.users;
create trigger on_auth_user_email_confirmed
    after update of email_confirmed_at on auth.users
    for each row execute function public.handle_user_email_confirmed();


-- ---------------------------------------------------------------------------
-- 5. GUARD: privileged columns are immutable from a normal session
--    Even if an attacker crafts an UPDATE by hand, these fields snap back.
-- ---------------------------------------------------------------------------
create or replace function public.profiles_guard_protected_columns()
returns trigger
language plpgsql
as $$
begin
    if coalesce(current_setting('studyhub.bypass_profile_guard', true), 'off') = 'on' then
        new.updated_at := now();
        return new;
    end if;

    new.id                  := old.id;
    new.user_id             := old.user_id;
    new.role                := old.role;
    new.verification_status := old.verification_status;
    new.created_at          := old.created_at;
    new.updated_at          := now();

    return new;
end;
$$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
    before update on public.profiles
    for each row execute function public.profiles_guard_protected_columns();


-- ---------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
    on public.profiles
    for select
    to authenticated
    using (auth.uid() = user_id);

-- Fallback insert path. The trigger normally does this, but if you ever
-- disable email confirmation, a signed-in user can create their own row.
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
    on public.profiles
    for insert
    to authenticated
    with check (
        auth.uid() = user_id
        and role in ('student', 'teacher')
    );

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
    on public.profiles
    for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- No delete policy: profiles disappear only when the auth user is deleted.

-- ---------------------------------------------------------------------------
-- 7. COLUMN-LEVEL GRANTS (second lock on the same door)
--    'authenticated' simply has no UPDATE privilege on role /
--    verification_status / user_id, so the attempt fails before RLS runs.
-- ---------------------------------------------------------------------------
revoke all on public.profiles from anon, authenticated;

grant select on public.profiles to authenticated;

grant insert (user_id, full_name, phone, role, institution_id, class_level)
    on public.profiles to authenticated;

grant update (full_name, phone, institution_id, class_level)
    on public.profiles to authenticated;


-- ---------------------------------------------------------------------------
-- 8. PROMOTING AN ADMIN — run manually, never from the frontend
-- ---------------------------------------------------------------------------
-- select set_config('studyhub.bypass_profile_guard', 'on', true);
-- update public.profiles set role = 'admin'
--  where user_id = (select id from auth.users where email = 'you@example.com');


-- ---------------------------------------------------------------------------
-- 9. CLEAN RESET (only if you want to start over)
-- ---------------------------------------------------------------------------
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop trigger if exists on_auth_user_email_confirmed on auth.users;
-- drop function if exists public.handle_new_user();
-- drop function if exists public.handle_user_email_confirmed();
-- drop table if exists public.profiles cascade;
-- drop table if exists public.institutions cascade;
