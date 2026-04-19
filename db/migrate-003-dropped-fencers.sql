-- Migration: Add dropped_fencers column to phases table for block-seeding tracking
ALTER TABLE phases ADD COLUMN dropped_fencers TEXT;