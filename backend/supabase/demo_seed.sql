-- ============================================================================
-- StudyHub — demo seed data
-- Run AFTER dashboard_schema.sql, in the SQL Editor.
--
-- Part A (library_books, questions) is public data — it will show up on
-- EVERY student's dashboard immediately, no changes needed.
--
-- Part B (learning_progress, calendar_events, recently_viewed) is personal
-- data tied to one student. Replace the email below with the test account
-- you actually log in as, then run Part B.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PART A — public data (safe to run as-is)
-- ---------------------------------------------------------------------------

insert into public.library_books (title, subtitle, author, category, price_type, class_level) values
    ('Physics', 'Concepts & Applications', 'H.C. Verma',   'Physics',          'free', 'Grade 11'),
    ('Mathematics', 'Class 11',            'R.D. Sharma',  'Mathematics',      'free', 'Grade 11'),
    ('Chemistry', 'Part 1',                'O.P. Tandon',  'Chemistry',        'free', 'Grade 11'),
    ('Computer Science with Python', null, 'Sumita Arora', 'Computer Science', 'free', 'Grade 11')
on conflict do nothing;

insert into public.questions (title, subject, class_level, answer_count) values
    ('Can someone explain this Physics problem?', 'Physics',     'Grade 11', 12),
    ('Need help with Integration',                'Mathematics', 'Grade 11', 8),
    ('Grade 11 Chemistry — Mole Concept',          'Chemistry',   'Grade 11', 15)
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- PART B — personal demo data for ONE test student
-- Replace 'your-test-account@example.com' with the email you log in with,
-- then run this block.
-- ---------------------------------------------------------------------------

do $$
declare
    v_user_id uuid;
begin
    select id into v_user_id
    from auth.users
    where email = 'aayushfourth@gmail.com';  

    if v_user_id is null then
        raise notice 'No auth user found with that email — Part B skipped. Update the email above and re-run.';
        return;
    end if;

    insert into public.learning_progress (user_id, subject, topic, chapter, progress_percent) values
        (v_user_id, 'Physics',          'Motion',       'Chapter 2', 65),
        (v_user_id, 'Mathematics',      'Trigonometry', 'Chapter 4', 40),
        (v_user_id, 'Chemistry',        'Atomic Structure', 'Chapter 3', 20),
        (v_user_id, 'Computer Science', 'Python Basics', 'Chapter 1', 50);

    insert into public.calendar_events (user_id, title, event_type, event_date, event_time) values
        (v_user_id, 'Physics Test',                 'test',       current_date + 1, '9:00 AM'),
        (v_user_id, 'Computer Science Assignment',  'assignment', current_date + 3, '11:59 PM'),
        (v_user_id, 'College Program',              'program',    current_date + 5, '10:00 AM');

    insert into public.recently_viewed (user_id, resource_type, resource_title, viewed_at) values
        (v_user_id, 'Notes',     'Physics — Motion',    now() - interval '2 hours'),
        (v_user_id, 'Books',     'H.C. Verma',           now() - interval '5 hours'),
        (v_user_id, 'Questions', 'Integration Problem',  now() - interval '1 day'),
        (v_user_id, 'Videos',    'Newton''s Laws',       now() - interval '1 day');

    raise notice 'Seeded demo data for user %', v_user_id;
end $$;
