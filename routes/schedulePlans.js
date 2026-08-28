'use strict';
const express = require('express');
const SchedulePlans = require('../services/schedulePlans');

const router = express.Router();

// Get-or-create the tournament's one evolving plan, with its full stage/slot view.
router.get('/tournament/:tid', (req, res) => {
  try {
    const plan = SchedulePlans.getOrCreate(req.params.tid);
    res.json(SchedulePlans.findPlanView(plan.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Body: { day_start?, abstract_piste_count?, abstract_referee_count? }
router.patch('/:planId', (req, res) => {
  try {
    res.json(SchedulePlans.update(req.params.planId, req.body || {}));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Body: { competition_id, phase_type, label?, estimated_n?, pistes_assigned?, depends_on?, rule_doc? }
router.post('/:planId/stages', (req, res) => {
  try {
    res.status(201).json(SchedulePlans.addStage(req.params.planId, req.body || {}));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Creates/refreshes one stage per format.stages[] entry for a format-driven competition.
router.post('/:planId/sync-format/:competitionId', (req, res) => {
  try {
    res.json(SchedulePlans.syncStagesFromFormat(req.params.planId, req.params.competitionId));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Body: { day_start }. day_start null/'' clears the override (falls back to
// the plan's own day_start). Lets different competitions in the same plan
// start at different times (e.g. Sabre starting later than Foil/Epee).
router.put('/:planId/competition-starts/:competitionId', (req, res) => {
  try {
    res.json(SchedulePlans.setCompetitionStart(req.params.planId, req.params.competitionId, req.body?.day_start || null));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Body: { fixed_start?, buffer_after_minutes? } — either field omitted keeps
// its current value, null clears it. tableauSize is 0 for a pool stage's own
// single unit, or a real DE tableau size (T4, T8, ...) for one of its rounds.
router.put('/stages/:stageId/round-overrides/:tableauSize', (req, res) => {
  try {
    SchedulePlans.setRoundOverride(req.params.stageId, Number(req.params.tableauSize), req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Body: { competition_id?, from_tableau_size? }. competition_id falsy/absent
// clears the reservation for this strip (piste goes back to fully shared).
router.put('/:planId/piste-reservations/:stripId', (req, res) => {
  try {
    SchedulePlans.setPisteReservation(req.params.planId, req.params.stripId, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Body: { totalPistes }. Non-persisting "what if" query.
router.post('/:planId/preview-pistes', (req, res) => {
  try {
    const totalPistes = Number(req.body?.totalPistes);
    res.json(SchedulePlans.previewForPistes(req.params.planId, totalPistes));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Body: { deadline: 'HH:MM' }. Non-persisting "how many pistes" query.
router.post('/:planId/preview-deadline', (req, res) => {
  try {
    res.json(SchedulePlans.previewForDeadline(req.params.planId, req.body?.deadline));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// The persisting "make this the plan's current layout" action.
router.post('/:planId/resolve', (req, res) => {
  try {
    res.json(SchedulePlans.resolve(req.params.planId));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Body: { label?, estimated_n?, pistes_assigned?, depends_on?, rule_doc? }
router.patch('/stages/:stageId', (req, res) => {
  try {
    res.json(SchedulePlans.updateStage(req.params.stageId, req.body || {}));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.delete('/stages/:stageId', (req, res) => {
  SchedulePlans.removeStage(req.params.stageId);
  res.json({ ok: true });
});

router.post('/stages/:stageId/refresh-estimate', (req, res) => {
  try {
    res.json(SchedulePlans.refreshEstimateFromRegistrations(req.params.stageId));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

module.exports = router;
