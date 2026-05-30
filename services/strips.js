'use strict';
const db = require('../db');

const Strip = {
  findAll() {
    return db.prepare(`
      SELECT * FROM strips ORDER BY strip_number ASC
    `).all();
  },

  findById(id) {
    return db.prepare('SELECT * FROM strips WHERE id = ?').get(id);
  },

  create({ name, strip_number }) {
    if (!strip_number) throw new Error('strip_number is required');
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO strips (name, strip_number, status, network_state)
      VALUES (@name, @strip_number, 'idle', 'offline')
    `).run({ name: name || null, strip_number: Number(strip_number) });
    return this.findById(lastInsertRowid);
  },

  update(id, fields) {
    const current = this.findById(id);
    if (!current) return null;
    const m = { ...current, ...fields };
    db.prepare(`
      UPDATE strips SET name=@name, strip_number=@strip_number,
        status=@status, network_state=@network_state
      WHERE id=@id
    `).run({ id: Number(id), name: m.name, strip_number: m.strip_number,
             status: m.status, network_state: m.network_state });
    return this.findById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM strips WHERE id = ?').run(id);
  },
};

module.exports = Strip;
