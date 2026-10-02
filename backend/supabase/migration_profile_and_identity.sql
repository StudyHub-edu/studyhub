-- ============================================================================
-- StudyHub — migration: profile pictures + ID card verification
-- Run this once in the SQL Editor, after schema.sql and the other migrations.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Allow ROLE to be chosen once, during onboarding only.
--    "Onboarding" is precisely defined as: institution_id is still null.
--    Once it's set, role locks again — exactly like it always has. This is
--    what lets a first-time Google sign-in pick "Teacher" instead of being
--    stuck with the "student" default forever, without reopening the door
--    to self-promoting to admin at any other time.
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
    new.verification_status := old.verification_status;
    new.identity_status      := old.identity_status;
    new.created_at          := old.created_at;
    new.updated_at          := now();

    if old.institution_id is null and new.role in ('student', 'teacher') then
        -- still onboarding: the chosen role is allowed through as-is
        null;
    else
        new.role := old.role;
    end if;

    return new;
end;
$$;

grant update (role) on public.profiles to authenticated;


-- ---------------------------------------------------------------------------
-- 1. Avatar column on profiles
-- ---------------------------------------------------------------------------
alter table public.profiles
    add column if not exists avatar_url text;

-- Let a user set their own avatar_url (already have update on the other
-- personal fields — this just adds one more to that same grant).
grant update (full_name, phone, institution_id, class_level, avatar_url)
    on public.profiles to authenticated;


-- ---------------------------------------------------------------------------
-- 2. is_admin() helper — used by every "admins can see/do everything" policy
--    below, so that logic lives in exactly one place.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select exists (
        select 1 from public.profiles
        where user_id = auth.uid() and role = 'admin'
    );
$$;


-- ---------------------------------------------------------------------------
-- 3. IDENTITY VERIFICATIONS
--    One row per scan attempt. The status column can only ever be set to
--    'pending' by the person submitting it — only an admin can move it to
--    'verified' or 'rejected'. This is what keeps the OCR (which runs in the
--    browser, and so can't be trusted on its own) from being able to grant
--    itself a trust badge.
-- ---------------------------------------------------------------------------
create table if not exists public.identity_verifications (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid not null references auth.users(id) on delete cascade,

    role_at_submission    text not null check (role_at_submission in ('student', 'teacher')),

    image_path            text not null,  -- path inside the private 'id-cards' storage bucket

    extracted_full_name       text,
    extracted_institution_id  uuid references public.institutions(id) on delete set null,
    extracted_institution_raw text,        -- raw OCR text, kept even if no institution matched
    extracted_class_level     text,
    extracted_expiry_date     date,
    extracted_text            text,         -- full bounded OCR result shown to admins during review

    status        text not null default 'pending'
                  check (status in ('pending', 'verified', 'rejected')),
    reviewed_by   uuid references auth.users(id) on delete set null,
    reviewed_at   timestamptz,
    review_note   text,

    created_at    timestamptz not null default now()
);

create index if not exists identity_verifications_user_idx
    on public.identity_verifications (user_id, created_at desc);
create index if not exists identity_verifications_status_idx
    on public.identity_verifications (status, created_at);

alter table public.identity_verifications enable row level security;

drop policy if exists "identity_verifications_select_own_or_admin" on public.identity_verifications;
create policy "identity_verifications_select_own_or_admin"
    on public.identity_verifications
    for select
    to authenticated
    using (auth.uid() = user_id or public.is_admin());

drop policy if exists "identity_verifications_insert_own" on public.identity_verifications;
create policy "identity_verifications_insert_own"
    on public.identity_verifications
    for insert
    to authenticated
    with check (auth.uid() = user_id);

drop policy if exists "identity_verifications_admin_update" on public.identity_verifications;
create policy "identity_verifications_admin_update"
    on public.identity_verifications
    for update
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());

revoke all on public.identity_verifications from anon, authenticated;
grant select, insert on public.identity_verifications to authenticated;
-- Note: no column-level insert grant restriction needed for status, because
-- the table default ('pending') plus the fact that only admins can UPDATE
-- already makes it impossible for a submitter to reach 'verified' — even if
-- they explicitly insert status='verified' in the request, add a guard too:
grant update on public.identity_verifications to authenticated; -- gated entirely by the admin-only USING clause above

create or replace function public.clamp_identity_verification_insert()
returns trigger
language plpgsql
as $$
begin
    new.status      := 'pending';
    new.reviewed_by := null;
    new.reviewed_at := null;
    return new;
end;
$$;

drop trigger if exists identity_verifications_clamp on public.identity_verifications;
create trigger identity_verifications_clamp
    before insert on public.identity_verifications
    for each row execute function public.clamp_identity_verification_insert();


-- ---------------------------------------------------------------------------
-- 4. identity_status on profiles — the field the "Verified" badge checks.
--    Kept separate from verification_status (which is about email/phone
--    login access, not identity trust).
-- ---------------------------------------------------------------------------
alter table public.profiles
    add column if not exists identity_status text not null default 'not_submitted'
    check (identity_status in ('not_submitted', 'pending', 'verified', 'rejected'));

create or replace function public.sync_identity_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    perform set_config('studyhub.bypass_profile_guard', 'on', true);

    update public.profiles
       set identity_status = new.status,
           updated_at      = now(),
           full_name       = coalesce(nullif(new.extracted_full_name, ''), full_name),
           institution_id  = coalesce(new.extracted_institution_id, institution_id),
           class_level     = coalesce(nullif(new.extracted_class_level, ''), class_level)
     where user_id = new.user_id;

    perform set_config('studyhub.bypass_profile_guard', 'off', true);
    return new;
end;
$$;

drop trigger if exists identity_verifications_sync_insert on public.identity_verifications;
create trigger identity_verifications_sync_insert
    after insert on public.identity_verifications
    for each row execute function public.sync_identity_status();

drop trigger if exists identity_verifications_sync_update on public.identity_verifications;
create trigger identity_verifications_sync_update
    after update of status on public.identity_verifications
    for each row execute function public.sync_identity_status();


-- ---------------------------------------------------------------------------
-- 5. STORAGE — two buckets:
--      avatars   public, small profile pictures
--      id-cards  private, only the owner and admins can ever read them
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars', 'avatars', true, 5242880)      -- 5 MB
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit)
values ('id-cards', 'id-cards', false, 10485760)  -- 10 MB
on conflict (id) do nothing;

-- Avatars: anyone can view (it's a public bucket), each user can only
-- write/replace/delete inside their own folder (path starts with their uid).
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read"
    on storage.objects for select
    to anon, authenticated
    using (bucket_id = 'avatars');

drop policy if exists "avatars_owner_write" on storage.objects;
create policy "avatars_owner_write"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars_owner_update" on storage.objects;
create policy "avatars_owner_update"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars_owner_delete" on storage.objects;
create policy "avatars_owner_delete"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ID cards: private. Only the owner or an admin can read; only the owner
-- (and only into their own folder) can upload. Nobody can overwrite or
-- delete a submitted ID — that would defeat the point of an audit trail.
drop policy if exists "id_cards_owner_or_admin_read" on storage.objects;
create policy "id_cards_owner_or_admin_read"
    on storage.objects for select
    to authenticated
    using (
        bucket_id = 'id-cards'
        and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
    );

drop policy if exists "id_cards_owner_write" on storage.objects;
create policy "id_cards_owner_write"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'id-cards' and (storage.foldername(name))[1] = auth.uid()::text);
