-- Recreate bout_duration_standards with gender in the key and
-- running-average tracking columns.
DROP TABLE IF EXISTS bout_duration_standards;

CREATE TABLE bout_duration_standards (
  weapon           TEXT    NOT NULL CHECK (weapon IN ('F','E','S')),
  gender           TEXT    NOT NULL CHECK (gender IN ('M','F','X')),
  phase_type       TEXT    NOT NULL CHECK (phase_type IN ('pool','de')),
  minutes_per_bout INTEGER NOT NULL,
  sample_count     INTEGER NOT NULL DEFAULT 0,
  observed_average REAL,
  PRIMARY KEY (weapon, gender, phase_type)
);

-- Foil: 1 min/touch → pool (5 touches) = 5 min, DE (15 touches) = 15 min
-- Épée: same as foil
-- Sabre: pool = 4 min, DE = 10 min
INSERT INTO bout_duration_standards (weapon, gender, phase_type, minutes_per_bout) VALUES
  ('F','M','pool', 5), ('F','M','de', 15),
  ('F','F','pool', 5), ('F','F','de', 15),
  ('F','X','pool', 5), ('F','X','de', 15),
  ('E','M','pool', 5), ('E','M','de', 15),
  ('E','F','pool', 5), ('E','F','de', 15),
  ('E','X','pool', 5), ('E','X','de', 15),
  ('S','M','pool', 4), ('S','M','de', 10),
  ('S','F','pool', 4), ('S','F','de', 10),
  ('S','X','pool', 4), ('S','X','de', 10);
