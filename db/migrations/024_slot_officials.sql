-- Extra officials per pipeline slot: second referee (team matches), video
-- assistant, and up to two assessors. The primary referee stays on
-- pipeline_slots.referee_id; these are optional additions.
CREATE TABLE pipeline_slot_officials (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id    INTEGER NOT NULL REFERENCES pipeline_slots(id) ON DELETE CASCADE,
  referee_id INTEGER NOT NULL REFERENCES referees(id)       ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK (role IN ('referee2', 'video_assistant', 'assessor1', 'assessor2')),
  UNIQUE (slot_id, role)
);
