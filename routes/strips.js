'use strict';
const express = require('express');
const Strip   = require('../services/strips');
const SSE     = require('../lib/sse');
const OPP2    = require('../lib/opp2Client');

const router = express.Router();

router.get('/events', (req, res) => {
  SSE.subscribe('__strips__', res);
  // Send current live state immediately so the page doesn't wait for the next change
  for (const piste of OPP2.status().pistes) {
    res.write(`event: piste-state\ndata: ${JSON.stringify(piste)}\n\n`);
  }
});

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
  const before = Strip.findById(req.params.id);
  if (!before) return res.status(404).json({ error: 'Strip not found' });
  const s = Strip.update(req.params.id, req.body);
  if (before.name !== s.name) OPP2.renamePiste(before.name, s.name);
  res.json(s);
});

router.delete('/:id', (req, res) => {
  const result = Strip.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Strip not found' });
  res.json({ ok: true });
});

module.exports = router;
