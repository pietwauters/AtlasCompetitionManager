'use strict';
const db = require('../db');

const AgeCategory = {
  findAll() {
    return db.prepare(`
      SELECT * FROM age_categories ORDER BY COALESCE(max_age, 999), COALESCE(min_age, 0)
    `).all();
  },

  findById(id) {
    return db.prepare('SELECT * FROM age_categories WHERE id = ?').get(id);
  },

  create({ code, label, min_age, max_age, federation, notes }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO age_categories (code, label, min_age, max_age, federation, notes)
      VALUES (@code, @label, @min_age, @max_age, @federation, @notes)
    `).run({ code, label, min_age: min_age ?? null, max_age: max_age ?? null,
             federation: federation || null, notes: notes || null });
    return this.findById(lastInsertRowid);
  },

  update(id, fields) {
    const current = this.findById(id);
    if (!current) return null;
    const m = { ...current, ...fields };
    db.prepare(`
      UPDATE age_categories
      SET code=@code, label=@label, min_age=@min_age, max_age=@max_age,
          federation=@federation, notes=@notes
      WHERE id=@id
    `).run({ id: Number(id), code: m.code, label: m.label,
             min_age: m.min_age ?? null, max_age: m.max_age ?? null,
             federation: m.federation || null, notes: m.notes || null });
    return this.findById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM age_categories WHERE id = ?').run(id);
  },
};

module.exports = AgeCategory;
