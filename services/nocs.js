'use strict';
const db = require('../db');

const stmtFindAll = db.prepare('SELECT code, country FROM nocs ORDER BY country');
const stmtFindByCode = db.prepare('SELECT code, country FROM nocs WHERE code = ?');

const Noc = {
  findAll() {
    return stmtFindAll.all();
  },

  findByCode(code) {
    return stmtFindByCode.get(code);
  },
};

module.exports = Noc;
