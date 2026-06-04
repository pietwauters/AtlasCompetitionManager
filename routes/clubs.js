'use strict';
const express = require('express');
const Club    = require('../services/clubs');

const router = express.Router();

router.get('/', (req, res) => {
  const withCounts = req.query.counts === '1';
  res.json(withCounts ? Club.findAllWithCounts() : Club.findAll());
});

router.get('/:id', (req, res) => {
  const club = Club.findById(req.params.id);
  if (!club) return res.status(404).json({ error: 'Club not found' });
  res.json(club);
});

router.post('/', (req, res) => {
  try {
    const club = Club.create(req.body);
    res.status(201).json(club);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const club = Club.update(req.params.id, req.body);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    res.json(club);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/merge', (req, res) => {
  try {
    const result = Club.merge(req.params.id, req.body.target_id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const result = Club.delete(req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Club not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
