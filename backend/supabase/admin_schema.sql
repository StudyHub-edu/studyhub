-- ============================================================================
-- StudyHub — Admin dashboard
-- Run ONCE in: Supabase Dashboard -> SQL Editor -> New query
--
-- Run it AFTER everything else (schema.sql, dashboard_schema.sql,
-- migration_phone_signup.sql, migration_profile_and_identity.sql,
-- migration_map_and_feed.sql). Safe to re-run.
--
-- What this does
--   1. Makes ONE fixed admin account: teamofstudyhub@gmail.com
--      Nobody else can ever get role = 'admin', from the browser or otherwise.
--   2. Lets that admin (and only that admin) read the data the dashboard shows.
--   3. Adds the few tables the dashboard needs that don't exist yet.
--   4. Adds review_identity(): the Approve / Reject button on the dashboard.
--
-- The admin's PASSWORD is not in this file (and not in any front-end file).
-- Passwords live only, hashed, inside Supabase Auth. See the README for how to
-- set it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. Helper: the admin check used by every policy below.
--    (Already created by migration_profile_and_identity.sql; re-declared here
--    so this file also works on its own.)
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
-- 1. THE FIXED ADMIN
--    a) new sign-ups with this email get role 'admin' automatically;
--    b) a trigger refuses 'admin' for any other account, forever.
-- ---------------------------------------------------------------------------

-- 1a. Same as the phone-signup version of handle_new_user(), plus one rule:
--     the owner's email becomes the admin. Everyone else is still clamped to
--     student / teacher.
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
    v_owner boolean;
begin
    v_owner := lower(coalesce(new.email, '')) = 'teamofstudyhub@gmail.com';

    v_role := lower(coalesce(new.raw_user_meta_data ->> 'role', 'student'));
    if v_owner then
        v_role := 'admin';
    elsif v_role not in ('student', 'teacher') then
        v_role := 'student';
    end if;

    begin
        v_inst := nullif(new.raw_user_meta_data ->> 'institution_id', '')::uuid;
    exception when others then
        v_inst := null;
    end;

    v_class := nullif(new.raw_user_meta_data ->> 'class_level', '');
    v_name  := coalesce(
                   nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
                   case when v_owner then 'StudyHub Admin' else 'StudyHub member' end
               );

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

-- 1b. The lock. Runs on every insert/update of a profile.
--     - Only the owner's account may hold role 'admin'.
--     - The owner's role can't be changed away by a normal request. (The SQL
--       editor can still do it on purpose by turning on the bypass flag.)
create or replace function public.profiles_enforce_single_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_email text;
begin
    if new.role = 'admin' then
        select lower(email) into v_email from auth.users where id = new.user_id;
        if v_email is distinct from 'teamofstudyhub@gmail.com' then
            raise exception 'Only the StudyHub owner account can be an admin.';
        end if;
    end if;

    if tg_op = 'UPDATE'
       and old.role = 'admin'
       and new.role is distinct from old.role
       and coalesce(current_setting('studyhub.bypass_profile_guard', true), 'off') <> 'on' then
        raise exception 'The admin role cannot be removed from the owner account.';
    end if;

    return new;
end;
$$;

drop trigger if exists profiles_enforce_single_admin on public.profiles;
create trigger profiles_enforce_single_admin
    before insert or update on public.profiles
    for each row execute function public.profiles_enforce_single_admin();
-- (Named so it fires before the existing "profiles_guard" trigger.)


-- ---------------------------------------------------------------------------
-- 2. Extra column on institutions (for "New institution requests")
-- ---------------------------------------------------------------------------
alter table public.institutions
    add column if not exists verification_status text not null default 'verified'
    check (verification_status in ('pending', 'verified', 'rejected'));


-- ---------------------------------------------------------------------------
-- 3. Let the admin read what the dashboard shows
--    (students and teachers still see only what they saw before)
-- ---------------------------------------------------------------------------
drop policy if exists "profiles_select_admin" on public.profiles;
create policy "profiles_select_admin"
    on public.profiles
    for select
    to authenticated
    using (public.is_admin());

-- library_books normally shows only published rows; the admin sees drafts too.
drop policy if exists "library_books_select_admin" on public.library_books;
create policy "library_books_select_admin"
    on public.library_books
    for select
    to authenticated
    using (public.is_admin());


