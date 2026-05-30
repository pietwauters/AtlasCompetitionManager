'use strict';
const db = require('../db');

const BASE = `
  SELECT b.*,
    lp.first_name AS left_first,  lp.last_name AS left_last,
    rp.first_name AS right_first, rp.last_name AS right_last
  FROM bouts b
  JOIN competitors lc ON lc.id = b.left_id
  JOIN fencers     lf ON lf.id = lc.fencer_id
  JOIN people      lp ON lp.id = lf.person_id
  JOIN competitors rc ON rc.id = b.right_id
  JOIN fencers     rf ON rf.id = rc.fencer_id
  JOIN people      rp ON rp.id = rf.person_id
`;

const Bout = {
  findById(id) {
    return db.prepare(`${BASE} WHERE b.id = ?`).get(id);
  },

  findByPool(poolId) {
    return db.prepare(`${BASE} WHERE b.pool_id = ? ORDER BY b.bout_order`).all(poolId);
  },

  findByPhase(phaseId) {
    return db.prepare(`${BASE} WHERE b.phase_id = ? ORDER BY b.pool_id, b.bout_order`).all(phaseId);
  },

  // Save current state to history, then apply new scores.
  // winnerId: explicit override for tied bouts. If scores differ, winner is auto-determined.
  updateScore(id, leftScore, rightScore, winnerId = null) {
    const current = db.prepare('SELECT * FROM bouts WHERE id = ?').get(id);
    if (!current) return null;

    // Snapshot before change
    db.prepare(`
      INSERT INTO bout_history (bout_id, left_score, right_score, winner_id, status)
      VALUES (@bout_id, @left_score, @right_score, @winner_id, @status)
    `).run({
      bout_id: id,
      left_score:  current.left_score,
      right_score: current.right_score,
      winner_id:   current.winner_id,
      status:      current.status,
    });

    const ls = leftScore  != null ? Number(leftScore)  : null;
    const rs = rightScore != null ? Number(rightScore) : null;

    let winner = null;
    if (ls !== null && rs !== null) {
      if (ls > rs)       winner = current.left_id;
      else if (rs > ls)  winner = current.right_id;
      else if (winnerId) winner = Number(winnerId);   // explicit tie-break
    }

    const status = (ls !== null && rs !== null) ? 'finished' : 'pending';

    db.prepare(`
      UPDATE bouts SET left_score=@ls, right_score=@rs, winner_id=@winner, status=@status
      WHERE id=@id
    `).run({ id, ls, rs, winner, status });

    return this.findById(id);
  },

  // Restore last history snapshot and delete it.
  undo(id) {
    const hist = db.prepare(
      'SELECT * FROM bout_history WHERE bout_id = ? ORDER BY id DESC LIMIT 1'
    ).get(id);
    if (!hist) return null;

    db.prepare(`
      UPDATE bouts SET left_score=@left_score, right_score=@right_score,
                       winner_id=@winner_id, status=@status
      WHERE id=@bout_id
    `).run(hist);
    db.prepare('DELETE FROM bout_history WHERE id = ?').run(hist.id);

    return this.findById(id);
  },
};

module.exports = Bout;
