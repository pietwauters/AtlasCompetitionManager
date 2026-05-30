'use strict';
const express          = require('express');
const { listRules }    = require('../lib/rules');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(listRules(req.query.type || null));
});

module.exports = router;
