'use strict';
const express     = require('express');
const OPP2        = require('../lib/opp2Client');
const Settings    = require('../services/settings');
const Pipeline    = require('../services/pipeline');
const CardReason  = require('../services/cardReasons');
const SSE         = require('../lib/sse');
const auth        = require('../middleware/auth');

const adminOnly = auth.require('admin');

const router = express.Router();

// ── Broker settings ──────────────────────────────────────────────────────────

router.get('/settings', (req, res) => {
  res.json({
    broker_url:        Settings.get('opp2_broker_url'),
    enabled:           Settings.get('opp2_enabled') === '1',
    auto_next_on_end:  Settings.get('opp2_auto_next_on_end') === '1',
  });
});

router.put('/settings', adminOnly, (req, res) => {
  const { broker_url, enabled, auto_next_on_end } = req.body;
  if (broker_url       !== undefined) Settings.set('opp2_broker_url', broker_url);
  if (enabled          !== undefined) Settings.set('opp2_enabled', enabled ? '1' : '0');
  if (auto_next_on_end !== undefined) Settings.set('opp2_auto_next_on_end', auto_next_on_end ? '1' : '0');
  res.json({ ok: true });
});

// ── Connection control ───────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  res.json(OPP2.status());
});

router.get('/piste-events', (req, res) => {
  SSE.subscribe('__strips__', res);
});

router.post('/connect', adminOnly, async (req, res) => {
  const url = req.body?.broker_url || Settings.get('opp2_broker_url');
  try {
    await OPP2.connect(url);
    Settings.set('opp2_enabled', '1');
    Settings.set('opp2_broker_url', url);
    res.json({ ok: true, broker_url: url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/disconnect', adminOnly, (req, res) => {
  OPP2.disconnect();
  Settings.set('opp2_enabled', '0');
  res.json({ ok: true });
});

// ── Pipeline CRUD ────────────────────────────────────────────────────────────

// All strips with pipelines (used by admin page)
router.get('/pipeline', (req, res) => {
  res.json(Pipeline.findAllStrips());
});

// Slots for a specific strip
router.get('/pipeline/strip/:stripId', (req, res) => {
  res.json(Pipeline.findByStrip(req.params.stripId));
});

// DE slots for a specific phase — used by de.html to show round assignments
router.get('/pipeline/phase/:phaseId', (req, res) => {
  res.json(Pipeline.findByPhase(req.params.phaseId));
});

// Referee schedule (derived view)
router.get('/pipeline/referee/:refereeId', (req, res) => {
  res.json(Pipeline.findAllForReferee(req.params.refereeId));
});

// Add a slot to a strip's pipeline
router.post('/pipeline/strip/:stripId', (req, res) => {
  try {
    const slot = Pipeline.addSlot(req.params.stripId, req.body);
    res.status(201).json(slot);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Update a slot (scheduled_start, minutes_per_bout, referee_id, status)
router.patch('/pipeline/slots/:id', (req, res) => {
  const slot = Pipeline.updateSlot(req.params.id, req.body);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  res.json(slot);
});

// Reorder a slot (move up or down)
router.post('/pipeline/slots/:id/reorder', (req, res) => {
  const { direction } = req.body;
  if (direction !== 'up' && direction !== 'down')
    return res.status(400).json({ error: 'direction must be up or down' });
  const ok = Pipeline.reorder(req.params.id, direction);
  if (!ok) return res.status(404).json({ error: 'Cannot move slot in that direction' });
  res.json({ ok: true });
});

// Delete a slot
router.delete('/pipeline/slots/:id', (req, res) => {
  const ok = Pipeline.deleteSlot(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Slot not found' });
  res.json({ ok: true });
});

// Card reasons for the current bout on a piste (read by the scoresheet page)
router.get('/piste/:pisteId/card-reasons', (req, res) => {
  res.json(CardReason.findByPiste(req.params.pisteId));
});

module.exports = router;
