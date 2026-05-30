'use strict';
const express    = require('express');
const Tournament = require('../services/tournaments');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(Tournament.findAll());
});

router.get('/:id', (req, res) => {
  const t = Tournament.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  res.json(t);
});

router.post('/', (req, res) => {
  try {
    const t = Tournament.create(req.body);
    res.status(201).json(t);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  const t = Tournament.update(req.params.id, req.body);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  res.json(t);
});

router.delete('/:id', (req, res) => {
  const result = Tournament.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Tournament not found' });
  res.json({ ok: true });
});

module.exports = router;
