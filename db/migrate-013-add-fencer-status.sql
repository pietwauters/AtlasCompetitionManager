-- Migration: Add status column to Fencer table
ALTER TABLE Fencers ADD COLUMN status TEXT DEFAULT 'active';
