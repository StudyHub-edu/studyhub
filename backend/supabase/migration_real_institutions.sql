-- ============================================================================
-- StudyHub — real institutions from collegenp.com/colleges and /schools
-- Run this once in the SQL Editor. Safe to re-run — duplicates are skipped
-- by the existing unique index on (lower(name), lower(city)).
-- ============================================================================

insert into public.institutions (name, type, city) values
    -- Colleges
    ('Certified College of Accountancy (CCA)',        'college', 'Kathmandu'),
    ('ISMT College',                                   'college', 'Kathmandu'),
    ('ISMT College Biratnagar',                        'college', 'Biratnagar'),
    ('ISMT College Butwal',                            'college', 'Butwal'),
    ('ISMT College Chitwan',                           'college', 'Bharatpur'),
    ('ISMT College Pokhara',                           'college', 'Pokhara'),
    ('Kathmandu Model College (KMC)',                  'college', 'Kathmandu'),
    ('KMC Lalitpur',                                   'college', 'Lalitpur'),
    ('Model Institute of Technology (MIT)',            'college', 'Kathmandu'),
    ('Padmashree College',                             'college', 'Kathmandu'),
    ('Stamford College Kathmandu',                     'college', 'Kathmandu'),
    ('The British College',                            'college', 'Kathmandu'),
    ('The London College',                             'college', 'Kathmandu'),
    ('United Academy',                                 'college', 'Lalitpur'),
    ('Aadikavi Bhanubhakta Campus',                    'college', 'Tanahun'),
    ('Achham Multiple Campus',                         'college', 'Achham'),
    ('Advance Academy and Republica College',          'college', 'Lalitpur'),
    ('Alka Institute of Medical Sciences',             'college', 'Lalitpur'),
    ('Amrit Science Campus (ASCOL)',                   'college', 'Kathmandu'),

    -- Schools
    ('Adarsha Secondary School',                       'school', 'Ilam'),
    ('Badimalika Secondary School',                    'school', 'Kalikot'),
    ('Bal Uddhar Secondary School',                    'school', 'Kathmandu'),
    ('Budhanilkantha Secondary School',                'school', 'Kathmandu'),
    ('Dapcha Secondary School',                        'school', 'Kavre'),
    ('Durbar High School',                             'school', 'Kathmandu'),
    ('Gyanodaya Secondary School',                     'school', 'Kathmandu'),
    ('Kalika Manavgyan Secondary School',              'school', 'Butwal'),
    ('Kanti Secondary School',                         'school', 'Rupandehi'),
    ('Khalangatar Secondary School',                   'school', 'Panchthar'),
    ('Paropakar Adarsha Secondary School',             'school', 'Kathmandu'),
    ('Peak Point Public School',                       'school', 'Kathmandu'),
    ('Rajeshwor Nidhi Secondary School',                'school', 'Dhanusa'),
    ('Sainik Awasiya Mahavidyalaya Bhaktapur',          'school', 'Bhaktapur'),
    ('Sainik Awasiya Mahavidyalaya Surkhet',            'school', 'Surkhet'),
    ('Sharada Secondary School',                        'school', 'Kathmandu'),
    ('Bhagawati Secondary School',                      'school', 'Terhathum'),
    ('3Angels International Mission School',            'school', 'Pokhara'),
    ('A1 Quality Secondary School',                      'school', 'Biratnagar'),
    ('Aadarsha Secondary English Boarding School',       'school', 'Biratnagar')
on conflict do nothing;

-- Source: https://www.collegenp.com/colleges and https://www.collegenp.com/schools
-- This is a starting sample, not the full national directory — the "Other /
-- not listed" option in the institution picker still covers anyone whose
-- school or college isn't in this list yet. Add more rows here any time by
-- copying the pattern above.
