'use strict';
const db = require('../db');

function parseWeapons(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return [raw]; }
}

function serializeWeapons(weapons) {
  if (!weapons || !weapons.length) return null;
  return JSON.stringify(Array.isArray(weapons) ? weapons : [weapons]);
}

function hydrate(row) {
  if (!row) return null;
  return { ...row, weapons: parseWeapons(row.weapons) };
}

// All fencer queries join people + clubs so callers never need to do it.
const BASE = `
  SELECT
    f.id AS fencer_id,
    f.weapons, f.handedness, f.fie_statut,
    p.id, p.first_name, p.last_name, p.date_of_birth, p.gender,
    p.nationality, p.club_id, p.fie_id, c.name AS club_name
  FROM fencers f
  JOIN  people p ON p.id = f.person_id
  LEFT JOIN clubs c ON c.id = p.club_id
`;

const Fencer = {
  // List fencers with optional search and club filter.
  findAll({ search, club_id } = {}) {
    const wheres = [];
    const params = [];
    if (search) {
      wheres.push('(p.last_name LIKE ? OR p.first_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (club_id) {
      wheres.push('p.club_id = ?');
      params.push(Number(club_id));
    }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    return db.prepare(`${BASE} ${where} ORDER BY p.last_name, p.first_name`)
             .all(...params).map(hydrate);
  },

  findById(fencerId) {
    return hydrate(db.prepare(`${BASE} WHERE f.id = ?`).get(fencerId));
  },

  findByPersonId(personId) {
    return hydrate(db.prepare(`${BASE} WHERE f.person_id = ?`).get(personId));
  },

  // Match on any licence number across all issuers.
  findByLicence(number) {
    return hydrate(db.prepare(`
      ${BASE}
      JOIN licences l ON l.person_id = p.id
      WHERE l.number = ?
    `).get(number));
  },

  // Add a fencer profile to an existing person.
  create(personId, { weapons, handedness } = {}) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO fencers (person_id, weapons, handedness)
      VALUES (@person_id, @weapons, @handedness)
    `).run({
      person_id:  Number(personId),
      weapons:    serializeWeapons(weapons),
      handedness: handedness || null,
    });
    return this.findById(lastInsertRowid);
  },

  // Patch-style update: only supplied fields overwrite existing values.
  update(fencerId, fields) {
    const current = db.prepare('SELECT * FROM fencers WHERE id = ?').get(fencerId);
    if (!current) return null;
    const m = { ...current, ...fields };
    db.prepare(`
      UPDATE fencers
      SET weapons = @weapons, handedness = @handedness
      WHERE id = @id
    `).run({
      id:         Number(fencerId),
      weapons:    serializeWeapons(m.weapons),
      handedness: m.handedness || null,
    });
    return this.findById(fencerId);
  },

  delete(fencerId) {
    return db.prepare('DELETE FROM fencers WHERE id = ?').run(fencerId);
  },

  deleteByPersonId(personId) {
    return db.prepare('DELETE FROM fencers WHERE person_id = ?').run(personId);
  },
};

module.exports = Fencer;
