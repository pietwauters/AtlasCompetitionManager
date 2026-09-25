-- Machine-readable competition identifier published as `competition` in OPP2
-- software/match and software/record, and listed in the cloud tournament identity
-- message (docs/level2.md §31.4/§31.5). Unique within a tournament. Not an Atlas
-- internal id — the OPP2 ecosystem principle bars those from payloads.
--
-- Backfill: {age categories}-{gender}-{weapon}[-team], e.g. "u17-m-foil",
-- "open-f-epee-team"; later duplicates in the same tournament get -2, -3, ...
ALTER TABLE competitions ADD COLUMN code TEXT;

WITH base AS (
  SELECT c.id, c.tournament_id,
    lower(replace(COALESCE((
      SELECT group_concat(code, '-') FROM (
        SELECT ac.code FROM age_categories ac
        JOIN competition_age_categories cac ON cac.age_category_id = ac.id
        WHERE cac.competition_id = c.id
        ORDER BY COALESCE(ac.max_age, 999)
      )
    ), 'open'), ' ', '-'))
    || '-' || lower(c.gender) || '-' || lower(c.weapon)
    || CASE WHEN c.is_team = 1 THEN '-team' ELSE '' END AS b
  FROM competitions c
),
numbered AS (
  SELECT id, b, ROW_NUMBER() OVER (PARTITION BY tournament_id, b ORDER BY id) AS n FROM base
)
UPDATE competitions
SET code = CASE WHEN numbered.n = 1 THEN numbered.b ELSE numbered.b || '-' || numbered.n END
FROM numbered
WHERE numbered.id = competitions.id;

CREATE UNIQUE INDEX ux_competitions_tournament_code
  ON competitions(tournament_id, code) WHERE code IS NOT NULL;
