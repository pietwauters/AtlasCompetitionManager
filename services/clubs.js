'use strict';
const db = require('../db');

const Club = {
  findAll() {
    return db.prepare(`
      SELECT id, name, short_name, country FROM clubs ORDER BY name
    `).all();
  },

  findAllWithCounts() {
    return db.prepare(`
      SELECT c.id, c.name, c.short_name, c.country,
             COUNT(p.id) AS fencer_count
      FROM clubs c
      LEFT JOIN people p ON p.club_id = c.id
      GROUP BY c.id
      ORDER BY c.name
    `).all();
  },

  findById(id) {
    return db.prepare('SELECT * FROM clubs WHERE id = ?').get(id);
  },

  findByName(name) {
    return db.prepare('SELECT * FROM clubs WHERE name = ? COLLATE NOCASE').get(name);
  },

  // Find by name, create if not found. Used during CSV import.
  findOrCreate(name, country = '') {
    const existing = this.findByName(name.trim());
    if (existing) return existing;
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO clubs (name, country) VALUES (?, ?)'
    ).run(name.trim(), country);
    return this.findById(lastInsertRowid);
  },

  create({ name, short_name, country }) {
    const trimmed = name.trim();
    const conflict = this.findByName(trimmed);
    if (conflict) throw new Error(`A club named "${conflict.name}" already exists`);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO clubs (name, short_name, country)
      VALUES (@name, @short_name, @country)
    `).run({ name: trimmed, short_name: short_name || null, country: country || '' });
    return this.findById(lastInsertRowid);
  },

  update(id, fields) {
    const current = this.findById(id);
    if (!current) return null;
    const merged = { ...current, ...fields };
    const trimmed = merged.name.trim();
    const conflict = this.findByName(trimmed);
    if (conflict && Number(conflict.id) !== Number(id)) throw new Error(`A club named "${conflict.name}" already exists`);
    db.prepare(`
      UPDATE clubs SET name = @name, short_name = @short_name, country = @country
      WHERE id = @id
    `).run({ id: Number(id), name: trimmed, short_name: merged.short_name || null, country: merged.country || '' });
    return this.findById(id);
  },

  delete(id) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM people WHERE club_id = ?').get(id);
    if (count.n > 0) throw new Error(`Club has ${count.n} fencer(s) — reassign or merge before deleting`);
    return db.prepare('DELETE FROM clubs WHERE id = ?').run(id);
  },

  // Move all fencers from sourceId to targetId, then delete source.
  merge(sourceId, targetId) {
    if (Number(sourceId) === Number(targetId)) throw new Error('Source and target must be different clubs');
    const source = this.findById(sourceId);
    const target = this.findById(targetId);
    if (!source) throw new Error('Source club not found');
    if (!target) throw new Error('Target club not found');
    const moved = db.prepare('UPDATE people SET club_id = ? WHERE club_id = ?').run(targetId, sourceId).changes;
    db.prepare('DELETE FROM clubs WHERE id = ?').run(sourceId);
    return { moved, target };
  },
};

module.exports = Club;
