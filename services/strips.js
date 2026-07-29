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
    status=@status, network_state=@network_state
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
    stmtUpdate.run({ id: Number(id), name: m.name, strip_number: m.strip_number,
             status: m.status, network_state: m.network_state });
    return this.findById(id);
  },

  delete(id) {
    return stmtDelete.run(id);
  },
};

module.exports = Strip;
