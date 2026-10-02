-- ============================================================================
-- StudyHub — retain OCR text for ID verification reviews
-- Run once in Supabase SQL Editor after migration_profile_and_identity.sql.
-- Safe to re-run.
-- ============================================================================

alter table public.identity_verifications
    add column if not exists extracted_text text;
