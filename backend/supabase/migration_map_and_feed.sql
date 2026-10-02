-- ============================================================================
-- StudyHub — Map + Community Feed additions
-- Run in: Supabase Dashboard -> SQL Editor, AFTER dashboard_schema.sql and
-- migration_profile_and_identity.sql (this needs the identity_status column
-- that migration adds).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Real coordinates on institutions, for the Leaflet/OpenStreetMap widget
-- ---------------------------------------------------------------------------
alter table public.institutions
    add column if not exists latitude  double precision,
    add column if not exists longitude double precision;

-- (institutions_select_public policy already allows everyone to read these)


-- ---------------------------------------------------------------------------
-- 2. Community posts need a body + optional image on top of the existing
--    title/subject/class_level/answer_count columns from dashboard_schema.sql
-- ---------------------------------------------------------------------------
alter table public.questions
    add column if not exists body       text,
    add column if not exists image_url  text;


-- ---------------------------------------------------------------------------
-- 3. SAFE PUBLIC AUTHOR VIEW
--
--    public.profiles has "profiles_select_own" — a student can only read
--    their OWN row. That's correct and we are NOT changing it. But the
--    community feed needs to show *other* students' display names next to
--    their posts. Postgres RLS can't restrict individual columns, so the
--    fix is a narrow view exposing only what's safe to show publicly
--    (name + the ID-verification badge — never phone/institution/etc).
--
--    Uses identity_status (verified by an admin reviewing a scanned ID),
--    not verification_status (which just means "confirmed their email" —
--    true for literally every logged-in user, so it wouldn't mean much as
--    a public trust badge).
-- ---------------------------------------------------------------------------
create or replace view public.public_profiles
    with (security_invoker = false) as
select user_id, full_name, identity_status
from public.profiles;

grant select on public.public_profiles to authenticated;


-- ---------------------------------------------------------------------------
-- 4. STORAGE — bucket for post images
--    Public bucket: community post images are already visible to every
--    logged-in student via the open "questions_select_all" policy, so a
--    public bucket is consistent with that, not a new exposure. Students
--    can only upload into a folder named after their own user id.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('community-uploads', 'community-uploads', true)
on conflict (id) do nothing;

drop policy if exists "community_uploads_read_all" on storage.objects;
create policy "community_uploads_read_all" on storage.objects
    for select to anon, authenticated
    using (bucket_id = 'community-uploads');

drop policy if exists "community_uploads_insert_own_folder" on storage.objects;
create policy "community_uploads_insert_own_folder" on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'community-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

drop policy if exists "community_uploads_delete_own" on storage.objects;
create policy "community_uploads_delete_own" on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'community-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
    );
