-- Migration: Add missing columns to Fencer and Person tables
ALTER TABLE Fencers ADD COLUMN weapons TEXT;
ALTER TABLE Fencers ADD COLUMN licence TEXT;
ALTER TABLE Fencers ADD COLUMN handedness TEXT;
ALTER TABLE Fencers ADD COLUMN final_rank INTEGER;
-- Gender belongs to Person, not Fencer
ALTER TABLE People ADD COLUMN gender TEXT;
