'use strict';
const db = require('../db');

const Noc = {
  findAll() {
    return db.prepare('SELECT code, country FROM nocs ORDER BY country').all();
  },

  findByCode(code) {
    return db.prepare('SELECT code, country FROM nocs WHERE code = ?').get(code);
  },
};

module.exports = Noc;
