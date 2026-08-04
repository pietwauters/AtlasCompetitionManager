-- Referee presence check-in, scoped per competition — mirrors
-- competitors.checked_in (fencer presence) but as its own table rather than
-- a column on an existing one. A referee's *effective* roster entry can come
-- from either competition_referees or tournament_referees (the union model
-- in services/competitionReferees.js), and a tournament-roster referee has
-- no competition_referees row of their own to attach a presence flag to —
-- so presence needs a table that's independent of which roster brought the
-- referee in. Presence = row exists; see
-- services/competitionReferees.js checkIn()/checkOut().
CREATE TABLE referee_checkins (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  referee_id     INTEGER NOT NULL REFERENCES referees(id)     ON DELETE CASCADE,
  checked_in_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (competition_id, referee_id)
);
