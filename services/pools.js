'use strict';
const db       = require('../db');
const Bout     = require('./bouts');
const Pipeline = require('./pipeline');
const { distributeBoutsToStrips } = require('../lib/multiStripPool');

const stmtFindById = db.prepare(`
  SELECT p.*,
    s.name AS strip_name,
    rp.first_name AS ref_first, rp.last_name AS ref_last
  FROM pools p
  LEFT JOIN strips   s  ON s.id  = p.strip_id
  LEFT JOIN referees r  ON r.id  = p.referee_id
  LEFT JOIN people   rp ON rp.id = r.person_id
  WHERE p.id = ?
`);
const stmtCompetitorsForPool = db.prepare(`
  SELECT
    c.id AS competitor_id, c.initial_seed,
    c.first_name, c.last_name, c.nationality,
    p2.club_id, cl.name AS club_name
  FROM pool_competitors pc
  JOIN competitors c  ON c.id  = pc.competitor_id
  LEFT JOIN people p2 ON p2.id = c.person_id
  LEFT JOIN clubs  cl ON cl.id = p2.club_id
  WHERE pc.pool_id = ?
  ORDER BY c.initial_seed ASC, c.last_name
`);
const stmtFindByPhase = db.prepare(`
  SELECT p.*,
    s.name AS strip_name,
    rp.first_name AS ref_first, rp.last_name AS ref_last,
    COUNT(b.id)                                         AS bouts_total,
    SUM(CASE WHEN b.status='finished' THEN 1 ELSE 0 END) AS bouts_complete
  FROM pools p
  LEFT JOIN strips   s  ON s.id  = p.strip_id
  LEFT JOIN referees r  ON r.id  = p.referee_id
  LEFT JOIN people   rp ON rp.id = r.person_id
  LEFT JOIN bouts    b  ON b.pool_id = p.id
  WHERE p.phase_id = ?
  GROUP BY p.id
  ORDER BY p.pool_number
`);
const stmtBoutsForDistribution = db.prepare(
  'SELECT id, left_id, right_id, bout_order FROM bouts WHERE pool_id = ? ORDER BY bout_order'
);
const stmtResetBoutStrips = db.prepare('UPDATE bouts SET strip_id = NULL WHERE pool_id = ?');
const stmtDeleteRestFlags = db.prepare('DELETE FROM pool_rest_flags WHERE pool_id = ?');
const stmtSetBoutStrip = db.prepare('UPDATE bouts SET strip_id = ? WHERE id = ?');
const stmtInsertRestFlag = db.prepare(`
  INSERT INTO pool_rest_flags (pool_id, fencer_pos, prev_bout_id, next_bout_id)
  VALUES (?, ?, ?, ?)
`);
const stmtSetPoolStripMeta = db.prepare('UPDATE pools SET strip_count = ?, dynamic_reorder = ? WHERE id = ?');
const stmtRestFlags = db.prepare(`
  SELECT f.*, pb.bout_order AS prev_order, nb.bout_order AS next_order
  FROM pool_rest_flags f
  LEFT JOIN bouts pb ON pb.id = f.prev_bout_id
  LEFT JOIN bouts nb ON nb.id = f.next_bout_id
  WHERE f.pool_id = ?
`);
const stmtRawById = db.prepare('SELECT * FROM pools WHERE id = ?');
const stmtSetRefereeId = db.prepare('UPDATE pools SET referee_id = ? WHERE id = ?');
const stmtSlotsForPool = db.prepare('SELECT id FROM pipeline_slots WHERE pool_id = ?');

