-- Migration: Add initial_seed column to Fencer table
ALTER TABLE Fencers ADD COLUMN initial_seed INTEGER;
