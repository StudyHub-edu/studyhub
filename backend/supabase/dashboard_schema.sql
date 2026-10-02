-- ============================================================================
-- StudyHub — Student Homepage data tables
-- Run once in: Supabase Dashboard -> SQL Editor -> New query
-- These are the tables js/dashboard.js already queries. Creating them here
-- is what makes Continue Learning / Library / Upcoming / Questions /
-- Recently Viewed switch from their empty states to real data.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. LEARNING PROGRESS (personal — one row per subject/topic a student has
--    started; "Continue Learning" reads the 4 most recently updated)
-- ---------------------------------------------------------------------------
create table if not exists public.learning_progress (
    id               uuid primary key default gen_random_uuid(),
    user_id          uuid not null references auth.users(id) on delete cascade,
    subject          text not null,
    topic            text,
    chapter          text,
    progress_percent int not null default 0 check (progress_percent between 0 and 100),
    resource_type    text,
    resource_id      uuid,
    updated_at       timestamptz not null default now()
);
create index if not exists learning_progress_user_idx on public.learning_progress (user_id, updated_at desc);

alter table public.learning_progress enable row level security;

drop policy if exists "learning_progress_select_own" on public.learning_progress;
create policy "learning_progress_select_own" on public.learning_progress
    for select to authenticated using (auth.uid() = user_id);

drop policy if exists "learning_progress_upsert_own" on public.learning_progress;
create policy "learning_progress_upsert_own" on public.learning_progress
    for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "learning_progress_update_own" on public.learning_progress;
create policy "learning_progress_update_own" on public.learning_progress
    for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 2. LIBRARY BOOKS (public reference data — every student can browse;
--    only "is_published" rows show, optionally filtered by class_level)
-- ---------------------------------------------------------------------------
create table if not exists public.library_books (
    id           uuid primary key default gen_random_uuid(),
    title        text not null,
    subtitle     text,
    author       text,
    category     text,
    price_type   text not null default 'free' check (price_type in ('free', 'paid')),
    class_level  text,
    language     text default 'English',
    is_published boolean not null default true,
    created_at   timestamptz not null default now()
);

alter table public.library_books enable row level security;

drop policy if exists "library_books_select_published" on public.library_books;
create policy "library_books_select_published" on public.library_books
    for select to anon, authenticated using (is_published = true);

revoke insert, update, delete on public.library_books from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. CALENDAR EVENTS (personal — exams, assignments, programs a student added)
-- ---------------------------------------------------------------------------
create table if not exists public.calendar_events (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references auth.users(id) on delete cascade,
    title      text not null,
    event_type text not null default 'event'
               check (event_type in ('exam', 'test', 'assignment', 'program', 'event')),
    event_date date not null,
    event_time text,
    created_at timestamptz not null default now()
);
create index if not exists calendar_events_user_idx on public.calendar_events (user_id, event_date);

alter table public.calendar_events enable row level security;

drop policy if exists "calendar_events_select_own" on public.calendar_events;
create policy "calendar_events_select_own" on public.calendar_events
    for select to authenticated using (auth.uid() = user_id);

drop policy if exists "calendar_events_insert_own" on public.calendar_events;
create policy "calendar_events_insert_own" on public.calendar_events
    for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "calendar_events_update_own" on public.calendar_events;
create policy "calendar_events_update_own" on public.calendar_events
    for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "calendar_events_delete_own" on public.calendar_events;
create policy "calendar_events_delete_own" on public.calendar_events
    for delete to authenticated using (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 4. QUESTIONS (community — visible to everyone, like institutions/books)
-- ---------------------------------------------------------------------------
create table if not exists public.questions (
    id           uuid primary key default gen_random_uuid(),
    author_id    uuid references auth.users(id) on delete set null,
    title        text not null,
    subject      text,
    class_level  text,
    answer_count int not null default 0,
    created_at   timestamptz not null default now()
);
create index if not exists questions_created_idx on public.questions (created_at desc);

alter table public.questions enable row level security;

drop policy if exists "questions_select_all" on public.questions;
create policy "questions_select_all" on public.questions
    for select to anon, authenticated using (true);

drop policy if exists "questions_insert_own" on public.questions;
create policy "questions_insert_own" on public.questions
    for insert to authenticated with check (auth.uid() = author_id);


-- ---------------------------------------------------------------------------
-- 5. RECENTLY VIEWED (personal — lightweight view-history log)
-- ---------------------------------------------------------------------------
create table if not exists public.recently_viewed (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid not null references auth.users(id) on delete cascade,
    resource_type  text not null,
    resource_title text not null,
    resource_id    uuid,
    viewed_at      timestamptz not null default now()
);
create index if not exists recently_viewed_user_idx on public.recently_viewed (user_id, viewed_at desc);

alter table public.recently_viewed enable row level security;

drop policy if exists "recently_viewed_select_own" on public.recently_viewed;
create policy "recently_viewed_select_own" on public.recently_viewed
    for select to authenticated using (auth.uid() = user_id);

drop policy if exists "recently_viewed_insert_own" on public.recently_viewed;
create policy "recently_viewed_insert_own" on public.recently_viewed
    for insert to authenticated with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 6. NOTIFICATIONS (personal — powers the header bell's unread dot)
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references auth.users(id) on delete cascade,
    message    text not null,
    type       text default 'general',
    is_read    boolean not null default false,
    created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, is_read);

alter table public.notifications enable row level security;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
    for select to authenticated using (auth.uid() = user_id);

drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications
    for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
