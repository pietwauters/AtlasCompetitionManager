-- =============================================================================
-- Migration 006 — Audit event log
-- =============================================================================

CREATE TABLE events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER REFERENCES competitions(id) ON DELETE CASCADE,
  phase_id       INTEGER REFERENCES phases(id)       ON DELETE SET NULL,
  bout_id        INTEGER REFERENCES bouts(id)        ON DELETE SET NULL,
  recorded_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_type     TEXT    NOT NULL,   -- dot-namespaced: card.yellow, card.red, card.black,
                                     --   card.p, video.call, video.result, bout.score_override
  actor          TEXT    NOT NULL,   -- apparatus | referee | software | manual
  actor_id       INTEGER,            -- referee_id when actor='referee', null otherwise
  side           TEXT,               -- left | right | null
  correlation_id TEXT,               -- links a video.call to its video.result
  payload        TEXT                -- JSON, event-type specific
);

CREATE INDEX idx_events_competition ON events(competition_id, recorded_at DESC);
CREATE INDEX idx_events_bout        ON events(bout_id, recorded_at);
CREATE INDEX idx_events_type        ON events(event_type, competition_id);
