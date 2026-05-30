'use strict';
const db = require('../db');

// Weapons is stored as a JSON array string in the DB.
function parseWeapons(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return [raw]; }
}

const Person = {
  // List all people with role flags and club name.
  // Filters: search (name), role ('fencer'|'referee'), club_id
  findAll({ search, role, club_id } = {}) {
    const wheres  = [];
    const params  = [];

    if (search) {
      wheres.push('(p.last_name LIKE ? OR p.first_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (club_id) {
      wheres.push('p.club_id = ?');
      params.push(Number(club_id));
    }
    if (role === 'fencer')  wheres.push('f.id IS NOT NULL');
    if (role === 'referee') wheres.push('r.id IS NOT NULL');

    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

    return db.prepare(`
      SELECT
        p.id, p.first_name, p.last_name, p.date_of_birth, p.gender,
        p.nationality, p.club_id, c.name AS club_name,
        CASE WHEN f.id IS NOT NULL THEN 1 ELSE 0 END AS is_fencer,
        CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END AS is_referee
      FROM people p
      LEFT JOIN clubs    c ON c.id = p.club_id
      LEFT JOIN fencers  f ON f.person_id = p.id
      LEFT JOIN referees r ON r.person_id = p.id
      ${where}
      ORDER BY p.last_name, p.first_name
    `).all(...params);
  },

  // Get one person with nested fencer and referee profiles.
  findById(id) {
    const person = db.prepare(`
      SELECT p.*, c.name AS club_name
      FROM people p
      LEFT JOIN clubs c ON c.id = p.club_id
      WHERE p.id = ?
    `).get(id);
    if (!person) return null;

    const fencer = db.prepare(
      'SELECT id, licence, weapons, handedness, ranking FROM fencers WHERE person_id = ?'
    ).get(id);
    if (fencer) fencer.weapons = parseWeapons(fencer.weapons);

    const referee = db.prepare(
      'SELECT id, licence, level FROM referees WHERE person_id = ?'
    ).get(id);

    return { ...person, fencer: fencer || null, referee: referee || null };
  },

  create({ first_name, last_name, date_of_birth, gender, nationality, club_id }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO people (first_name, last_name, date_of_birth, gender, nationality, club_id)
      VALUES (@first_name, @last_name, @date_of_birth, @gender, @nationality, @club_id)
    `).run({
      first_name,
      last_name,
      date_of_birth: date_of_birth || null,
      gender:        gender        || null,
      nationality:   nationality   || null,
      club_id:       club_id       || null,
    });
    return this.findById(lastInsertRowid);
  },

  // Patch-style update: only supplied fields overwrite existing values.
  update(id, fields) {
    const current = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
    if (!current) return null;
    const m = { ...current, ...fields };
    db.prepare(`
      UPDATE people
      SET first_name = @first_name, last_name = @last_name,
          date_of_birth = @date_of_birth, gender = @gender,
          nationality = @nationality, club_id = @club_id
      WHERE id = @id
    `).run({
      id: Number(id),
      first_name:    m.first_name,
      last_name:     m.last_name,
      date_of_birth: m.date_of_birth,
      gender:        m.gender,
      nationality:   m.nationality,
      club_id:       m.club_id,
    });
    return this.findById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM people WHERE id = ?').run(id);
  },
};

module.exports = Person;
