'use strict';
const db = require('../db');

const BASE = `
  SELECT
    r.id AS referee_id, r.licence, r.level,
    p.id, p.first_name, p.last_name, p.date_of_birth, p.gender,
    p.nationality, p.club_id, c.name AS club_name
  FROM referees r
  JOIN  people p ON p.id = r.person_id
  LEFT JOIN clubs c ON c.id = p.club_id
`;

const Referee = {
  findAll() {
    return db.prepare(`${BASE} ORDER BY p.last_name, p.first_name`).all();
  },

  findById(refereeId) {
    return db.prepare(`${BASE} WHERE r.id = ?`).get(refereeId);
  },

  findByPersonId(personId) {
    return db.prepare(`${BASE} WHERE r.person_id = ?`).get(personId);
  },

  // Add a referee profile to an existing person.
  create(personId, { licence, level } = {}) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO referees (person_id, licence, level)
      VALUES (@person_id, @licence, @level)
    `).run({ person_id: Number(personId), licence: licence || null, level: level || null });
    return this.findById(lastInsertRowid);
  },

  update(refereeId, fields) {
    const current = db.prepare('SELECT * FROM referees WHERE id = ?').get(refereeId);
    if (!current) return null;
    const m = { ...current, ...fields };
    db.prepare(`
      UPDATE referees SET licence = @licence, level = @level WHERE id = @id
    `).run({ id: Number(refereeId), licence: m.licence || null, level: m.level || null });
    return this.findById(refereeId);
  },

  delete(refereeId) {
    return db.prepare('DELETE FROM referees WHERE id = ?').run(refereeId);
  },

  deleteByPersonId(personId) {
    return db.prepare('DELETE FROM referees WHERE person_id = ?').run(personId);
  },
};

module.exports = Referee;
