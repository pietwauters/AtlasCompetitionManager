'use strict';
const express = require('express');
const Format  = require('../services/formats');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(Format.listFormats());
});

module.exports = router;
