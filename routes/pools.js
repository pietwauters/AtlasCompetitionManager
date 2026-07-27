'use strict';
const express  = require('express');
const Pool     = require('../services/pools');
const Bout     = require('../services/bouts');
const Pipeline = require('../services/pipeline');
const SSE      = require('../lib/sse');
const db       = require('../db');

const router = express.Router();

router.get('/:id/events', (req, res) => {
  SSE.subscribe(req.params.id, res);
});

router.get('/:id', (req, res) => {
  const pool = Pool.findById(req.params.id);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });
  res.json(pool);
});

// Assign strip and/or referee to a pool.
// Body: { strip_id?, referee_id? }
// strip_id routes through Pipeline (single source of truth). referee_id is a
// direct pool attribute; Pool.update mirrors it onto every pipeline slot for
// this pool so pipeline_slots.referee_id (what's actually sent to the
// apparatus over OPP2 and shown on the schedule pages) never drifts.
router.patch('/:id', (req, res) => {
  try {
    const pool = Pool.findById(req.params.id);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });

    if ('strip_id' in req.body) {
      const newStripId = req.body.strip_id ?? null;
      if (newStripId) {
        Pipeline.addSlot(newStripId, { type: 'pool', pool_id: pool.id });
      } else {
        const slot = Pipeline.findByPool(pool.id);
        if (slot) Pipeline.deleteSlot(slot.id);
      }
    }

    const updated = 'referee_id' in req.body
      ? Pool.update(req.params.id, { referee_id: req.body.referee_id })
      : Pool.findById(req.params.id);

    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Distribute pool bouts across multiple strips.
// Body: { strip_ids: [id, id, ...], dynamic_reorder?: bool }
// strip_ids[0] is the primary strip (must already have a pipeline slot for this pool).
// Additional strips get secondary pipeline slots created automatically.
router.post('/:id/distribute', (req, res) => {
  try {
    const pool = Pool.findById(req.params.id);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });

    const { strip_ids, dynamic_reorder = false } = req.body;
    if (!Array.isArray(strip_ids) || strip_ids.length < 1) {
      return res.status(400).json({ error: 'strip_ids must be a non-empty array' });
    }

    // Ensure all strips exist.
    for (const sid of strip_ids) {
      const s = db.prepare('SELECT id FROM strips WHERE id = ?').get(sid);
      if (!s) return res.status(400).json({ error: `Strip ${sid} not found` });
    }

    // Ensure primary strip has (or gets) a pipeline slot.
    const primarySlotExists = db.prepare(
      'SELECT id FROM pipeline_slots WHERE pool_id = ? AND strip_id = ?'
    ).get(pool.id, strip_ids[0]);
    if (!primarySlotExists) {
      Pipeline.addSlot(strip_ids[0], { type: 'pool', pool_id: pool.id });
    }

    // Create secondary pipeline slots for strips 2..N.
    for (let i = 1; i < strip_ids.length; i++) {
      const exists = db.prepare(
        'SELECT id FROM pipeline_slots WHERE pool_id = ? AND strip_id = ?'
      ).get(pool.id, strip_ids[i]);
      if (!exists) {
        Pipeline.addSlot(strip_ids[i], { type: 'pool', pool_id: pool.id, secondary: true });
        db.prepare('UPDATE strips SET status = ? WHERE id = ?').run('assigned', strip_ids[i]);
      }
    }

    // Remove slots for strips that are no longer in the list.
    const existingSlots = db.prepare(
      'SELECT id, strip_id FROM pipeline_slots WHERE pool_id = ?'
    ).all(pool.id);
    for (const slot of existingSlots) {
      if (!strip_ids.includes(slot.strip_id)) {
        Pipeline.deleteSlot(slot.id);
      }
    }

    const result = Pool.distributeToStrips(pool.id, strip_ids, dynamic_reorder);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Reset multi-strip distribution: remove secondary slots, clear strip_id on bouts.
router.delete('/:id/distribute', (req, res) => {
  try {
    const pool = Pool.findById(req.params.id);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });

    db.prepare('UPDATE bouts SET strip_id = NULL WHERE pool_id = ?').run(pool.id);
    db.prepare('DELETE FROM pool_rest_flags WHERE pool_id = ?').run(pool.id);
    db.prepare('UPDATE pools SET strip_count = 0, dynamic_reorder = 0 WHERE id = ?').run(pool.id);

    // Remove all pipeline slots except the primary (lowest slot_order).
    const slots = db.prepare(
      'SELECT id, strip_id FROM pipeline_slots WHERE pool_id = ? ORDER BY slot_order'
    ).all(pool.id);
    for (let i = 1; i < slots.length; i++) {
      Pipeline.deleteSlot(slots[i].id);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Rest flags for a pool (for display in the pipeline UI).
router.get('/:id/rest-flags', (req, res) => {
  const pool = Pool.findById(req.params.id);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });
  res.json(Pool.restFlags(req.params.id));
});

module.exports = router;
