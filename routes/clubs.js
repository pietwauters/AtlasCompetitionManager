'use strict';
const express = require('express');
const Club    = require('../services/clubs');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(Club.findAll());
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
  const club = Club.update(req.params.id, req.body);
  if (!club) return res.status(404).json({ error: 'Club not found' });
  res.json(club);
});

router.delete('/:id', (req, res) => {
  const result = Club.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Club not found' });
  res.json({ ok: true });
});

module.exports = router;
