'use strict';
const db   = require('../db');
const Bout = require('./bouts');
const { distributeBoutsToStrips } = require('../lib/multiStripPool');

const Pool = {
  findById(poolId) {
    const pool = db.prepare(`
      SELECT p.*,
        s.name AS strip_name,
        rp.first_name AS ref_first, rp.last_name AS ref_last
      FROM pools p
      LEFT JOIN strips   s  ON s.id  = p.strip_id
      LEFT JOIN referees r  ON r.id  = p.referee_id
      LEFT JOIN people   rp ON rp.id = r.person_id
      WHERE p.id = ?
    `).get(poolId);
    if (!pool) return null;

    // Competitors in this pool (ordered by initial_seed for display)
    pool.competitors = db.prepare(`
      SELECT
        c.id AS competitor_id, c.initial_seed,
        c.first_name, c.last_name, c.nationality,
        cl.name AS club_name
      FROM pool_competitors pc
      JOIN competitors c  ON c.id  = pc.competitor_id
      LEFT JOIN people p2 ON p2.id = c.person_id
      LEFT JOIN clubs  cl ON cl.id = p2.club_id
      WHERE pc.pool_id = ?
      ORDER BY c.initial_seed ASC, c.last_name
    `).all(poolId);

    pool.bouts = Bout.findByPool(poolId);

    // Progress
    pool.bouts_total    = pool.bouts.length;
    pool.bouts_complete = pool.bouts.filter(b => b.status === 'finished').length;

    return pool;
  },

  findByPhase(phaseId) {
    const pools = db.prepare(`
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
    `).all(phaseId);
    return pools;
  },

  // Distribute the pool's bouts across K strips and record the assignment.
  // stripIds: array of strip DB ids (length K); first element = primary strip.
  // dynamicReorder: boolean — enable in-flight reordering by OPP2 client.
  // Returns { strips: [{stripId, boutIds: [...]}], flags: [...] }.
  distributeToStrips(poolId, stripIds, dynamicReorder) {
    const K = stripIds.length;
    if (K < 1) throw new Error('At least one strip required');

    const bouts = db.prepare(
      'SELECT id, left_id, right_id, bout_order FROM bouts WHERE pool_id = ? ORDER BY bout_order'
    ).all(poolId);
    if (!bouts.length) throw new Error('Pool has no bouts');

    const pairs = bouts.map(b => [b.left_id, b.right_id]);
    const { strips: stripIdxArrays, flags } = distributeBoutsToStrips(pairs, K);

    db.transaction(() => {
      // Reset any previous distribution.
      db.prepare('UPDATE bouts SET strip_id = NULL WHERE pool_id = ?').run(poolId);
      db.prepare('DELETE FROM pool_rest_flags WHERE pool_id = ?').run(poolId);

      // Set strip_id on each bout.
      const setStrip = db.prepare('UPDATE bouts SET strip_id = ? WHERE id = ?');
      for (let k = 0; k < K; k++) {
        for (const idx of stripIdxArrays[k]) {
          setStrip.run(stripIds[k], bouts[idx].id);
        }
      }

      // Record flags.
      const insertFlag = db.prepare(`
        INSERT INTO pool_rest_flags (pool_id, fencer_pos, prev_bout_id, next_bout_id)
        VALUES (?, ?, ?, ?)
      `);
      for (const f of flags) {
        insertFlag.run(
          poolId,
          typeof f.token === 'number' ? f.token : 0,
          bouts[f.prevBoutIdx]?.id ?? null,
          bouts[f.nextBoutIdx]?.id ?? null
        );
      }

      // Update pool metadata.
      db.prepare('UPDATE pools SET strip_count = ?, dynamic_reorder = ? WHERE id = ?')
        .run(K, dynamicReorder ? 1 : 0, poolId);
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
    return db.prepare(`
      SELECT f.*, pb.bout_order AS prev_order, nb.bout_order AS next_order
      FROM pool_rest_flags f
      LEFT JOIN bouts pb ON pb.id = f.prev_bout_id
      LEFT JOIN bouts nb ON nb.id = f.next_bout_id
      WHERE f.pool_id = ?
    `).all(poolId);
  },

  // Only referee_id is a direct pool attribute. Strip assignment is owned
  // by the pipeline — use Pipeline.addSlot / Pipeline.deleteSlot for that.
  update(poolId, data) {
    const current = db.prepare('SELECT * FROM pools WHERE id = ?').get(poolId);
    if (!current) return null;
    const newRefId = 'referee_id' in data ? (data.referee_id ?? null) : current.referee_id;
    db.prepare('UPDATE pools SET referee_id = ? WHERE id = ?').run(newRefId, Number(poolId));
    return this.findById(poolId);
  },
};

module.exports = Pool;
