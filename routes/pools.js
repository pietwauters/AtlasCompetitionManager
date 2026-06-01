'use strict';
const express = require('express');
const Pool    = require('../services/pools');
const Bout    = require('../services/bouts');
const SSE     = require('../lib/sse');

const router = express.Router();

router.get('/:id/events', (req, res) => {
  SSE.subscribe(req.params.id, res);
});

router.get('/:id', (req, res) => {
  const pool = Pool.findById(req.params.id);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });
  res.json(pool);
});

// Assign strip and/or referee to a pool.
// Body: { strip_id?, referee_id? }
router.patch('/:id', (req, res) => {
  const pool = Pool.update(req.params.id, req.body);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });
  res.json(pool);
});

module.exports = router;
