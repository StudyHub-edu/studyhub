-- ============================================================================
-- StudyHub — AI Teacher chat history + private image uploads
-- Run in: Supabase Dashboard -> SQL Editor, after the earlier migrations.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Chat history (personal — each student only ever sees their own thread)
-- ---------------------------------------------------------------------------
create table if not exists public.ai_chat_messages (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references auth.users(id) on delete cascade,
    role       text not null check (role in ('user', 'assistant')),
    content    text not null default '',
    image_path text,           -- path inside the ai-teacher-uploads bucket, not a public URL
    created_at timestamptz not null default now()
);
create index if not exists ai_chat_messages_user_idx on public.ai_chat_messages (user_id, created_at);

alter table public.ai_chat_messages enable row level security;

drop policy if exists "ai_chat_select_own" on public.ai_chat_messages;
create policy "ai_chat_select_own" on public.ai_chat_messages
    for select to authenticated using (auth.uid() = user_id);

drop policy if exists "ai_chat_insert_own" on public.ai_chat_messages;
create policy "ai_chat_insert_own" on public.ai_chat_messages
    for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "ai_chat_delete_own" on public.ai_chat_messages;
create policy "ai_chat_delete_own" on public.ai_chat_messages
    for delete to authenticated using (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- 2. STORAGE — private bucket for homework photos sent to AI Teacher
--    Unlike community-uploads (public), this is a student's own question
--    photo — private by default, readable only by that student.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('ai-teacher-uploads', 'ai-teacher-uploads', false)
on conflict (id) do nothing;

drop policy if exists "ai_uploads_select_own" on storage.objects;
create policy "ai_uploads_select_own" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'ai-teacher-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

drop policy if exists "ai_uploads_insert_own" on storage.objects;
create policy "ai_uploads_insert_own" on storage.objects
    for insert to authenticated
    with check (
        bucket_id = 'ai-teacher-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

drop policy if exists "ai_uploads_delete_own" on storage.objects;
create policy "ai_uploads_delete_own" on storage.objects
    for delete to authenticated
    using (
        bucket_id = 'ai-teacher-uploads'
        and (storage.foldername(name))[1] = auth.uid()::text
    );
