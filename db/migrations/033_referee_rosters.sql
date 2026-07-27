-- Referee roster for a whole tournament — lets a federation register its
-- referees once for a multi-competition event instead of re-adding them to
-- every competition inside it.
CREATE TABLE tournament_referees (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  referee_id    INTEGER NOT NULL REFERENCES referees(id)    ON DELETE CASCADE,
  PRIMARY KEY (tournament_id, referee_id)
);

-- Referee roster for one specific competition. A competition's *effective*
-- available referees are the union of this table and tournament_referees for
-- its own tournament_id (if any) — see services/competitionReferees.js.
CREATE TABLE competition_referees (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  referee_id     INTEGER NOT NULL REFERENCES referees(id)     ON DELETE CASCADE,
  PRIMARY KEY (competition_id, referee_id)
);
