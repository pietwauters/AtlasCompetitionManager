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

const stmtFindByIdFull  = db.prepare(`${BASE} WHERE b.id = ?`);
const stmtFindByPool    = db.prepare(`${BASE} WHERE b.pool_id = ? ORDER BY b.bout_order`);
const stmtFindByPhase   = db.prepare(`${BASE} WHERE b.phase_id = ? ORDER BY b.pool_id, b.bout_order`);
const stmtGetRaw        = db.prepare('SELECT * FROM bouts WHERE id = ?');
const stmtInsertHistory = db.prepare(`
  INSERT INTO bout_history (bout_id, left_score, right_score, winner_id, status)
  VALUES (@bout_id, @left_score, @right_score, @winner_id, @status)
`);
const stmtUpdateScoreValues = db.prepare(
  'UPDATE bouts SET left_score=@ls, right_score=@rs, winner_id=@winner, status=@status WHERE id=@id'
);
const stmtSetLeft     = db.prepare('UPDATE bouts SET left_id  = ? WHERE id = ?');
const stmtSetRight    = db.prepare('UPDATE bouts SET right_id = ? WHERE id = ?');
const stmtClearLeft   = db.prepare('UPDATE bouts SET left_id  = NULL WHERE id = ?');
const stmtClearRight  = db.prepare('UPDATE bouts SET right_id = NULL WHERE id = ?');
const stmtSetFinished = db.prepare(
  `UPDATE bouts SET status='finished', winner_id=?, left_score=?, right_score=? WHERE id=?`
);
const stmtPendingCascade = db.prepare(`
  SELECT COUNT(*) AS n FROM bouts WHERE status != 'finished'
    AND ((loser_next_bout_id  = ? AND loser_next_side  = ?)
      OR (winner_next_bout_id = ? AND winner_next_side = ?))
`);
const stmtDENextBoutArith = db.prepare(
  `SELECT * FROM bouts WHERE phase_id=? AND bracket='main' AND de_round=? AND tableau_position=?`
);
const stmtMaxDERound = db.prepare(
  "SELECT MAX(de_round) AS m FROM bouts WHERE phase_id=? AND bracket='main'"
);
const stmtBronzeBout = db.prepare(
  `SELECT * FROM bouts WHERE phase_id=? AND bracket='placement' AND de_round=? AND tableau_position=2`
);
const stmtHistLast   = db.prepare('SELECT * FROM bout_history WHERE bout_id = ? ORDER BY id DESC LIMIT 1');
const stmtDeleteHist = db.prepare('DELETE FROM bout_history WHERE id = ?');
const stmtUndoBout   = db.prepare(`
  UPDATE bouts SET left_score=@left_score, right_score=@right_score,
                   winner_id=@winner_id,   status=@status
  WHERE id=@bout_id
`);
const stmtDERouteId  = db.prepare(
  `SELECT id FROM bouts WHERE phase_id=? AND bracket='main' AND de_round=? AND tableau_position=?`
);
const stmtGetCompHandedness = db.prepare('SELECT handedness FROM competitors WHERE id = ?');
const stmtNormalizeSwap = db.prepare('UPDATE bouts SET left_id = @right_id, right_id = @left_id WHERE id = @id');
const stmtSwapBoutSides = db.prepare(`
  UPDATE bouts
  SET left_id = @right_id, right_id = @left_id,
      left_score = @right_score, right_score = @left_score
  WHERE id = @id
`);
const stmtSwapBoutHistory = db.prepare(
  'UPDATE bout_history SET left_score = right_score, right_score = left_score WHERE bout_id = ?'
);
const stmtSwapCardSides = db.prepare(
  "UPDATE card_reasons SET side = CASE side WHEN 'left' THEN 'right' ELSE 'left' END WHERE bout_id = ?"
);

