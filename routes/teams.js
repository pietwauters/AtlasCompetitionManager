'use strict';

const express = require('express');
const Team    = require('../services/teams');

// Mounted at /api/competitions/:compId/teams (mergeParams = true)
const router = express.Router({ mergeParams: true });

router.get('/', (req, res) => {
  res.json(Team.findAll(req.params.compId));
});

router.post('/', (req, res) => {
  try {
    const team = Team.create(req.params.compId, {
      name:   req.body.name,
      clubId: req.body.club_id ?? null,
    });
    res.status(201).json(team);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/results', (req, res) => {
  const teams = Team.findAll(req.params.compId)
    .filter(t => t.final_rank != null)
    .sort((a, b) => a.final_rank - b.final_rank);
  res.json(teams);
});

router.post('/auto-seed', (req, res) => {
  try {
    Team.autoSeed(req.params.compId);
    res.json(Team.findAll(req.params.compId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  const t = Team.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Team not found' });
  res.json(t);
});

router.patch('/:id', (req, res) => {
  try {
    res.json(Team.update(req.params.id, req.body));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    Team.delete(req.params.id);
    res.status(204).end();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/:id/members', (req, res) => {
  try {
    const team = Team.addMember(req.params.id, req.body.competitor_id, req.body.role);
    res.status(201).json(team);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/:id/members/:competitorId', (req, res) => {
  try {
    Team.removeMember(req.params.id, req.params.competitorId);
    res.status(204).end();
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
