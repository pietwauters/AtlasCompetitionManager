'use strict';
const db          = require('../db');
const Competition = require('./competitions');

// Full competitor row. Person data lives directly on competitors (snapshot model).
// In Mode 2 (DB-driven), person_id is set and club comes via the people join.
// In Mode 1 (FIE XML / file-based), person_id is NULL and club_name is always NULL.
const BASE = `
  SELECT
    comp.id AS competitor_id, comp.competition_id,
    comp.initial_seed, comp.status AS competitor_status,
    comp.checked_in, comp.final_rank, comp.eliminated_after,
    comp.first_name, comp.last_name, comp.date_of_birth,
    comp.gender, comp.nationality, comp.handedness,
    comp.fie_id, comp.fie_licence,
    comp.seeding_points, comp.seeding_position, comp.seeding_issuer,
    comp.person_id,
    cl.name AS club_name
  FROM competitors comp
  LEFT JOIN people p  ON p.id  = comp.person_id
  LEFT JOIN clubs  cl ON cl.id = p.club_id
`;

const stmtFindAll = db.prepare(`${BASE} WHERE comp.competition_id = ?
  ORDER BY comp.initial_seed ASC, comp.last_name, comp.first_name`);
const stmtFindById = db.prepare(`${BASE} WHERE comp.id = ?`);
const stmtFindEligible = db.prepare(`
  SELECT
    f.id AS fencer_id, f.weapons, f.handedness,
    p.id AS person_id, p.first_name, p.last_name, p.date_of_birth, p.gender,
    p.nationality, p.club_id, c.name AS club_name,
    CASE WHEN comp.id IS NOT NULL THEN 1 ELSE 0 END AS is_registered,
    comp.id AS competitor_id, comp.initial_seed,
    CASE WHEN p.date_of_birth IS NOT NULL
      THEN @year - CAST(strftime('%Y', p.date_of_birth) AS INTEGER)
      ELSE NULL END AS age
  FROM fencers f
  JOIN people p ON p.id = f.person_id
  LEFT JOIN clubs c ON c.id = p.club_id
  LEFT JOIN competitors comp
    ON comp.person_id = p.id AND comp.competition_id = @comp_id
  WHERE
    (@gender = 'X' OR p.gender IS NULL OR p.gender = @gender OR p.gender = 'X')
    AND (f.weapons IS NULL OR f.weapons = '[]'
         OR instr(f.weapons, '"' || @weapon || '"') > 0)
    AND (
      p.date_of_birth IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM competition_age_categories WHERE competition_id = @comp_id
      )
      OR EXISTS (
        SELECT 1 FROM competition_age_categories cac
        JOIN age_categories ac ON ac.id = cac.age_category_id
        WHERE cac.competition_id = @comp_id
          AND (@year - CAST(strftime('%Y', p.date_of_birth) AS INTEGER)
                >= COALESCE(ac.min_age, 0))
          AND (@year - CAST(strftime('%Y', p.date_of_birth) AS INTEGER)
                <= COALESCE(ac.max_age, 999))
      )
    )
  ORDER BY p.last_name, p.first_name
`);
const stmtPersonWithHandedness = db.prepare(`
  SELECT p.*, f.handedness
  FROM people p
  LEFT JOIN fencers f ON f.person_id = p.id
  WHERE p.id = ?
`);
const stmtInsertCompetitor = db.prepare(`
  INSERT INTO competitors
    (competition_id, person_id, last_name, first_name, date_of_birth,
     gender, nationality, handedness, initial_seed, status)
  VALUES
    (@competition_id, @person_id, @last_name, @first_name, @date_of_birth,
     @gender, @nationality, @handedness, @initial_seed, 'active')
`);
const stmtExistingPersonIds = db.prepare(
  'SELECT person_id FROM competitors WHERE competition_id = ? AND person_id IS NOT NULL'
);
const stmtRawById = db.prepare('SELECT * FROM competitors WHERE id = ?');
const stmtUpdate = db.prepare(`
  UPDATE competitors
  SET initial_seed=@initial_seed, status=@status, final_rank=@final_rank,
      checked_in=@checked_in
  WHERE id=@id
`);
const stmtRemove = db.prepare('DELETE FROM competitors WHERE id = ?');
const stmtActiveForAutoSeed = db.prepare(`
  SELECT id, seeding_position, last_name, first_name
  FROM competitors
  WHERE competition_id = ? AND status = 'active'
  ORDER BY CASE WHEN seeding_position IS NULL THEN 1 ELSE 0 END,
           seeding_position ASC, last_name, first_name
`);
const stmtSetInitialSeed = db.prepare('UPDATE competitors SET initial_seed = ? WHERE id = ?');

const Competitor = {
  findAll(competitionId) {
    return stmtFindAll.all(competitionId);
  },

  findById(competitorId) {
    return stmtFindById.get(competitorId) || null;
  },

  // All fencers from the local roster eligible for a competition
  // (filtered by gender, weapon, age). Returns fencer rows with is_registered flag.
  findEligible(competitionId) {
    const comp = Competition.findById(competitionId);
    if (!comp) return [];

    const compYear = comp.date
      ? new Date(comp.date).getFullYear()
      : new Date().getFullYear();

    return stmtFindEligible.all({ comp_id: competitionId, gender: comp.gender, weapon: comp.weapon, year: compYear });
  },

  // Mode 2 (DB-driven): enrol a person from the local roster.
  // Copies person snapshot from people+fencers into competitors.
  add(competitionId, personId, initialSeed = null) {
    const person = stmtPersonWithHandedness.get(personId);
    if (!person) throw Object.assign(new Error('Person not found.'), { status: 404 });

    const { lastInsertRowid } = stmtInsertCompetitor.run({
      competition_id: Number(competitionId),
      person_id:      Number(personId),
      last_name:      person.last_name  || null,
      first_name:     person.first_name || null,
      date_of_birth:  person.date_of_birth || null,
      gender:         person.gender || null,
      nationality:    person.nationality || null,
      handedness:     person.handedness || null,
      initial_seed:   initialSeed,
    });
    return this.findById(lastInsertRowid);
  },

  // Add multiple people from the roster at once. Skips already-registered people.
  bulkAdd(competitionId, personIds) {
    const existing = new Set(
      stmtExistingPersonIds.all(competitionId).map(r => r.person_id)
    );
    const run = db.transaction(() => {
      let added = 0;
      for (const pid of personIds) {
        if (!existing.has(Number(pid))) {
          this.add(competitionId, pid);
          added++;
        }
      }
      return added;
    });
    return run();
  },

  update(competitorId, fields) {
    const current = stmtRawById.get(competitorId);
    if (!current) return null;
    const m = { ...current, ...fields };
    stmtUpdate.run({ id: Number(competitorId), initial_seed: m.initial_seed ?? null,
             status: m.status, final_rank: m.final_rank ?? null,
             checked_in: m.checked_in ?? current.checked_in ?? 0 });
    return this.findById(competitorId);
  },

  remove(competitorId) {
    return stmtRemove.run(competitorId);
  },

  // Assign seeds 1..N sorted by seeding_position ASC (lower = better), then name.
  // Competitors without a seeding_position go last.
  autoSeed(competitionId) {
    const rows = stmtActiveForAutoSeed.all(competitionId);

    db.transaction(() => {
      rows.forEach((r, i) => stmtSetInitialSeed.run(i + 1, r.id));
    })();
    return rows.length;
  },
};

module.exports = Competitor;
