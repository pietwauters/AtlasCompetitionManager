'use strict';
const express     = require('express');
const Competition = require('../services/competitions');
const Competitor  = require('../services/competitors');
const AgeCategory = require('../services/ageCategories');
const Results     = require('../services/results');
const Event       = require('../services/events');
const SSE         = require('../lib/sse');
const Format      = require('../services/formats');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(Competition.findAll({ tournament_id: req.query.tournament_id }));
});

router.get('/active', (req, res) => {
  res.json(Competition.withLivePhases());
});

router.get('/:id', (req, res) => {
  const c = Competition.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Competition not found' });
  res.json(c);
});

router.post('/', (req, res) => {
  try {
    const c = Competition.create(req.body);
    res.status(201).json(c);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  const c = Competition.update(req.params.id, req.body);
  if (!c) return res.status(404).json({ error: 'Competition not found' });
  res.json(c);
});

router.post('/:id/archive', (req, res) => {
  const result = Competition.archive(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Competition not found' });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const result = Competition.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Competition not found' });
  res.json({ ok: true });
});

// Replace age categories: PUT /api/competitions/:id/age-categories
// Body: { category_ids: [1, 3] }
router.put('/:id/age-categories', (req, res) => {
  const c = Competition.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Competition not found' });
  Competition.setAgeCategories(req.params.id, req.body.category_ids || []);
  res.json(Competition.findById(req.params.id));
});

// Eligible fencers for a competition (filtered by gender, weapon, age).
router.get('/:id/eligible-fencers', (req, res) => {
  const c = Competition.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Competition not found' });
  res.json(Competitor.findEligible(req.params.id));
});

router.get('/:id/results', (req, res) => {
  try {
    res.json(Results.getCompetitionResults(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// SSE stream — pushes 'results-updated' whenever a bout in this competition is scored.
router.get('/:id/updates', (req, res) => {
  SSE.subscribe('comp_' + req.params.id, res);
});

// Format plan — stage statuses + projected participant counts
router.get('/:id/format-plan', (req, res) => {
  const c = Competition.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Competition not found' });
  if (!c.format_id) return res.status(404).json({ error: 'Competition has no format' });
  try {
    const format = Format.loadFormat(c.format_id);
    res.json(Format.getFormatPlan(req.params.id, format));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Validate that current competitor count is compatible with a format
router.post('/:id/validate-format', (req, res) => {
  const { format_id } = req.body;
  if (!format_id) return res.status(400).json({ error: 'format_id required' });
  try {
    const format = Format.loadFormat(format_id);
    Format.validateCounts(req.params.id, format);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// GET /api/competitions/:id/events[?event_type=card&phase_id=X&bout_id=Y]
router.get('/:id/events', (req, res) => {
  const c = Competition.findById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Competition not found' });
  const { event_type, phase_id, bout_id } = req.query;
  res.json(Event.findByCompetition(req.params.id, { event_type, phase_id, bout_id }));
});

module.exports = router;
