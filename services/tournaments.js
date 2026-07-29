'use strict';
const db = require('../db');

const stmtFindAll = db.prepare(`
  SELECT t.*,
    COUNT(c.id) AS competition_count
  FROM tournaments t
  LEFT JOIN competitions c ON c.tournament_id = t.id
  GROUP BY t.id
  ORDER BY t.date_start DESC, t.id DESC
`);
const stmtFindByIdRaw = db.prepare('SELECT * FROM tournaments WHERE id = ?');
const stmtCompetitionsForTournament = db.prepare(`
  SELECT id, name, weapon, gender, date, status FROM competitions
  WHERE tournament_id = ? ORDER BY date, name
`);
const stmtCreate = db.prepare(`
  INSERT INTO tournaments (name, city, country, date_start, date_end, organizer, description, level, status)
  VALUES (@name, @city, @country, @date_start, @date_end, @organizer, @description, @level, @status)
`);
const stmtUpdate = db.prepare(`
  UPDATE tournaments SET name=@name, city=@city, country=@country,
    date_start=@date_start, date_end=@date_end, organizer=@organizer,
    description=@description, level=@level, status=@status, archived=@archived
  WHERE id=@id
`);
const stmtDelete = db.prepare('DELETE FROM tournaments WHERE id = ?');

const Tournament = {
  findAll() {
    return stmtFindAll.all();
  },

  findById(id) {
    const t = stmtFindByIdRaw.get(id);
    if (!t) return null;
    t.competitions = stmtCompetitionsForTournament.all(id);
    return t;
  },

  create({ name, city, country, date_start, date_end, organizer, description, level, status }) {
    const { lastInsertRowid } = stmtCreate.run({
      name, city: city || null, country: country || null,
      date_start: date_start || null, date_end: date_end || null,
      organizer: organizer || null, description: description || null,
      level: level || null, status: status || 'open',
    });
    return this.findById(lastInsertRowid);
  },

  update(id, fields) {
    const current = stmtFindByIdRaw.get(id);
    if (!current) return null;
    const m = { ...current, ...fields };
    stmtUpdate.run({ id: Number(id), name: m.name, city: m.city, country: m.country,
             date_start: m.date_start, date_end: m.date_end, organizer: m.organizer,
             description: m.description, level: m.level, status: m.status,
             archived: m.archived ?? 0 });
    return this.findById(id);
  },

  delete(id) {
    return stmtDelete.run(id);
  },
};

module.exports = Tournament;
