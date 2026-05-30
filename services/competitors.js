'use strict';
const db          = require('../db');
const Competition = require('./competitions');

function parseWeapons(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return [raw]; }
}

// Full competitor row with person + fencer data.
const BASE = `
  SELECT
    comp.id AS competitor_id, comp.initial_seed, comp.status AS competitor_status,
    comp.final_rank, comp.eliminated_after,
    f.id AS fencer_id, f.licence, f.weapons, f.handedness, f.ranking,
    p.id, p.first_name, p.last_name, p.date_of_birth, p.gender, p.nationality, p.club_id,
    c.name AS club_name
  FROM competitors comp
  JOIN fencers f ON f.id = comp.fencer_id
  JOIN people  p ON p.id = f.person_id
  LEFT JOIN clubs c ON c.id = p.club_id
`;

function hydrate(row) {
  if (!row) return null;
  return { ...row, weapons: parseWeapons(row.weapons) };
}

const Competitor = {
  findAll(competitionId) {
    return db.prepare(`${BASE} WHERE comp.competition_id = ?
      ORDER BY comp.initial_seed ASC, p.last_name, p.first_name`)
      .all(competitionId).map(hydrate);
  },

  findById(competitorId) {
    return hydrate(db.prepare(`${BASE} WHERE comp.id = ?`).get(competitorId));
  },

  // All fencers eligible for a competition (filtered by gender, weapon, age).
  // Returns every fencer with is_registered flag — caller decides what to show.
  findEligible(competitionId) {
    const comp = Competition.findById(competitionId);
    if (!comp) return [];

    const compYear = comp.date
      ? new Date(comp.date).getFullYear()
      : new Date().getFullYear();

    return db.prepare(`
      SELECT
        f.id AS fencer_id, f.licence, f.weapons, f.handedness, f.ranking,
        p.id, p.first_name, p.last_name, p.date_of_birth, p.gender,
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
        ON comp.fencer_id = f.id AND comp.competition_id = @comp_id
      WHERE
        -- Gender: X (mixed) competitions accept anyone
        (@gender = 'X' OR p.gender IS NULL OR p.gender = @gender OR p.gender = 'X')
        -- Weapon: include fencers with no weapon set (field is optional)
        AND (f.weapons IS NULL OR f.weapons = '[]'
             OR instr(f.weapons, '"' || @weapon || '"') > 0)
        -- Age eligibility: fencer qualifies for at least one of the competition's
        -- age categories; if none are defined, all ages are eligible.
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
    `).all({ comp_id: competitionId, gender: comp.gender, weapon: comp.weapon, year: compYear })
      .map(hydrate);
  },

  add(competitionId, fencerId, initialSeed = null) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO competitors (competition_id, fencer_id, initial_seed, status)
      VALUES (@competition_id, @fencer_id, @initial_seed, 'active')
    `).run({ competition_id: Number(competitionId), fencer_id: Number(fencerId),
             initial_seed: initialSeed });
    return this.findById(lastInsertRowid);
  },

  // Add multiple fencers at once. Skips fencers already registered.
  bulkAdd(competitionId, fencerIds) {
    const existing = new Set(
      db.prepare('SELECT fencer_id FROM competitors WHERE competition_id = ?')
        .all(competitionId).map(r => r.fencer_id)
    );
    const insert = db.prepare(`
      INSERT INTO competitors (competition_id, fencer_id, status)
      VALUES (@competition_id, @fencer_id, 'active')
    `);
    const run = db.transaction(() => {
      let added = 0;
      for (const fid of fencerIds) {
        if (!existing.has(Number(fid))) {
          insert.run({ competition_id: Number(competitionId), fencer_id: Number(fid) });
          added++;
        }
      }
      return added;
    });
    return run();
  },

  update(competitorId, fields) {
    const current = db.prepare('SELECT * FROM competitors WHERE id = ?').get(competitorId);
    if (!current) return null;
    const m = { ...current, ...fields };
    db.prepare(`
      UPDATE competitors
      SET initial_seed=@initial_seed, status=@status, final_rank=@final_rank
      WHERE id=@id
    `).run({ id: Number(competitorId), initial_seed: m.initial_seed ?? null,
             status: m.status, final_rank: m.final_rank ?? null });
    return this.findById(competitorId);
  },

  remove(competitorId) {
    return db.prepare('DELETE FROM competitors WHERE id = ?').run(competitorId);
  },

  // Assign seeds 1..N sorted by fencer ranking, then name (unranked go last).
  autoSeed(competitionId) {
    const rows = db.prepare(`
      SELECT comp.id, f.ranking, p.last_name, p.first_name
      FROM competitors comp
      JOIN fencers f ON f.id = comp.fencer_id
      JOIN people  p ON p.id = f.person_id
      WHERE comp.competition_id = ? AND comp.status = 'active'
      ORDER BY CASE WHEN f.ranking IS NULL THEN 1 ELSE 0 END,
               f.ranking ASC, p.last_name, p.first_name
    `).all(competitionId);

    const update = db.prepare(
      'UPDATE competitors SET initial_seed = ? WHERE id = ?'
    );
    const run = db.transaction(() => {
      rows.forEach((r, i) => update.run(i + 1, r.id));
    });
    run();
    return rows.length;
  },
};

module.exports = Competitor;
