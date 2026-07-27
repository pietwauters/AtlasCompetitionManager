-- Track a referee-double-booking-driven push on a pipeline slot, so that a
-- later change which removes the conflict can prompt to restore the slot's
-- original scheduled_start (see opp2.html's conflict-resolution flow).
-- All three are null on every slot until a conflict push actually happens,
-- and are cleared again once resolved (restored or dismissed).
ALTER TABLE pipeline_slots ADD COLUMN conflict_referee_id     INTEGER REFERENCES referees(id)       ON DELETE SET NULL;
ALTER TABLE pipeline_slots ADD COLUMN conflict_original_start TEXT;
ALTER TABLE pipeline_slots ADD COLUMN conflict_paired_slot_id INTEGER REFERENCES pipeline_slots(id) ON DELETE SET NULL;
