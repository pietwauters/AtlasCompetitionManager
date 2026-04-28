"use strict";

const express = require('express');
const router  = express.Router();
const models  = require('../models');

const VALID_WEAPONS = ['foil', 'epee', 'sabre'];
const VALID_GENDERS = ['M', 'F', 'X'];
const VALID_STATUSES = ['draft', 'active', 'finished'];

// ---------------------------------------------------------------------------
// POST /api/competitions/:id/finish — finish the competition, mark all active as finished
// ---------------------------------------------------------------------------
router.post('/:id/finish', (req, res) => {
  const compId = req.params.id;
  // Mark all active competitors as finished
  const active = db.prepare('SELECT id FROM competitors WHERE competition_id = ? AND status = ?').all(compId, 'active');
  let nextRank = 1;
  for (const f of active) {
    db.prepare('UPDATE competitors SET status = ?, final_rank = ? WHERE id = ?')
      .run('finished', nextRank, f.id);
    nextRank++;
  }
  db.prepare('UPDATE competitions SET status = ? WHERE id = ?').run('finished', compId);
  res.json({ finished: true, competitors: active.length });
});


// ---------------------------------------------------------------------------
// GET /api/competitions — list all competitions, newest first
// ---------------------------------------------------------------------------
router.get('/', async (_req, res) => {
  try {
    const competitions = await models.Competition.findAll({
      order: [['created_at', 'DESC']]
    });
    res.json(competitions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/competitions — create a competition
// ---------------------------------------------------------------------------

// Allow tournament_id to be set if provided
router.post('/', async (req, res) => {
  const { name, weapon, gender, status, date } = req.body;

  if (!name || !name.trim())             return res.status(400).json({ error: 'name is required' });
  if (!VALID_WEAPONS.includes(weapon))   return res.status(400).json({ error: 'weapon must be foil, epee or sabre' });
  if (!VALID_GENDERS.includes(gender))   return res.status(400).json({ error: 'gender must be M, F or X' });

  try {
    const competition = await models.Competition.create({
      name: name.trim(),
      weapon,
      gender,
      status: status || 'draft',
      date: date || null
    });
    res.status(201).json({ id: competition.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/competitions/:id — single competition detail
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const comp = await models.Competition.findByPk(req.params.id);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });
    // Optionally, add related data here (e.g., phases, competitor count) if migrated to Sequelize
    res.json(comp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/competitions/:id — update status or name
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  try {
    const comp = await models.Competition.findByPk(req.params.id);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });

    const { name, status, date } = req.body;
    if (status && !VALID_STATUSES.includes(status))
      return res.status(400).json({ error: 'Invalid status' });

    if (name !== undefined) comp.name = name;
    if (status !== undefined) comp.status = status;
    if (date !== undefined) comp.date = date;
    await comp.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/competitions/:id — only allowed when draft
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const comp = await models.Competition.findByPk(req.params.id);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });
    if (comp.status !== 'draft' && comp.status !== 'finished') return res.status(409).json({ error: 'Only draft or finished competitions can be deleted' });
    await comp.destroy();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
