'use strict';
const express = require('express');
const Strip   = require('../services/strips');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(Strip.findAll());
});

router.get('/:id', (req, res) => {
  const s = Strip.findById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Strip not found' });
  res.json(s);
});

router.post('/', (req, res) => {
  try {
    const s = Strip.create(req.body);
    res.status(201).json(s);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  const s = Strip.update(req.params.id, req.body);
  if (!s) return res.status(404).json({ error: 'Strip not found' });
  res.json(s);
});

router.delete('/:id', (req, res) => {
  const result = Strip.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Strip not found' });
  res.json({ ok: true });
});

module.exports = router;