-- ---------------------------------------------------------------------------
-- 4. New tables
--    Foreign keys point at profiles(user_id) so the dashboard can join names.
-- ---------------------------------------------------------------------------

-- 4a. Resources (notes, sheets, papers) uploaded by teachers / students
create table if not exists public.resources (
    id          uuid primary key default gen_random_uuid(),
    title       text not null,
    uploaded_by uuid references public.profiles(user_id) on delete set null,
    subject     text,
    class_level text,
    rating      numeric(2,1) check (rating between 0 and 5),
    file_path   text,
    status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    created_at  timestamptz not null default now()
);
create index if not exists resources_status_idx on public.resources (status, created_at desc);

-- 4b. Payments
create table if not exists public.payments (
    id           uuid primary key default gen_random_uuid(),
    txn_code     text unique,
    student_id   uuid references public.profiles(user_id) on delete set null,
    content_type text not null check (content_type in ('ebook', 'course', 'resource')),
    amount       numeric not null default 0,
    status       text not null default 'pending' check (status in ('success', 'pending', 'failed')),
    created_at   timestamptz not null default now()
);
create index if not exists payments_created_idx on public.payments (created_at desc);

-- 4c. Reports (people flagging users / content)
create table if not exists public.reports (
    id          uuid primary key default gen_random_uuid(),
    reporter_id uuid references public.profiles(user_id) on delete set null,
    category    text not null check (category in ('user', 'content', 'teacher', 'copyright', 'other')),
    details     text,
    status      text not null default 'open' check (status in ('open', 'resolved')),
    created_at  timestamptz not null default now()
);
create index if not exists reports_status_idx on public.reports (status, category);

-- 4d. Activity feed shown on the dashboard. Written only by the database
--     itself (functions below), never by the browser.
create table if not exists public.activity_log (
    id         uuid primary key default gen_random_uuid(),
    kind       text not null,
    title      text not null,
    detail     text,
    created_at timestamptz not null default now()
);
create index if not exists activity_log_created_idx on public.activity_log (created_at desc);

-- 4e. Sign-ins and account changes for the admin's "Security Activity" card
create table if not exists public.security_events (
    id         uuid primary key default gen_random_uuid(),
    user_id    uuid not null references public.profiles(user_id) on delete cascade,
    title      text not null,
    location   text,
    device     text,
    status     text not null default 'success' check (status in ('success', 'failed')),
    created_at timestamptz not null default now()
);
create index if not exists security_events_user_idx on public.security_events (user_id, created_at desc);


-- ---------------------------------------------------------------------------
-- 5. Row Level Security for the new tables
--    Pattern: admin can do everything; everyone else gets only the narrow
--    access listed. Anything not listed is denied.
-- ---------------------------------------------------------------------------
alter table public.resources       enable row level security;
alter table public.payments        enable row level security;
alter table public.reports         enable row level security;
alter table public.activity_log    enable row level security;
alter table public.security_events enable row level security;

revoke all on public.resources, public.payments, public.reports,
              public.activity_log, public.security_events
    from anon, authenticated;

grant select, insert, update, delete on public.resources, public.payments, public.reports
    to authenticated;
grant select on public.activity_log to authenticated;
grant select, insert on public.security_events to authenticated;

-- resources
drop policy if exists "resources_admin_all" on public.resources;
create policy "resources_admin_all" on public.resources
    for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "resources_select_approved" on public.resources;
create policy "resources_select_approved" on public.resources
    for select to authenticated using (status = 'approved');

-- payments
drop policy if exists "payments_admin_all" on public.payments;
create policy "payments_admin_all" on public.payments
    for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "payments_select_own" on public.payments;
create policy "payments_select_own" on public.payments
    for select to authenticated using (auth.uid() = student_id);

-- reports
drop policy if exists "reports_admin_all" on public.reports;
create policy "reports_admin_all" on public.reports
    for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "reports_insert_own" on public.reports;
create policy "reports_insert_own" on public.reports
    for insert to authenticated with check (auth.uid() = reporter_id and status = 'open');

-- activity_log: admin reads. Inserts happen only inside SECURITY DEFINER code.
drop policy if exists "activity_log_admin_select" on public.activity_log;
create policy "activity_log_admin_select" on public.activity_log
    for select to authenticated using (public.is_admin());

-- security_events: each person sees and writes only their own
drop policy if exists "security_events_select_own" on public.security_events;
create policy "security_events_select_own" on public.security_events
    for select to authenticated using (auth.uid() = user_id);
