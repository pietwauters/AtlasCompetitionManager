'use strict';
const db = require('../db');

function withAgeCategories(comp) {
  if (!comp) return null;
  comp.age_categories = db.prepare(`
    SELECT ac.* FROM age_categories ac
    JOIN competition_age_categories cac ON cac.age_category_id = ac.id
    WHERE cac.competition_id = ?
    ORDER BY COALESCE(ac.max_age, 999)
  `).all(comp.id);
  return comp;
}

const Competition = {
  findAll({ tournament_id, include_archived = false } = {}) {
    const conditions = [];
    const params     = {};
    if (tournament_id)    { conditions.push('c.tournament_id = @tournament_id'); params.tournament_id = tournament_id; }
    if (!include_archived){ conditions.push("c.status != 'archived'"); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    return db.prepare(`
      SELECT c.*, t.name AS tournament_name,
        COUNT(comp.id) AS competitor_count
      FROM competitions c
      LEFT JOIN tournaments t ON t.id = c.tournament_id
      LEFT JOIN competitors comp ON comp.competition_id = c.id
      ${where}
      GROUP BY c.id
      ORDER BY c.date DESC, c.name
    `).all(params);
  },

  findById(id) {
    const comp = db.prepare(`
      SELECT c.*, t.name AS tournament_name
      FROM competitions c
      LEFT JOIN tournaments t ON t.id = c.tournament_id
      WHERE c.id = ?
    `).get(id);
    return withAgeCategories(comp);
  },

  create({ tournament_id, name, weapon, gender, date, status, age_category_ids }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO competitions (tournament_id, name, weapon, gender, date, status)
      VALUES (@tournament_id, @name, @weapon, @gender, @date, @status)
    `).run({
      tournament_id: tournament_id || null,
      name, weapon, gender,
      date: date || null,
      status: status || 'draft',
    });
    if (age_category_ids?.length) {
      this.setAgeCategories(lastInsertRowid, age_category_ids);
    }
    return this.findById(lastInsertRowid);
  },

  update(id, fields) {
    const current = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
    if (!current) return null;
    const m = { ...current, ...fields };
    db.prepare(`
      UPDATE competitions SET tournament_id=@tournament_id, name=@name,
        weapon=@weapon, gender=@gender, date=@date, status=@status
      WHERE id=@id
    `).run({ id: Number(id), tournament_id: m.tournament_id || null,
             name: m.name, weapon: m.weapon, gender: m.gender,
             date: m.date || null, status: m.status });
    if (fields.age_category_ids !== undefined) {
      this.setAgeCategories(id, fields.age_category_ids || []);
    }
    return this.findById(id);
  },

  // Replace all age categories for a competition.
  setAgeCategories(compId, categoryIds) {
    const run = db.transaction(() => {
      db.prepare('DELETE FROM competition_age_categories WHERE competition_id = ?').run(compId);
      const insert = db.prepare(
        'INSERT INTO competition_age_categories (competition_id, age_category_id) VALUES (?, ?)'
      );
      for (const catId of categoryIds) insert.run(compId, catId);
    });
    run();
  },

  archive(id) {
    return db.prepare("UPDATE competitions SET status='archived' WHERE id=?").run(id);
  },

  delete(id) {
    const run = db.transaction(() => {
      // bouts.left_id/right_id are RESTRICT — delete bouts first so the
      // cascade from competitors can proceed without hitting the constraint.
      db.prepare(`
        DELETE FROM bouts WHERE phase_id IN (SELECT id FROM phases WHERE competition_id = ?)
      `).run(id);
      return db.prepare('DELETE FROM competitions WHERE id = ?').run(id);
    });
    return run();
  },
};

module.exports = Competition;
