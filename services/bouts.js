'use strict';
const db = require('../db');

const BASE = `
  SELECT b.*, ph.competition_id,
    lc.first_name AS left_first,  lc.last_name AS left_last,
    rc.first_name AS right_first, rc.last_name AS right_last
  FROM bouts b
  LEFT JOIN phases      ph ON ph.id = b.phase_id
  LEFT JOIN competitors lc ON lc.id = b.left_id
  LEFT JOIN competitors rc ON rc.id = b.right_id
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
      else if (winnerId) winner = Number(winnerId);
    }

    const status = (ls !== null && rs !== null) ? 'finished' : 'pending';

    db.prepare(`
      UPDATE bouts SET left_score=@ls, right_score=@rs, winner_id=@winner, status=@status
      WHERE id=@id
    `).run({ id, ls, rs, winner, status });

    const bout = this.findById(id);
    let next = null, placement = null, cascaded = [];
    if (status === 'finished') {
      const routed = this.routeBoutResult(id);
      next      = routed.winnerNext;
      placement = routed.loserNext;
      cascaded  = routed.cascaded;
    }
    return { bout, next, placement, cascaded };
  },

  // Route the winner and loser of a finished bout to their next slots using the
  // pre-computed routing pointers.  Falls back to arithmetic routing for main-bracket
  // bouts created before migration 014 (winner_next_bout_id IS NULL).
  routeBoutResult(boutId) {
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ?').get(boutId);
    if (!bout || bout.status !== 'finished') return { winnerNext: null, loserNext: null, cascaded: [] };

    const loserId = bout.winner_id === bout.left_id ? bout.right_id : bout.left_id;

    let winnerNext = null;
    let loserNext  = null;
    const cascaded = [];

    if (bout.winner_next_bout_id) {
      // Pointer-based routing (new phases)
      const col = bout.winner_next_side === 'left' ? 'left_id' : 'right_id';
      if (bout.winner_id) {
        db.prepare(`UPDATE bouts SET ${col} = ? WHERE id = ?`)
          .run(bout.winner_id, bout.winner_next_bout_id);
        winnerNext = this.findById(bout.winner_next_bout_id);
      }
    } else if (bout.bracket === 'main' && bout.de_round && bout.winner_id) {
      // Arithmetic fallback for pre-014 main-bracket bouts
      const nextRound = bout.de_round + 1;
      const nextPos   = Math.ceil(bout.tableau_position / 2);
      const nextBout  = db.prepare(
        `SELECT * FROM bouts WHERE phase_id=? AND bracket='main' AND de_round=? AND tableau_position=?`
      ).get(bout.phase_id, nextRound, nextPos);
      if (nextBout) {
        const col = bout.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
        db.prepare(`UPDATE bouts SET ${col} = ? WHERE id = ?`).run(bout.winner_id, nextBout.id);
        winnerNext = this.findById(nextBout.id);
      }
    }

    if (bout.loser_next_bout_id && loserId) {
      // Pointer-based loser routing
      const col = bout.loser_next_side === 'left' ? 'left_id' : 'right_id';
      db.prepare(`UPDATE bouts SET ${col} = ? WHERE id = ?`)
        .run(loserId, bout.loser_next_bout_id);
      loserNext = this.findById(bout.loser_next_bout_id);
    } else if (!bout.loser_next_bout_id && bout.bracket === 'main' && bout.de_round && loserId) {
      // Arithmetic fallback: bronze-only for pre-014 phases
      const { m: totalRounds } = db.prepare(
        "SELECT MAX(de_round) AS m FROM bouts WHERE phase_id=? AND bracket='main'"
      ).get(bout.phase_id);
      if (totalRounds && bout.de_round === totalRounds - 1) {
        const bronzeBout = db.prepare(
          `SELECT * FROM bouts WHERE phase_id=? AND bracket='placement' AND de_round=? AND tableau_position=2`
        ).get(bout.phase_id, totalRounds);
        if (bronzeBout && bronzeBout.status !== 'finished') {
          const col = bout.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
          db.prepare(`UPDATE bouts SET ${col} = ? WHERE id = ?`).run(loserId, bronzeBout.id);
          loserNext = this.findById(bronzeBout.id);
        }
      }
    }

    // Cascade: a main-bracket bye produces no real loser, leaving its target
    // placement bout with one permanently-null side.  After routing winner or
    // loser into a placement bout, check whether the other side will ever be
    // filled.  If every source wired to the empty side is already finished
    // (meaning it was a bye that routed nothing there), auto-finish as a bye.
    for (const nextId of [bout.winner_next_bout_id, bout.loser_next_bout_id].filter(Boolean)) {
      const next = db.prepare('SELECT * FROM bouts WHERE id=?').get(nextId);
      if (!next || next.status !== 'pending' ||
          (next.bracket !== 'placement' && next.bracket !== 'repechage')) continue;
      const hasLeft  = next.left_id  != null;
      const hasRight = next.right_id != null;
      if (!hasLeft && !hasRight) continue; // both still empty — too early
      if (hasLeft  && hasRight)  continue; // both filled — normal bout
      const nullSide = hasLeft ? 'right' : 'left';
      const pending = db.prepare(`
        SELECT COUNT(*) AS n FROM bouts WHERE status != 'finished'
          AND ((loser_next_bout_id  = ? AND loser_next_side  = ?)
            OR (winner_next_bout_id = ? AND winner_next_side = ?))
      `).get(nextId, nullSide, nextId, nullSide).n;
      if (pending === 0) {
        const winnerId = next.left_id ?? next.right_id;
        const ls = next.left_id  ? 1 : 0;
        const rs = next.right_id ? 1 : 0;
        db.prepare(`UPDATE bouts SET status='finished', winner_id=?, left_score=?, right_score=? WHERE id=?`)
          .run(winnerId, ls, rs, nextId);
        cascaded.push(this.findById(nextId));
        const sub = this.routeBoutResult(nextId);
        cascaded.push(...sub.cascaded);
      }
    }

    return { winnerNext, loserNext, cascaded };
  },

  // Restore last history snapshot and delete it.
  // Clears winner from winner_next_bout and loser from loser_next_bout (if still pending).
  undo(id) {
    const hist = db.prepare(
      'SELECT * FROM bout_history WHERE bout_id = ? ORDER BY id DESC LIMIT 1'
    ).get(id);
    if (!hist) return null;

    const current = db.prepare('SELECT * FROM bouts WHERE id = ?').get(id);

    db.transaction(() => {
      db.prepare(`
        UPDATE bouts SET left_score=@left_score, right_score=@right_score,
                         winner_id=@winner_id, status=@status
        WHERE id=@bout_id
      `).run(hist);
      db.prepare('DELETE FROM bout_history WHERE id = ?').run(hist.id);

      const loserId = current.winner_id === current.left_id
        ? current.right_id : current.left_id;

      if (current.winner_next_bout_id && current.winner_id) {
        // Pointer-based: clear winner slot
        const nextBout = db.prepare('SELECT * FROM bouts WHERE id = ?').get(current.winner_next_bout_id);
        if (nextBout && nextBout.status !== 'finished') {
          const col = current.winner_next_side === 'left' ? 'left_id' : 'right_id';
          if (nextBout[col] === current.winner_id) {
            db.prepare(`UPDATE bouts SET ${col} = NULL WHERE id = ?`).run(nextBout.id);
          }
        }
      } else if (current.bracket === 'main' && current.de_round && current.winner_id) {
        // Arithmetic fallback for pre-014 main bracket
        const nextBout = db.prepare(
          `SELECT * FROM bouts WHERE phase_id=? AND bracket='main' AND de_round=? AND tableau_position=?`
        ).get(current.phase_id, current.de_round + 1, Math.ceil(current.tableau_position / 2));
        if (nextBout && nextBout.status !== 'finished') {
          const col = current.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
          if (nextBout[col] === current.winner_id) {
            db.prepare(`UPDATE bouts SET ${col} = NULL WHERE id = ?`).run(nextBout.id);
          }
        }
      }

      if (current.loser_next_bout_id && loserId) {
        // Pointer-based: clear loser slot
        const nextBout = db.prepare('SELECT * FROM bouts WHERE id = ?').get(current.loser_next_bout_id);
        if (nextBout && nextBout.status !== 'finished') {
          const col = current.loser_next_side === 'left' ? 'left_id' : 'right_id';
          if (nextBout[col] === loserId) {
            db.prepare(`UPDATE bouts SET ${col} = NULL WHERE id = ?`).run(nextBout.id);
          }
        }
      } else if (!current.loser_next_bout_id && current.bracket === 'main'
                 && current.de_round && loserId) {
        // Arithmetic fallback: bronze-only
        const { m: totalRounds } = db.prepare(
          "SELECT MAX(de_round) AS m FROM bouts WHERE phase_id=? AND bracket='main'"
        ).get(current.phase_id);
        if (totalRounds && current.de_round === totalRounds - 1) {
          const bronzeBout = db.prepare(
            `SELECT * FROM bouts WHERE phase_id=? AND bracket='placement' AND de_round=? AND tableau_position=2`
          ).get(current.phase_id, totalRounds);
          if (bronzeBout && bronzeBout.status !== 'finished') {
            const col = current.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
            if (bronzeBout[col] === loserId) {
              db.prepare(`UPDATE bouts SET ${col} = NULL WHERE id = ?`).run(bronzeBout.id);
            }
          }
        }
      }
    })();

    const bout = this.findById(id);
    let next = null;
    if (current.winner_next_bout_id) {
      next = this.findById(current.winner_next_bout_id);
    } else if (current.bracket === 'main' && current.de_round && current.winner_id) {
      const row = db.prepare(
        `SELECT id FROM bouts WHERE phase_id=? AND bracket='main' AND de_round=? AND tableau_position=?`
      ).get(current.phase_id, current.de_round + 1, Math.ceil(current.tableau_position / 2));
      if (row) next = this.findById(row.id);
    }
    return { bout, next };
  },
};

module.exports = Bout;
