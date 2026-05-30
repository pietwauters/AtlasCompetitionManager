'use strict';
const db   = require('../db');
const Bout = require('./bouts');

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
        p2.first_name, p2.last_name, p2.nationality,
        cl.name AS club_name
      FROM pool_competitors pc
      JOIN competitors c  ON c.id  = pc.competitor_id
      JOIN fencers     f  ON f.id  = c.fencer_id
      JOIN people      p2 ON p2.id = f.person_id
      LEFT JOIN clubs  cl ON cl.id = p2.club_id
      WHERE pc.pool_id = ?
      ORDER BY c.initial_seed ASC, p2.last_name
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

  update(poolId, { strip_id, referee_id }) {
    const current = db.prepare('SELECT * FROM pools WHERE id = ?').get(poolId);
    if (!current) return null;
    db.prepare(`
      UPDATE pools
      SET strip_id   = COALESCE(@strip_id,   strip_id),
          referee_id = COALESCE(@referee_id, referee_id)
      WHERE id = @id
    `).run({ id: Number(poolId), strip_id: strip_id ?? null, referee_id: referee_id ?? null });
    return this.findById(poolId);
  },
};

module.exports = Pool;
