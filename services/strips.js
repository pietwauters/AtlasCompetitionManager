'use strict';
const db = require('../db');

const stmtFindAll = db.prepare(`
  SELECT * FROM strips ORDER BY strip_number ASC
`);
const stmtFindById = db.prepare('SELECT * FROM strips WHERE id = ?');
const stmtCreate = db.prepare(`
  INSERT INTO strips (name, strip_number, status, network_state)
  VALUES (@name, @strip_number, 'idle', 'offline')
`);
const stmtUpdate = db.prepare(`
  UPDATE strips SET name=@name, strip_number=@strip_number,
    status=@status, network_state=@network_state,
    pools_allowed=@pools_allowed, de_allowed=@de_allowed,
    max_de_tableau=@max_de_tableau, min_de_tableau=@min_de_tableau
  WHERE id=@id
`);
const stmtDelete = db.prepare('DELETE FROM strips WHERE id = ?');

const Strip = {
  findAll() {
    return stmtFindAll.all();
  },

  findById(id) {
    return stmtFindById.get(id);
  },

  create({ name, strip_number }) {
    if (!strip_number) throw new Error('strip_number is required');
    const { lastInsertRowid } = stmtCreate.run({ name: name || null, strip_number: Number(strip_number) });
    return this.findById(lastInsertRowid);
  },

  update(id, fields) {
    const current = this.findById(id);
    if (!current) return null;
    const m = { ...current, ...fields };
    stmtUpdate.run({
      id: Number(id), name: m.name, strip_number: m.strip_number,
      status: m.status, network_state: m.network_state,
      pools_allowed: m.pools_allowed ? 1 : 0,
      de_allowed: m.de_allowed ? 1 : 0,
      max_de_tableau: m.max_de_tableau === '' || m.max_de_tableau == null ? null : Number(m.max_de_tableau),
      min_de_tableau: m.min_de_tableau === '' || m.min_de_tableau == null ? null : Number(m.min_de_tableau),
    });
    return this.findById(id);
  },

  delete(id) {
    return stmtDelete.run(id);
  },
};

module.exports = Strip;
