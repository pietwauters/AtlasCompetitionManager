-- Migration: Add advancement_choice column to phases table
ALTER TABLE phases ADD COLUMN advancement_choice TEXT;