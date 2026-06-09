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

    const comps = db.prepare(`
      SELECT c.*, t.name AS tournament_name,
        COUNT(comp.id) AS competitor_count
      FROM competitions c
      LEFT JOIN tournaments t ON t.id = c.tournament_id
      LEFT JOIN competitors comp ON comp.competition_id = c.id
      ${where}
      GROUP BY c.id
      ORDER BY c.date DESC, c.name
    `).all(params);

    if (!comps.length) return comps;

    // One query for all age categories — avoids N+1 on the list page.
    const placeholders = comps.map(() => '?').join(',');
    const cats = db.prepare(`
      SELECT cac.competition_id, ac.*
      FROM age_categories ac
      JOIN competition_age_categories cac ON cac.age_category_id = ac.id
      WHERE cac.competition_id IN (${placeholders})
      ORDER BY COALESCE(ac.max_age, 999)
    `).all(...comps.map(c => c.id));

    const catsByComp = {};
    for (const cat of cats) {
      (catsByComp[cat.competition_id] = catsByComp[cat.competition_id] || []).push(cat);
    }
    for (const comp of comps) comp.age_categories = catsByComp[comp.id] || [];

    return comps;
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

  create({ tournament_id, name, weapon, gender, date, status, age_category_ids, is_team }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO competitions (tournament_id, name, weapon, gender, date, status, is_team)
      VALUES (@tournament_id, @name, @weapon, @gender, @date, @status, @is_team)
    `).run({
      tournament_id: tournament_id || null,
      name, weapon, gender,
      date: date || null,
      status: status || 'draft',
      is_team: is_team ? 1 : 0,
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
        weapon=@weapon, gender=@gender, date=@date, status=@status, is_team=@is_team
      WHERE id=@id
    `).run({ id: Number(id), tournament_id: m.tournament_id || null,
             name: m.name, weapon: m.weapon, gender: m.gender,
             date: m.date || null, status: m.status,
             is_team: fields.is_team !== undefined ? (fields.is_team ? 1 : 0) : (current.is_team || 0) });
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

  // Returns competitions that have an active or pending phase, with progress.
  // active phases = currently being fenced; pending = set up but not started yet.
  withLivePhases() {
    const rows = db.prepare(`
      SELECT c.id, c.name, c.weapon, c.gender,
             p.id AS phase_id, p.type AS phase_type, p.phase_order, p.status AS phase_status
      FROM competitions c
      LEFT JOIN phases p ON p.competition_id = c.id AND p.status IN ('active','pending')
      WHERE c.status = 'active'
      ORDER BY c.name, p.phase_order DESC
    `).all();

    return rows.map(row => {
      let progress = null;
      if (row.phase_type === 'pool') {
        const s = db.prepare(`
          SELECT COUNT(*) AS total,
                 SUM(CASE WHEN b.status='finished' THEN 1 ELSE 0 END) AS done
          FROM bouts b JOIN pools po ON po.id = b.pool_id WHERE po.phase_id = ?
        `).get(row.phase_id);
        progress = { total: s.total || 0, done: s.done || 0 };
      } else if (row.phase_type === 'de') {
        const s = db.prepare(`
          SELECT COUNT(*) AS total,
                 SUM(CASE WHEN status='finished' THEN 1 ELSE 0 END) AS done,
                 MAX(de_round) AS max_round
          FROM bouts WHERE phase_id=? AND de_round IS NOT NULL
            AND left_id IS NOT NULL AND right_id IS NOT NULL
        `).get(row.phase_id);
        const cur = db.prepare(`
          SELECT MIN(de_round) AS r FROM bouts
          WHERE phase_id=? AND de_round IS NOT NULL AND status!='finished'
            AND left_id IS NOT NULL AND right_id IS NOT NULL
        `).get(row.phase_id);
        progress = { total: s.total||0, done: s.done||0,
                     max_round: s.max_round, current_round: cur?.r||null };
      }
      return { ...row, progress };
    });
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
