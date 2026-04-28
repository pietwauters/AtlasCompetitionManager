-- Migration: Add gender column to People table
-- Date: 2026-04-28

ALTER TABLE People ADD COLUMN gender TEXT;
