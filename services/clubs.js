'use strict';
const db = require('../db');

const stmtFindAll = db.prepare(`
  SELECT id, name, short_name, country FROM clubs ORDER BY name
`);
const stmtFindAllWithCounts = db.prepare(`
  SELECT c.id, c.name, c.short_name, c.country,
         COUNT(p.id) AS fencer_count
  FROM clubs c
  LEFT JOIN people p ON p.club_id = c.id
  GROUP BY c.id
  ORDER BY c.name
`);
const stmtFindById = db.prepare('SELECT * FROM clubs WHERE id = ?');
const stmtFindByName = db.prepare('SELECT * FROM clubs WHERE name = ? COLLATE NOCASE');
const stmtInsertFindOrCreate = db.prepare(
  'INSERT INTO clubs (name, country) VALUES (?, ?)'
);
const stmtCreate = db.prepare(`
  INSERT INTO clubs (name, short_name, country)
  VALUES (@name, @short_name, @country)
`);
const stmtUpdate = db.prepare(`
  UPDATE clubs SET name = @name, short_name = @short_name, country = @country
  WHERE id = @id
`);
const stmtFencerCountForClub = db.prepare('SELECT COUNT(*) AS n FROM people WHERE club_id = ?');
const stmtDelete = db.prepare('DELETE FROM clubs WHERE id = ?');
const stmtMovePeople = db.prepare('UPDATE people SET club_id = ? WHERE club_id = ?');

const Club = {
  findAll() {
    return stmtFindAll.all();
  },

  findAllWithCounts() {
    return stmtFindAllWithCounts.all();
  },

  findById(id) {
    return stmtFindById.get(id);
  },

  findByName(name) {
    return stmtFindByName.get(name);
  },

  // Find by name, create if not found. Used during CSV import.
  findOrCreate(name, country = '') {
    const existing = this.findByName(name.trim());
    if (existing) return existing;
    const { lastInsertRowid } = stmtInsertFindOrCreate.run(name.trim(), country);
    return this.findById(lastInsertRowid);
  },

  create({ name, short_name, country }) {
    const trimmed = name.trim();
    const conflict = this.findByName(trimmed);
    if (conflict) throw new Error(`A club named "${conflict.name}" already exists`);
    const { lastInsertRowid } = stmtCreate.run({ name: trimmed, short_name: short_name || null, country: country || '' });
    return this.findById(lastInsertRowid);
  },

  update(id, fields) {
    const current = this.findById(id);
    if (!current) return null;
    const merged = { ...current, ...fields };
    const trimmed = merged.name.trim();
    const conflict = this.findByName(trimmed);
    if (conflict && Number(conflict.id) !== Number(id)) throw new Error(`A club named "${conflict.name}" already exists`);
    stmtUpdate.run({ id: Number(id), name: trimmed, short_name: merged.short_name || null, country: merged.country || '' });
    return this.findById(id);
  },

  delete(id) {
    const count = stmtFencerCountForClub.get(id);
    if (count.n > 0) throw new Error(`Club has ${count.n} fencer(s) — reassign or merge before deleting`);
    return stmtDelete.run(id);
  },

  // Move all fencers from sourceId to targetId, then delete source.
  merge(sourceId, targetId) {
    if (Number(sourceId) === Number(targetId)) throw new Error('Source and target must be different clubs');
    const source = this.findById(sourceId);
    const target = this.findById(targetId);
    if (!source) throw new Error('Source club not found');
    if (!target) throw new Error('Target club not found');
    const moved = stmtMovePeople.run(targetId, sourceId).changes;
    stmtDelete.run(sourceId);
    return { moved, target };
  },
};

module.exports = Club;
