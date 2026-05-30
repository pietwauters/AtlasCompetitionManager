"use strict";

const express = require('express');
const router  = express.Router();
const db      = require('../db/db');

// ---------------------------------------------------------------------------
// GET /api/tournaments — list all tournaments
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
  const models = req.app.get('models');
  try {
    const rows = await models.Tournament.findAll({
      order: [['date_start', 'DESC'], ['id', 'DESC']]
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tournaments — create a tournament
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { name, city, country, date_start, date_end, organizer, description, level, status } = req.body;
  if (!name || !city || !country) return res.status(400).json({ error: 'name, city, country required' });
  try {
    const t = await req.app.get('models').Tournament.create({
      name, city, country, date_start, date_end, organizer, description, level, status: status ?? 'open'
    });
    res.status(201).json({ id: t.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tournaments/:id — get tournament detail
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  const models = req.app.get('models');
  const t = await models.Tournament.findByPk(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  // List competitions for this tournament
  const competitions = await models.Competition.findAll({ where: { tournament_id: t.id } });
  res.json({ ...t.toJSON(), competitions });
});

// ---------------------------------------------------------------------------
// PATCH /api/tournaments/:id — update tournament
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  const models = req.app.get('models');
  const t = await models.Tournament.findByPk(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  const { name, city, country, date_start, date_end, organizer, description, level, status, archived } = req.body;
  await t.update({
    name: name ?? t.name,
    city: city ?? t.city,
    country: country ?? t.country,
    date_start: date_start ?? t.date_start,
    date_end: date_end ?? t.date_end,
    organizer: organizer ?? t.organizer,
    description: description ?? t.description,
    level: level ?? t.level,
    status: status ?? t.status,
    archived: archived ?? t.archived
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/tournaments/:id — delete tournament
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const models = req.app.get('models');
  const t = await models.Tournament.findByPk(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  const competitions = await models.Competition.findAll({ where: { tournament_id: t.id }, attributes: ['id'] });
  if (competitions.length > 0) {
    const deleteComps = req.query.delete_competitions === 'true' || req.body?.delete_competitions === true;
    if (!deleteComps) {
      return res.status(409).json({ error: 'Tournament has linked competitions', competitions: competitions.map(c => c.id) });
    }
    await models.Competition.destroy({ where: { tournament_id: t.id } });
  }
  await t.destroy();
  res.json({ ok: true });
});

module.exports = router;
