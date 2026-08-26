'use strict';
const express = require('express');
const Phase   = require('../services/phases');
const SchedulePlanReconcile = require('../services/schedulePlanReconcile');
const PipelineVirtualSlots  = require('../services/pipelineVirtualSlots');

// mergeParams gives access to :compId from the parent route
const router = express.Router({ mergeParams: true });

// Auto-applies a matching schedule-plan stage's strip assignment the instant a
// real phase is created — see services/schedulePlanReconcile.js. Must never
// break phase creation: null (no plan matched, the ordinary case) or a genuine
// reconciliation error are both swallowed here and only ever logged.
function applySchedulePlanIfAny(phase) {
  try {
    return SchedulePlanReconcile.applyPhaseIfPlanned(phase);
  } catch (err) {
    console.error('[schedule-plan] auto-apply error for phase', phase.id, ':', err.message);
    return null;
  }
}

// Fills in any virtual (placeholder) pipeline_slots that were pre-assigned to
// this stage before the phase existed — see services/pipelineVirtualSlots.js.
// A distinct, complementary mechanism from applySchedulePlanIfAny above (that
// one materializes a separate what-if plan; this one activates already-live
// slots a director placed directly in opp2.html) — same swallow-and-log
// requirement, never allowed to block phase creation.
function applyVirtualSlotsIfAny(phase) {
  try {
    return PipelineVirtualSlots.applyToPhase(phase);
  } catch (err) {
    console.error('[virtual-slots] auto-activate error for phase', phase.id, ':', err.message);
    return null;
  }
}

// Seeds any DE bracket skeleton whose dependency this closing phase might
// have just satisfied — see services/phases.js's autoSeedSkeletonsIfAny
// (shared with routes/phasesById.js's own close route, since phase.html/
// pool.html close through that one instead of this nested route).
const autoSeedSkeletonsIfAny = (closedPhaseId) => Phase.autoSeedSkeletonsIfAny(closedPhaseId);

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
    res.status(201).json({
      ...phase,
      schedule_plan_applied: applySchedulePlanIfAny(phase),
      virtual_slots_applied: applyVirtualSlotsIfAny(phase),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Build a DE bracket now, from an estimated headcount, before the prior
// stage has finished — see services/dePhases.js's createSkeleton.
// Body: { rule_doc, estimated_n, format_stage_id }
router.post('/create-de-skeleton', (req, res) => {
  const { rule_doc, estimated_n, format_stage_id } = req.body;
  if (!rule_doc || !format_stage_id) {
    return res.status(400).json({ error: 'rule_doc and format_stage_id required' });
  }
  try {
    const phase = Phase.createSkeleton(req.params.compId, rule_doc, estimated_n, format_stage_id);
    // A skeleton is a real phase (real phase_id/tableau/round-1 bout rows)
    // the instant it's created — so, same as real createDE/create above, any
    // schedule-plan or virtual placeholder already sitting on this exact
    // stage can (and should) be picked up right now, not left orphaned.
    // Most relevant in practice for virtual DE placeholders created before
    // this route existed / before the UI stopped offering "Planned" for DE
    // stages in favor of skeleton creation.
    res.status(201).json({
      ...phase,
      schedule_plan_applied: applySchedulePlanIfAny(phase),
      virtual_slots_applied: applyVirtualSlotsIfAny(phase),
    });
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
    res.status(201).json({
      ...phase,
      schedule_plan_applied: applySchedulePlanIfAny(phase),
      virtual_slots_applied: applyVirtualSlotsIfAny(phase),
    });
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
    res.json({ ...result, de_skeletons_seeded: autoSeedSkeletonsIfAny(req.params.id) });
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
