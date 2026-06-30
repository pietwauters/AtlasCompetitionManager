'use strict';
const express = require('express');
const Phase   = require('../services/phases');

// mergeParams gives access to :compId from the parent route
const router = express.Router({ mergeParams: true });

router.get('/', (req, res) => {
  res.json(Phase.findByCompetition(req.params.compId));
});

// Static paths — must come before /:id
router.get('/pool-options', (req, res) => {
  const { rule_doc, format_stage_id } = req.query;
  if (!rule_doc) return res.status(400).json({ error: 'rule_doc query param required' });
  try {
    res.json(Phase.calcOptions(req.params.compId, rule_doc, format_stage_id || null));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/de-options', (req, res) => {
  try {
    res.json(Phase.getDeOptions(req.params.compId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/create-de', (req, res) => {
  const { rule_doc, seeding_method, format_stage_id } = req.body;
  if (!rule_doc) return res.status(400).json({ error: 'rule_doc required' });
  try {
    const phase = Phase.createDE(req.params.compId, rule_doc, seeding_method || 'last', format_stage_id || null);
    res.status(201).json(phase);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  const p = Phase.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Phase not found' });
  res.json(p);
});

// Create pool phase.
// Body: { rule_doc, chosen_sizes: [7, 7, 6], separation?: ['club'], format_stage_id?: 'preliminary_pools' }
router.post('/', (req, res) => {
  const { rule_doc, chosen_sizes, separation, format_stage_id } = req.body;
  if (!rule_doc || !chosen_sizes?.length) {
    return res.status(400).json({ error: 'rule_doc and chosen_sizes required' });
  }
  try {
    const phase = Phase.create(req.params.compId, rule_doc, chosen_sizes, separation, format_stage_id || null);
    res.status(201).json(phase);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Get live rankings (without saving)
router.get('/:id/rankings', (req, res) => {
  res.json(Phase.calculateRankings(req.params.id));
});

// Close phase: save rankings + apply advancement.
// Body (optional): { method, value, multipleOf } — overrides rule's advancement
router.post('/:id/close', (req, res) => {
  try {
    const result = Phase.close(req.params.id, req.body?.method ? req.body : null);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/:id/reopen', (req, res) => {
  try {
    Phase.reopen(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    Phase.delete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
