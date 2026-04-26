-- Migration: Add final_rank column to competitors
-- Date: 2026-04-24
ALTER TABLE competitors ADD COLUMN final_rank INTEGER;
