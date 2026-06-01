'use strict';
const express  = require('express');
const Pool     = require('../services/pools');
const Bout     = require('../services/bouts');
const Pipeline = require('../services/pipeline');
const SSE      = require('../lib/sse');

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
// strip_id routes through Pipeline (single source of truth).
// referee_id is a direct pool attribute.
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

module.exports = router;
