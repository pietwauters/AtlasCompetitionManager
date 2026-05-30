'use strict';
const db = require('../db');

const Club = {
  findAll() {
    return db.prepare(`
      SELECT id, name, short_name, country FROM clubs ORDER BY name
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
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO clubs (name, short_name, country)
      VALUES (@name, @short_name, @country)
    `).run({ name, short_name: short_name || null, country: country || '' });
    return this.findById(lastInsertRowid);
  },

  update(id, fields) {
    const current = this.findById(id);
    if (!current) return null;
    const merged = { ...current, ...fields };
    db.prepare(`
      UPDATE clubs SET name = @name, short_name = @short_name, country = @country
      WHERE id = @id
    `).run({ id: Number(id), name: merged.name, short_name: merged.short_name, country: merged.country });
    return this.findById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM clubs WHERE id = ?').run(id);
  },
};

module.exports = Club;
