-- Card reasons recorded by the table official via the scoresheet tablet.
-- bout_id may be NULL if the card is given between bouts or before the bout starts.
CREATE TABLE card_reasons (
  id          INTEGER PRIMARY KEY,
  bout_id     INTEGER REFERENCES bouts(id) ON DELETE SET NULL,
  piste_id    TEXT    NOT NULL,
  side        TEXT    NOT NULL CHECK(side IN ('left','right')),
  card        TEXT    NOT NULL CHECK(card IN ('yellow','red','black')),
  reason      TEXT    NOT NULL,
  recorded_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_card_reasons_bout ON card_reasons(bout_id);
