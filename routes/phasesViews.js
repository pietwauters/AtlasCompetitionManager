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
router.get('/api/competitions/:compId/phases/:phaseId/pools/:poolId/view', (req, res) => {
  const { compId, phaseId, poolId } = req.params;
  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) return res.status(404).send('Phase not found');

  const pool = db.prepare('SELECT * FROM pools WHERE id = ? AND phase_id = ?').get(poolId, phaseId);
  if (!pool) return res.status(404).send('Pool not found');

  // ...fetch fencers, bouts, etc. as in original code...
  res.render('pool', { compId, phase, pool });
});

// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/phases/:phaseId/view — render phase page (EJS)
// Renders: phase.ejs with compId, phase, pools, rankings, strips
// ---------------------------------------------------------------------------
router.get('/api/competitions/:compId/phases/:phaseId/view', (req, res) => {
  const { compId, phaseId } = req.params;
  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) return res.status(404).send('Phase not found');

  // Fetch pools, strips, rankings as in original code...
  // const pools = ...
  // const strips = ...
  // const rankings = ...
  res.render('phase', { compId, phase: { ...phase, pools: [] }, rankings: [], strips: [] });
});

module.exports = router;
