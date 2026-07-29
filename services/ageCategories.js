'use strict';
const db = require('../db');

const stmtFindAll = db.prepare(`
  SELECT * FROM age_categories ORDER BY COALESCE(max_age, 999), COALESCE(min_age, 0)
`);
const stmtFindById = db.prepare('SELECT * FROM age_categories WHERE id = ?');
const stmtCreate = db.prepare(`
  INSERT INTO age_categories (code, label, min_age, max_age, federation, notes)
  VALUES (@code, @label, @min_age, @max_age, @federation, @notes)
`);
const stmtUpdate = db.prepare(`
  UPDATE age_categories
  SET code=@code, label=@label, min_age=@min_age, max_age=@max_age,
      federation=@federation, notes=@notes
  WHERE id=@id
`);
const stmtDelete = db.prepare('DELETE FROM age_categories WHERE id = ?');

const AgeCategory = {
  findAll() {
    return stmtFindAll.all();
  },

  findById(id) {
    return stmtFindById.get(id);
  },

  create({ code, label, min_age, max_age, federation, notes }) {
    const { lastInsertRowid } = stmtCreate.run({ code, label, min_age: min_age ?? null, max_age: max_age ?? null,
             federation: federation || null, notes: notes || null });
    return this.findById(lastInsertRowid);
  },

  update(id, fields) {
    const current = this.findById(id);
    if (!current) return null;
    const m = { ...current, ...fields };
    stmtUpdate.run({ id: Number(id), code: m.code, label: m.label,
             min_age: m.min_age ?? null, max_age: m.max_age ?? null,
             federation: m.federation || null, notes: m.notes || null });
    return this.findById(id);
  },

  delete(id) {
    return stmtDelete.run(id);
  },
};

module.exports = AgeCategory;
