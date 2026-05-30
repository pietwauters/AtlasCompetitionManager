// phasesViews.js — View-rendering routes for phases (EJS/pages)
// Handles all view-rendering routes for phases. API logic is in phases.js.

const express = require('express');
const router = express.Router();
const db = require('../db/db');
const path = require('path');

// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/phases/:phaseId/pools/:poolId/view — render pool entry page (EJS)
// Renders: pool.ejs with compId, phase, pool
// ---------------------------------------------------------------------------
router.get('/api/competitions/:comp_id/phases/:phase_id/pools/:pool_id/view', async (req, res) => {
  const { comp_id, phase_id, pool_id } = req.params;
  const models = req.app.get('models');
  const phase = await models.Phase.findOne({ where: { id: phase_id, competition_id: comp_id } });
  if (!phase) return res.status(404).send('Phase not found');

  const pool = await models.Pool.findOne({ where: { id: pool_id, phase_id: phase_id } });
  if (!pool) return res.status(404).send('Pool not found');

  // ...fetch fencers, bouts, etc. as in original code...
  res.render('pool', { comp_id, phase, pool });
});

// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/phases/:phaseId/view — render phase page (EJS)
// Renders: phase.ejs with compId, phase, pools, rankings, strips
// ---------------------------------------------------------------------------
router.get('/api/competitions/:comp_id/phases/:phase_id/view', async (req, res) => {
  const { comp_id, phase_id } = req.params;
  const models = req.app.get('models');
  const phase = await models.Phase.findOne({ where: { id: phase_id, competition_id: comp_id } });
  if (!phase) return res.status(404).send('Phase not found');

  // Fetch pools, strips, rankings as in original code...
  // const pools = ...
  // const strips = ...
  // const rankings = ...
  res.render('phase', { comp_id, phase: { ...phase.toJSON(), pools: [] }, rankings: [], strips: [] });
});

module.exports = router;
