'use strict';
const express = require('express');
const Noc     = require('../services/nocs');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(Noc.findAll());
});

module.exports = router;