const Pool = {
  findById(poolId) {
    const pool = stmtFindById.get(poolId);
    if (!pool) return null;

    // Competitors in this pool (ordered by initial_seed for display)
    pool.competitors = stmtCompetitorsForPool.all(poolId);

    pool.bouts = Bout.findByPool(poolId);

    // Progress
    pool.bouts_total    = pool.bouts.length;
    pool.bouts_complete = pool.bouts.filter(b => b.status === 'finished').length;

    return pool;
  },

  findByPhase(phaseId) {
    return stmtFindByPhase.all(phaseId);
  },

  // Distribute the pool's bouts across K strips and record the assignment.
  // stripIds: array of strip DB ids (length K); first element = primary strip.
  // dynamicReorder: boolean — enable in-flight reordering by OPP2 client.
  // Returns { strips: [{stripId, boutIds: [...]}], flags: [...] }.
  distributeToStrips(poolId, stripIds, dynamicReorder) {
    const K = stripIds.length;
    if (K < 1) throw new Error('At least one strip required');

    const bouts = stmtBoutsForDistribution.all(poolId);
    if (!bouts.length) throw new Error('Pool has no bouts');

    const pairs = bouts.map(b => [b.left_id, b.right_id]);
    const { strips: stripIdxArrays, flags } = distributeBoutsToStrips(pairs, K);

    db.transaction(() => {
      // Reset any previous distribution.
      stmtResetBoutStrips.run(poolId);
      stmtDeleteRestFlags.run(poolId);

      // Set strip_id on each bout.
      for (let k = 0; k < K; k++) {
        for (const idx of stripIdxArrays[k]) {
          stmtSetBoutStrip.run(stripIds[k], bouts[idx].id);
        }
      }

      // Record flags.
      for (const f of flags) {
        stmtInsertRestFlag.run(
          poolId,
          typeof f.token === 'number' ? f.token : 0,
          bouts[f.prevBoutIdx]?.id ?? null,
          bouts[f.nextBoutIdx]?.id ?? null
        );
      }

      // Update pool metadata.
      stmtSetPoolStripMeta.run(K, dynamicReorder ? 1 : 0, poolId);
    })();

    return {
      strips: stripIdxArrays.map((idxs, k) => ({
        stripId: stripIds[k],
        boutIds: idxs.map(i => bouts[i].id),
      })),
      flags,
    };
  },

  restFlags(poolId) {
    return stmtRestFlags.all(poolId);
  },

  // Undo a multi-strip distribution: clear each bout's strip_id, drop the
  // rest-flag rows, and reset the pool's own strip_count/dynamic_reorder
  // metadata. Reuses distributeToStrips' own reset statements so the two
  // code paths can't drift on what "reset" means. Wrapped in a transaction —
  // these three writes must succeed or fail together, or a mid-crash leaves
  // bouts.strip_id cleared but pools.strip_count stale (or vice versa).
  resetDistribution(poolId) {
    db.transaction(() => {
      stmtResetBoutStrips.run(poolId);
      stmtDeleteRestFlags.run(poolId);
      stmtSetPoolStripMeta.run(0, 0, poolId);
    })();
  },

  // Only referee_id is a direct pool attribute. Strip assignment is owned
  // by the pipeline — use Pipeline.addSlot / Pipeline.deleteSlot for that.
  //
  // pipeline_slots.referee_id is the value actually sent to the apparatus
  // over OPP2 and shown on the schedule/referee-schedule pages, so any
  // change to a pool's referee_id here is mirrored onto every pipeline slot
  // for this pool (there can be more than one, for a multi-strip pool) —
  // this is the data-layer invariant itself, not just something the PATCH
  // route happens to do, so any other caller (e.g. bulk auto-assignment)
  // gets it for free too.
  update(poolId, data) {
    const current = stmtRawById.get(poolId);
    if (!current) return null;
    const newRefId = 'referee_id' in data ? (data.referee_id ?? null) : current.referee_id;
    stmtSetRefereeId.run(newRefId, Number(poolId));

    if ('referee_id' in data) {
      const slots = stmtSlotsForPool.all(poolId);
      for (const slot of slots) {
        Pipeline.updateSlot(slot.id, { referee_id: newRefId });
      }
    }

    return this.findById(poolId);
  },
};

module.exports = Pool;
