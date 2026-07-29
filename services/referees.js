'use strict';
const db = require('../db');

const BASE = `
  SELECT
    r.id AS referee_id, r.level,
    p.id, p.first_name, p.last_name, p.date_of_birth, p.gender,
    p.nationality, p.club_id, c.name AS club_name
  FROM referees r
  JOIN  people p ON p.id = r.person_id
  LEFT JOIN clubs c ON c.id = p.club_id
`;

const stmtFindAll = db.prepare(`${BASE} ORDER BY p.last_name, p.first_name`);
const stmtFindById = db.prepare(`${BASE} WHERE r.id = ?`);
const stmtFindByPersonId = db.prepare(`${BASE} WHERE r.person_id = ?`);
const stmtCreate = db.prepare(`
  INSERT INTO referees (person_id, level)
  VALUES (@person_id, @level)
`);
const stmtRawById = db.prepare('SELECT * FROM referees WHERE id = ?');
const stmtUpdate = db.prepare(`
  UPDATE referees SET level = @level WHERE id = @id
`);
const stmtDelete = db.prepare('DELETE FROM referees WHERE id = ?');
const stmtDeleteByPersonId = db.prepare('DELETE FROM referees WHERE person_id = ?');

const Referee = {
  findAll() {
    return stmtFindAll.all();
  },

  findById(refereeId) {
    return stmtFindById.get(refereeId);
  },

  findByPersonId(personId) {
    return stmtFindByPersonId.get(personId);
  },

  // Add a referee profile to an existing person.
  create(personId, { level } = {}) {
    const { lastInsertRowid } = stmtCreate.run({ person_id: Number(personId), level: level || null });
    return this.findById(lastInsertRowid);
  },

  update(refereeId, fields) {
    const current = stmtRawById.get(refereeId);
    if (!current) return null;
    const m = { ...current, ...fields };
    stmtUpdate.run({ id: Number(refereeId), level: m.level || null });
    return this.findById(refereeId);
  },

  delete(refereeId) {
    return stmtDelete.run(refereeId);
  },

  deleteByPersonId(personId) {
    return stmtDeleteByPersonId.run(personId);
  },
};

module.exports = Referee;