const Bout = {
  findById(id) {
    return stmtFindByIdFull.get(id);
  },

  // FIE Technical Rules t.22: in a right-vs-left bout, the left-hander stands
  // on the referee's left regardless of call order. Always applied whenever
  // both fencers' handedness is known and they differ — not an opt-in rule
  // setting; individual bouts only (pool/DE — team relays live in a separate
  // `relays` table and never reach this function at all). Never touches an
  // already-scored bout, and only acts once both sides of the pairing are
  // actually known; safe to call defensively any time a side is written,
  // since it no-ops otherwise.
  normalizeHandedness(boutId) {
    if (!boutId) return;
    const bout = stmtGetRaw.get(boutId);
    if (!bout || bout.status !== 'pending' || !bout.left_id || !bout.right_id) return;

    const leftHand  = stmtGetCompHandedness.get(bout.left_id)?.handedness;
    const rightHand = stmtGetCompHandedness.get(bout.right_id)?.handedness;
    if (leftHand === 'R' && rightHand === 'L') {
      stmtNormalizeSwap.run({ id: boutId, left_id: bout.left_id, right_id: bout.right_id });
    }
  },

  // Manual referee override — FIE Technical Rules t.22: whatever side Atlas
  // proposes (via normalizeHandedness above, or the plain FIE table/bracket
  // default), the referee must always be able to swap it at the strip if the
  // CMS didn't force it correctly upfront. Unlike normalizeHandedness this is
  // an explicit action, not gated by handednessAware. Swaps left_id/right_id,
  // left_score/right_score (so each fencer's own score stays attached to
  // them, not to whichever column they used to be in), every bout_history
  // snapshot (so a later undo() doesn't misattribute a pre-swap snapshot),
  // and every card_reasons.side for this bout (cards are keyed by side, not
  // competitor_id). Refused once the bout is finished — undo() first, same
  // as any other post-result correction.
  swapSides(boutId) {
    const bout = stmtGetRaw.get(boutId);
    if (!bout) throw Object.assign(new Error('Bout not found.'), { status: 404 });
    if (bout.status === 'finished') {
      throw Object.assign(new Error('Cannot swap sides on a finished bout — undo it first.'), { status: 400 });
    }
    if (!bout.left_id || !bout.right_id) {
      throw Object.assign(new Error('Both fencers must be assigned before swapping sides.'), { status: 400 });
    }

    db.transaction(() => {
      stmtSwapBoutSides.run({
        id: boutId,
        left_id: bout.left_id, right_id: bout.right_id,
        left_score: bout.left_score, right_score: bout.right_score,
      });
      stmtSwapBoutHistory.run(boutId);
      stmtSwapCardSides.run(boutId);
    })();

    return this.findById(boutId);
  },

  findByPool(poolId) {
    return stmtFindByPool.all(poolId);
  },

  findByPhase(phaseId) {
    return stmtFindByPhase.all(phaseId);
  },

  // Save current state to history, then apply new scores.
  // winnerId: explicit override for tied bouts. If scores differ, winner is auto-determined.
  updateScore(id, leftScore, rightScore, winnerId = null) {
    const current = stmtGetRaw.get(id);
    if (!current) return null;

    stmtInsertHistory.run({
      bout_id:     id,
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

    stmtUpdateScoreValues.run({ id, ls, rs, winner, status });

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
    const bout = stmtGetRaw.get(boutId);
    if (!bout || bout.status !== 'finished') return { winnerNext: null, loserNext: null, cascaded: [] };

    const loserId = bout.winner_id === bout.left_id ? bout.right_id : bout.left_id;

    let winnerNext = null;
    let loserNext  = null;
    const cascaded = [];

    if (bout.winner_next_bout_id) {
      // Pointer-based routing (new phases)
      const col = bout.winner_next_side === 'left' ? 'left_id' : 'right_id';
      if (bout.winner_id) {
        (col === 'left_id' ? stmtSetLeft : stmtSetRight).run(bout.winner_id, bout.winner_next_bout_id);
        this.normalizeHandedness(bout.winner_next_bout_id);
        winnerNext = this.findById(bout.winner_next_bout_id);
      }
    } else if (bout.bracket === 'main' && bout.de_round && bout.winner_id) {
      // Arithmetic fallback for pre-014 main-bracket bouts
      const nextRound = bout.de_round + 1;
      const nextPos   = Math.ceil(bout.tableau_position / 2);
      const nextBout  = stmtDENextBoutArith.get(bout.phase_id, nextRound, nextPos);
      if (nextBout) {
        const col = bout.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
        (col === 'left_id' ? stmtSetLeft : stmtSetRight).run(bout.winner_id, nextBout.id);
        this.normalizeHandedness(nextBout.id);
        winnerNext = this.findById(nextBout.id);
      }
    }

    if (bout.loser_next_bout_id && loserId) {
      // Pointer-based loser routing
      const col = bout.loser_next_side === 'left' ? 'left_id' : 'right_id';
      (col === 'left_id' ? stmtSetLeft : stmtSetRight).run(loserId, bout.loser_next_bout_id);
      this.normalizeHandedness(bout.loser_next_bout_id);
      loserNext = this.findById(bout.loser_next_bout_id);
    } else if (!bout.loser_next_bout_id && bout.bracket === 'main' && bout.de_round && loserId) {
      // Arithmetic fallback: bronze-only for pre-014 phases
      const { m: totalRounds } = stmtMaxDERound.get(bout.phase_id);
      if (totalRounds && bout.de_round === totalRounds - 1) {
        const bronzeBout = stmtBronzeBout.get(bout.phase_id, totalRounds);
        if (bronzeBout && bronzeBout.status !== 'finished') {
          const col = bout.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
          (col === 'left_id' ? stmtSetLeft : stmtSetRight).run(loserId, bronzeBout.id);
          this.normalizeHandedness(bronzeBout.id);
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
      const next = stmtGetRaw.get(nextId);
      if (!next || next.status !== 'pending' ||
          (next.bracket !== 'placement' && next.bracket !== 'repechage')) continue;
      const hasLeft  = next.left_id  != null;
      const hasRight = next.right_id != null;
      if (hasLeft && hasRight) continue; // both filled — normal bout

      if (!hasLeft && !hasRight) {
        // Neither side filled. Usually just "too early" (a source is still
        // pending). But if BOTH sides' sources are already finished without
        // ever routing here — e.g. two adjacent R1 byes paired into the same
        // repechage slot, neither of which has a loser to send — this bout
        // will never receive anyone and must be resolved as a no-result
        // phantom so whatever it would have fed can itself cascade.
        const pendingLeft  = stmtPendingCascade.get(nextId, 'left',  nextId, 'left').n;
        const pendingRight = stmtPendingCascade.get(nextId, 'right', nextId, 'right').n;
        if (pendingLeft > 0 || pendingRight > 0) continue; // still waiting on a real source
        db.prepare("UPDATE bouts SET status='finished', winner_id=NULL WHERE id=?").run(nextId);
        cascaded.push(this.findById(nextId));
        const sub = this.routeBoutResult(nextId);
        cascaded.push(...sub.cascaded);
        continue;
      }

      const nullSide = hasLeft ? 'right' : 'left';
      const pending = stmtPendingCascade.get(nextId, nullSide, nextId, nullSide).n;
      if (pending === 0) {
        const winnerId = next.left_id ?? next.right_id;
        const ls = next.left_id  ? 1 : 0;
        const rs = next.right_id ? 1 : 0;
        stmtSetFinished.run(winnerId, ls, rs, nextId);
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
    const hist = stmtHistLast.get(id);
    if (!hist) return null;

    const current = stmtGetRaw.get(id);

    db.transaction(() => {
      stmtUndoBout.run(hist);
      stmtDeleteHist.run(hist.id);

      const loserId = current.winner_id === current.left_id
        ? current.right_id : current.left_id;

      if (current.winner_next_bout_id && current.winner_id) {
        // Pointer-based: clear winner slot
        const nextBout = stmtGetRaw.get(current.winner_next_bout_id);
        if (nextBout && nextBout.status !== 'finished') {
          const col = current.winner_next_side === 'left' ? 'left_id' : 'right_id';
          if (nextBout[col] === current.winner_id) {
            (col === 'left_id' ? stmtClearLeft : stmtClearRight).run(nextBout.id);
          }
        }
      } else if (current.bracket === 'main' && current.de_round && current.winner_id) {
        // Arithmetic fallback for pre-014 main bracket
        const nextBout = stmtDENextBoutArith.get(
          current.phase_id, current.de_round + 1, Math.ceil(current.tableau_position / 2)
        );
        if (nextBout && nextBout.status !== 'finished') {
          const col = current.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
          if (nextBout[col] === current.winner_id) {
            (col === 'left_id' ? stmtClearLeft : stmtClearRight).run(nextBout.id);
          }
        }
      }

      if (current.loser_next_bout_id && loserId) {
        // Pointer-based: clear loser slot
        const nextBout = stmtGetRaw.get(current.loser_next_bout_id);
        if (nextBout && nextBout.status !== 'finished') {
          const col = current.loser_next_side === 'left' ? 'left_id' : 'right_id';
          if (nextBout[col] === loserId) {
            (col === 'left_id' ? stmtClearLeft : stmtClearRight).run(nextBout.id);
          }
        }
      } else if (!current.loser_next_bout_id && current.bracket === 'main'
                 && current.de_round && loserId) {
        // Arithmetic fallback: bronze-only
        const { m: totalRounds } = stmtMaxDERound.get(current.phase_id);
        if (totalRounds && current.de_round === totalRounds - 1) {
          const bronzeBout = stmtBronzeBout.get(current.phase_id, totalRounds);
          if (bronzeBout && bronzeBout.status !== 'finished') {
            const col = current.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
            if (bronzeBout[col] === loserId) {
              (col === 'left_id' ? stmtClearLeft : stmtClearRight).run(bronzeBout.id);
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
      const row = stmtDERouteId.get(
        current.phase_id, current.de_round + 1, Math.ceil(current.tableau_position / 2)
      );
      if (row) next = this.findById(row.id);
    }
    return { bout, next };
  },
};

module.exports = Bout;