drop policy if exists "security_events_insert_own" on public.security_events;
create policy "security_events_insert_own" on public.security_events
    for insert to authenticated with check (auth.uid() = user_id and status = 'success');


-- ---------------------------------------------------------------------------
-- 6. Per-institution totals for the "Schools & Colleges" card
--    security_invoker = the view obeys the caller's RLS, so only the admin
--    ever sees real counts.
-- ---------------------------------------------------------------------------
create or replace view public.institution_stats
with (security_invoker = true) as
select
    i.id,
    i.name,
    i.type,
    i.city,
    i.verification_status,
    i.created_at,
    (count(*) filter (where p.role = 'student'))::int as student_count,
    (count(*) filter (where p.role = 'teacher'))::int as teacher_count
from public.institutions i
left join public.profiles p on p.institution_id = i.id
group by i.id;

grant select on public.institution_stats to authenticated;


-- ---------------------------------------------------------------------------
-- 7. Approve / Reject an ID check
--    The existing sync trigger on identity_verifications then updates the
--    person's profile (identity_status) for us.
-- ---------------------------------------------------------------------------
create or replace function public.review_identity(
    p_id      uuid,
    p_approve boolean,
    p_note    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v      public.identity_verifications%rowtype;
    v_name text;
begin
    if not public.is_admin() then
        raise exception 'Only the admin can review identity checks.';
    end if;

    update public.identity_verifications
       set status      = case when p_approve then 'verified' else 'rejected' end,
           reviewed_by = auth.uid(),
           reviewed_at = now(),
           review_note = p_note
     where id = p_id
       and status = 'pending'
    returning * into v;

    if not found then
        raise exception 'That request was not found or has already been reviewed.';
    end if;

    select full_name into v_name from public.profiles where user_id = v.user_id;

    insert into public.activity_log (kind, title, detail)
    values (
        case when p_approve then 'teacher_verified' else 'teacher_rejected' end,
        case
            when v.role_at_submission = 'teacher' and p_approve     then 'Teacher verified'
            when v.role_at_submission = 'teacher'                   then 'Teacher rejected'
            when p_approve                                          then 'Student verified'
            else                                                         'Student rejected'
        end,
        v_name
    );
end;
$$;

revoke execute on function public.review_identity(uuid, boolean, text) from public, anon;
grant  execute on function public.review_identity(uuid, boolean, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Feed the activity log when someone signs up
-- ---------------------------------------------------------------------------
create or replace function public.log_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.role in ('student', 'teacher') then
        insert into public.activity_log (kind, title, detail)
        values ('user_created', initcap(new.role) || ' account created', new.full_name);
    end if;
    return new;
end;
$$;

drop trigger if exists profiles_log_signup on public.profiles;
create trigger profiles_log_signup
    after insert on public.profiles
    for each row execute function public.log_new_profile();


-- ---------------------------------------------------------------------------
-- 9. Make the owner account the admin (if it already exists)
--
--    First create the account — see the README, "Admin account". This block
--    then upgrades it, marks the email as confirmed, and can be re-run any
--    time. If the account doesn't exist yet it just prints a reminder.
-- ---------------------------------------------------------------------------
do $$
declare
    v_uid uuid;
begin
    select id into v_uid from auth.users where lower(email) = 'teamofstudyhub@gmail.com';

    if v_uid is null then
        raise notice 'Admin account not found yet. Create teamofstudyhub@gmail.com first (README, "Admin account"), then run this file again.';
        return;
    end if;

    -- Transfer the single-admin role instead of leaving the previous owner
    -- account privileged after the configured admin address changes.
    perform set_config('studyhub.bypass_profile_guard', 'on', true);
    update public.profiles
       set role = 'student',
           updated_at = now()
     where role = 'admin'
       and user_id <> v_uid;

    -- the owner is trusted: no need to wait for an email code
    update auth.users
       set email_confirmed_at = coalesce(email_confirmed_at, now())
     where id = v_uid;

    insert into public.profiles (user_id, full_name, role, verification_status)
    values (v_uid, 'StudyHub Admin', 'admin', 'verified')
    on conflict (user_id) do update
        set role = 'admin',
            verification_status = 'verified',
            updated_at = now();

    perform set_config('studyhub.bypass_profile_guard', 'off', true);

    raise notice 'Done. teamofstudyhub@gmail.com is now the StudyHub admin.';
end $$;
