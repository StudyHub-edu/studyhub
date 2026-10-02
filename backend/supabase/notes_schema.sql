-- ============================================================================
-- StudyHub — Notes system
-- Builds on the existing public.resources table (supabase/admin_schema.sql)
-- instead of creating a parallel table. Run this after admin_schema.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. New columns on the existing resources table (all nullable / defaulted,
--    so this never breaks the admin dashboard's existing queries).
-- ---------------------------------------------------------------------------
alter table public.resources
  add column if not exists description     text,
  add column if not exists chapter         text,
  add column if not exists tags            text[] not null default '{}',
  add column if not exists note_type       text not null default 'text'
      check (note_type in ('text', 'image', 'link', 'video_link', 'video_file')),
  add column if not exists content_text    text,        -- body when note_type = 'text'
  add column if not exists external_url    text,        -- study-material link, video link, or the uploaded file's public URL
  add column if not exists image_urls      text[] not null default '{}',
  add column if not exists allow_download  boolean not null default true,
  add column if not exists views_count     int not null default 0,
  add column if not exists downloads_count int not null default 0;

create index if not exists resources_subject_idx      on public.resources (subject);
create index if not exists resources_class_level_idx  on public.resources (class_level);
create index if not exists resources_uploaded_by_idx  on public.resources (uploaded_by);

-- ---------------------------------------------------------------------------
-- 2. Fix a real gap in the existing RLS: today only an admin can insert,
--    update, delete, or even see a resource (resources_admin_all), and
--    everyone else can only ever SELECT rows already approved. That means a
--    teacher/student could never actually upload or manage their own note.
--    Add the missing "own row" policies — this is additive; the two
--    existing policies (resources_admin_all, resources_select_approved)
--    are untouched.
-- ---------------------------------------------------------------------------
drop policy if exists "resources_insert_own" on public.resources;
create policy "resources_insert_own" on public.resources
    for insert to authenticated
    with check (auth.uid() = uploaded_by);

drop policy if exists "resources_select_own" on public.resources;
create policy "resources_select_own" on public.resources
    for select to authenticated
    using (auth.uid() = uploaded_by);

drop policy if exists "resources_update_own" on public.resources;
create policy "resources_update_own" on public.resources
    for update to authenticated
    using (auth.uid() = uploaded_by)
    with check (auth.uid() = uploaded_by);

drop policy if exists "resources_delete_own" on public.resources;
create policy "resources_delete_own" on public.resources
    for delete to authenticated
    using (auth.uid() = uploaded_by);

-- New uploads start out visible only to their owner (and admins) until
-- approved, matching resources_select_approved's "approved = public" rule.
alter table public.resources alter column status set default 'pending';

-- ---------------------------------------------------------------------------
-- 3. Saves (favourites) and ratings — separate per-user tables rather than
--    a single mutable counter, so counts stay honest and a person can
--    change/remove their own rating or save later.
-- ---------------------------------------------------------------------------
create table if not exists public.note_saves (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references public.profiles(user_id) on delete cascade,
    resource_id uuid not null references public.resources(id) on delete cascade,
    created_at  timestamptz not null default now(),
    unique (user_id, resource_id)
);

create table if not exists public.note_ratings (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references public.profiles(user_id) on delete cascade,
    resource_id uuid not null references public.resources(id) on delete cascade,
    rating      int not null check (rating between 1 and 5),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    unique (user_id, resource_id)
);

alter table public.note_saves   enable row level security;
alter table public.note_ratings enable row level security;

revoke all on public.note_saves, public.note_ratings from anon, authenticated;
grant select, insert, delete on public.note_saves to authenticated;
grant select, insert, update, delete on public.note_ratings to authenticated;

-- Counts need to be visible to everyone (that's the whole point of showing
-- "12 saves, 4.5 stars"), but writing is only ever allowed to your own row.
drop policy if exists "note_saves_select_all" on public.note_saves;
create policy "note_saves_select_all" on public.note_saves
    for select to authenticated using (true);
drop policy if exists "note_saves_insert_own" on public.note_saves;
create policy "note_saves_insert_own" on public.note_saves
    for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "note_saves_delete_own" on public.note_saves;
create policy "note_saves_delete_own" on public.note_saves
    for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "note_ratings_select_all" on public.note_ratings;
create policy "note_ratings_select_all" on public.note_ratings
    for select to authenticated using (true);
drop policy if exists "note_ratings_insert_own" on public.note_ratings;
create policy "note_ratings_insert_own" on public.note_ratings
    for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "note_ratings_update_own" on public.note_ratings;
create policy "note_ratings_update_own" on public.note_ratings
    for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "note_ratings_delete_own" on public.note_ratings;
create policy "note_ratings_delete_own" on public.note_ratings
    for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 4. note_details — one view the Notes page reads from: the resource, its
--    uploader's name/role/institution, and live save/rating aggregates.
--    security_invoker = true means it still obeys the RLS above for the
--    *resource* row itself (pending notes stay hidden from everyone but
--    their owner and admins); the join to note_saves/note_ratings is
--    globally readable by design (see policies above), so counts are
--    accurate for everyone.
-- ---------------------------------------------------------------------------
create or replace view public.note_details
with (security_invoker = true) as
select
    r.id, r.title, r.description, r.subject, r.class_level, r.chapter, r.tags,
    r.note_type, r.content_text, r.external_url, r.file_path,
    r.allow_download, r.status, r.views_count, r.downloads_count,
    r.uploaded_by, r.created_at,
    p.full_name  as uploader_name,
    p.role       as uploader_role,
    i.name       as institution_name,
    coalesce(rt.avg_rating, 0)   as avg_rating,
    coalesce(rt.rating_count, 0) as rating_count,
    coalesce(sv.save_count, 0)   as save_count,
    r.image_urls
from public.resources r
left join public.profiles p on p.user_id = r.uploaded_by
left join public.institutions i on i.id = p.institution_id
left join (
    select resource_id, avg(rating)::numeric(2,1) as avg_rating, count(*) as rating_count
    from public.note_ratings group by resource_id
) rt on rt.resource_id = r.id
left join (
    select resource_id, count(*) as save_count
    from public.note_saves group by resource_id
) sv on sv.resource_id = r.id;

grant select on public.note_details to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Counters that need to bump regardless of who's looking (a student
--    viewing/downloading someone else's note isn't the owner, so a plain
--    UPDATE would be blocked by resources_update_own above). A narrow
--    SECURITY DEFINER function is the standard, safe way to allow just
--    this one counter increment without opening the row up generally.
-- ---------------------------------------------------------------------------
create or replace function public.increment_resource_views(p_resource_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.resources set views_count = views_count + 1 where id = p_resource_id;
end;
$$;
grant execute on function public.increment_resource_views(uuid) to authenticated;

create or replace function public.increment_resource_downloads(p_resource_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.resources set downloads_count = downloads_count + 1 where id = p_resource_id;
end;
$$;
grant execute on function public.increment_resource_downloads(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Storage bucket for uploaded note images/files. Public read (so a
--    <img src> or download link just works), folder-per-user write, same
--    convention as the existing avatars/community-uploads buckets.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('notes-uploads', 'notes-uploads', true, 26214400, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "notes_uploads_read_all" on storage.objects;
create policy "notes_uploads_read_all" on storage.objects
    for select to anon, authenticated
    using (bucket_id = 'notes-uploads');

drop policy if exists "notes_uploads_insert_own_folder" on storage.objects;
create policy "notes_uploads_insert_own_folder" on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'notes-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

drop policy if exists "notes_uploads_delete_own" on storage.objects;
create policy "notes_uploads_delete_own" on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'notes-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
    );
