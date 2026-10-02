-- ============================================================================
-- StudyHub — Map / location schema
-- Extends the existing public.institutions table (supabase/schema.sql).
-- Run after schema.sql.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Widen the institution type list — the Map page needs "library" and
--    "institute" (coaching centers) alongside the existing school/college/
--    university/other, so the check constraint has to be recreated.
-- ---------------------------------------------------------------------------
alter table public.institutions drop constraint if exists institutions_type_check;
alter table public.institutions
  add constraint institutions_type_check
  check (type in ('school', 'college', 'university', 'library', 'institute', 'other'));

-- ---------------------------------------------------------------------------
-- 2. Location + display fields the Map page needs. All nullable — an
--    institution with no coordinates yet simply won't plot on the map, it
--    still shows up everywhere else (admin dashboard, registration, etc).
-- ---------------------------------------------------------------------------
alter table public.institutions
  add column if not exists latitude       double precision,
  add column if not exists longitude      double precision,
  add column if not exists address        text,
  add column if not exists facilities     text[] not null default '{}',
  add column if not exists cover_photo_url text;

create index if not exists institutions_coords_idx
  on public.institutions (latitude, longitude)
  where latitude is not null and longitude is not null;

-- ---------------------------------------------------------------------------
-- 3. Saved locations — "Save" quick action on the Map page. Per-user, so a
--    student can bookmark the institutions they care about.
-- ---------------------------------------------------------------------------
create table if not exists public.saved_institutions (
    id             uuid primary key default gen_random_uuid(),
    user_id        uuid not null references public.profiles(user_id) on delete cascade,
    institution_id uuid not null references public.institutions(id) on delete cascade,
    created_at     timestamptz not null default now(),
    unique (user_id, institution_id)
);

alter table public.saved_institutions enable row level security;
revoke all on public.saved_institutions from anon, authenticated;
grant select, insert, delete on public.saved_institutions to authenticated;

drop policy if exists "saved_institutions_own" on public.saved_institutions;
create policy "saved_institutions_own" on public.saved_institutions
    for all to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
