-- ============================================================================
-- StudyHub — shared past papers
-- Run after schema.sql and map_schema.sql in Supabase SQL Editor.
-- Uploaded question-paper images are private in Storage and available to authenticated users.
-- ============================================================================

create table if not exists public.past_papers (
    id                  uuid primary key default gen_random_uuid(),
    title               text not null check (char_length(title) between 3 and 140),
    exam_name           text not null check (char_length(exam_name) between 2 and 80),
    education_level     text not null check (char_length(education_level) between 2 and 60),
    subject             text not null check (char_length(subject) between 2 and 80),
    exam_year           integer not null check (exam_year between 1900 and 2100),
    institution_name    text not null check (char_length(institution_name) between 2 and 160),
    description         text not null default '' check (char_length(description) <= 500),
    uploader_name       text,
    file_path           text not null unique,
    image_paths         text[] not null default '{}',
    uploaded_by         uuid not null references public.profiles(user_id) on delete cascade,
    created_at          timestamptz not null default now()
);

alter table public.past_papers add column if not exists uploader_name text;
alter table public.past_papers add column if not exists image_paths text[] not null default '{}';

create table if not exists public.past_paper_saves (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references public.profiles(user_id) on delete cascade,
    paper_id    uuid not null references public.past_papers(id) on delete cascade,
    created_at  timestamptz not null default now(),
    unique (user_id, paper_id)
);

create table if not exists public.past_paper_ratings (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references public.profiles(user_id) on delete cascade,
    paper_id    uuid not null references public.past_papers(id) on delete cascade,
    rating      int not null check (rating between 1 and 5),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    unique (user_id, paper_id)
);

create index if not exists past_papers_created_at_idx
    on public.past_papers (created_at desc);
create index if not exists past_papers_filters_idx
    on public.past_papers (education_level, exam_name, institution_name, exam_year);
create index if not exists past_paper_saves_user_idx on public.past_paper_saves (user_id);
create index if not exists past_paper_ratings_paper_idx on public.past_paper_ratings (paper_id);

alter table public.past_papers enable row level security;
alter table public.past_paper_saves enable row level security;
alter table public.past_paper_ratings enable row level security;
revoke all on public.past_papers from anon, authenticated;
revoke all on public.past_paper_saves, public.past_paper_ratings from anon, authenticated;
grant select, insert, delete on public.past_papers to authenticated;
grant select, insert, delete on public.past_paper_saves to authenticated;
grant select, insert, update, delete on public.past_paper_ratings to authenticated;

drop policy if exists "past_paper_saves_select_own" on public.past_paper_saves;
create policy "past_paper_saves_select_own" on public.past_paper_saves
    for select to authenticated using (auth.uid() = user_id);
drop policy if exists "past_paper_saves_insert_own" on public.past_paper_saves;
create policy "past_paper_saves_insert_own" on public.past_paper_saves
    for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "past_paper_saves_delete_own" on public.past_paper_saves;
create policy "past_paper_saves_delete_own" on public.past_paper_saves
    for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "past_paper_ratings_select_all" on public.past_paper_ratings;
create policy "past_paper_ratings_select_all" on public.past_paper_ratings
    for select to authenticated using (true);
drop policy if exists "past_paper_ratings_insert_own" on public.past_paper_ratings;
create policy "past_paper_ratings_insert_own" on public.past_paper_ratings
    for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "past_paper_ratings_update_own" on public.past_paper_ratings;
create policy "past_paper_ratings_update_own" on public.past_paper_ratings
    for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "past_paper_ratings_delete_own" on public.past_paper_ratings;
create policy "past_paper_ratings_delete_own" on public.past_paper_ratings
    for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "past_papers_read_authenticated" on public.past_papers;
create policy "past_papers_read_authenticated"
    on public.past_papers for select to authenticated
    using (true);

drop policy if exists "past_papers_upload_own" on public.past_papers;
create policy "past_papers_upload_own"
    on public.past_papers for insert to authenticated
    with check (
        auth.uid() = uploaded_by
        and exists (
            select 1 from public.profiles p
            where p.user_id = auth.uid()
              and p.role in ('student', 'teacher', 'admin')
        )
    );

drop policy if exists "past_papers_delete_own" on public.past_papers;
create policy "past_papers_delete_own"
    on public.past_papers for delete to authenticated
    using (auth.uid() = uploaded_by);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('past-papers', 'past-papers', false, 26214400, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "past_papers_storage_read" on storage.objects;
create policy "past_papers_storage_read"
    on storage.objects for select to authenticated
    using (
        bucket_id = 'past-papers'
        and exists (
            select 1 from public.past_papers p
            where p.file_path = storage.objects.name
               or storage.objects.name = any(p.image_paths)
        )
    );

drop policy if exists "past_papers_storage_upload_own" on storage.objects;
create policy "past_papers_storage_upload_own"
    on storage.objects for insert to authenticated
    with check (
        bucket_id = 'past-papers'
        and (storage.foldername(name))[1] = auth.uid()::text
        and exists (
            select 1 from public.profiles p
            where p.user_id = auth.uid()
              and p.role in ('student', 'teacher', 'admin')
        )
    );

drop policy if exists "past_papers_storage_delete_own" on storage.objects;
create policy "past_papers_storage_delete_own"
    on storage.objects for delete to authenticated
    using (
        bucket_id = 'past-papers'
        and (storage.foldername(name))[1] = auth.uid()::text
    );
