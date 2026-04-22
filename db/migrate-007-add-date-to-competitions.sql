-- Migration: Add date column to competitions table
-- Date: 2026-04-22

ALTER TABLE competitions ADD COLUMN date DATE;
