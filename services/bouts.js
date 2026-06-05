'use strict';
const db = require('../db');

const BASE = `
  SELECT b.*, ph.competition_id,
    lp.first_name AS left_first,  lp.last_name AS left_last,
    rp.first_name AS right_first, rp.last_name AS right_last
  FROM bouts b
  LEFT JOIN phases      ph ON ph.id = b.phase_id
  LEFT JOIN competitors lc ON lc.id = b.left_id
  LEFT JOIN fencers     lf ON lf.id = lc.fencer_id
  LEFT JOIN people      lp ON lp.id = lf.person_id
  LEFT JOIN competitors rc ON rc.id = b.right_id
  LEFT JOIN fencers     rf ON rf.id = rc.fencer_id
  LEFT JOIN people      rp ON rp.id = rf.person_id
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

    const bout = this.findById(id);
    let next = null;
    if (status === 'finished') {
      next = this.advanceDEWinner(id);
      this.routeDeLoser(id);
    }
    return { bout, next };
  },

  // After a main-bracket DE bout is finished, fill the winner into the correct
  // slot of the next-round bout. Returns the updated next-round bout or null.
  advanceDEWinner(boutId) {
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ?').get(boutId);
    if (!bout || !bout.de_round || !bout.winner_id || bout.status !== 'finished') return null;
    if (bout.bracket !== 'main') return null;  // placement/repechage handled separately

    const nextRound = bout.de_round + 1;
    const nextPos   = Math.ceil(bout.tableau_position / 2);

    const nextBout = db.prepare(`
      SELECT * FROM bouts WHERE phase_id = ? AND bracket = 'main' AND de_round = ? AND tableau_position = ?
    `).get(bout.phase_id, nextRound, nextPos);

    if (!nextBout) return null;

    const side = bout.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
    db.prepare(`UPDATE bouts SET ${side} = ? WHERE id = ?`).run(bout.winner_id, nextBout.id);
    return this.findById(nextBout.id);
  },

  // After a main-bracket DE bout is finished, route the loser into the
  // appropriate placement bout (bronze, 5th/6th, etc.) if one exists.
  routeDeLoser(boutId) {
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ?').get(boutId);
    if (!bout || !bout.de_round || bout.status !== 'finished') return null;
    if (bout.bracket !== 'main') return null;

    const loserId = bout.winner_id === bout.left_id ? bout.right_id : bout.left_id;
    if (!loserId) return null;  // bye bout has no real loser

    // Bronze bout: bracket='placement', same de_round as the final, tableau_position=2.
    // SF bouts are at de_round = (totalRounds - 1); the final is at de_round = totalRounds.
    // We route losers from any main bracket round that has a placement bout at the same de_round.
    // For bronze: the placement bout lives at de_round = totalRounds, so the SF bouts
    // (de_round = totalRounds - 1) need to know totalRounds.
    const { m: totalRounds } = db.prepare(
      "SELECT MAX(de_round) AS m FROM bouts WHERE phase_id = ? AND bracket = 'main'"
    ).get(bout.phase_id);

    if (!totalRounds) return null;

    // Bronze: SF is at totalRounds-1; bronze bout is at de_round=totalRounds, position=2.
    if (bout.de_round !== totalRounds - 1) return null;

    const bronzeBout = db.prepare(`
      SELECT * FROM bouts
      WHERE phase_id = ? AND bracket = 'placement' AND de_round = ? AND tableau_position = 2
    `).get(bout.phase_id, totalRounds);

    if (!bronzeBout || bronzeBout.status === 'finished') return null;

    const side = bout.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
    db.prepare(`UPDATE bouts SET ${side} = ? WHERE id = ?`).run(loserId, bronzeBout.id);
    return this.findById(bronzeBout.id);
  },

  // Restore last history snapshot and delete it.
  // For DE bouts: also clears the winner from the next-round slot and the loser
  // from any placement slot, if those bouts are still pending.
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

      if (current.de_round && current.bracket === 'main') {
        // Clear winner from next main-bracket round slot.
        if (current.winner_id) {
          const nextBout = db.prepare(`
            SELECT * FROM bouts WHERE phase_id=? AND bracket='main' AND de_round=? AND tableau_position=?
          `).get(current.phase_id, current.de_round + 1, Math.ceil(current.tableau_position / 2));

          if (nextBout && nextBout.status !== 'finished') {
            const side = current.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
            if (nextBout[side] === current.winner_id) {
              db.prepare(`UPDATE bouts SET ${side}=NULL WHERE id=?`).run(nextBout.id);
            }
          }
        }

        // Clear loser from bronze bout (placement) if it was routed there.
        const loserId = current.winner_id === current.left_id ? current.right_id : current.left_id;
        if (loserId) {
          const { m: totalRounds } = db.prepare(
            "SELECT MAX(de_round) AS m FROM bouts WHERE phase_id=? AND bracket='main'"
          ).get(current.phase_id);

          if (totalRounds && current.de_round === totalRounds - 1) {
            const bronzeBout = db.prepare(`
              SELECT * FROM bouts
              WHERE phase_id=? AND bracket='placement' AND de_round=? AND tableau_position=2
            `).get(current.phase_id, totalRounds);

            if (bronzeBout && bronzeBout.status !== 'finished') {
              const side = current.tableau_position % 2 === 1 ? 'left_id' : 'right_id';
              if (bronzeBout[side] === loserId) {
                db.prepare(`UPDATE bouts SET ${side}=NULL WHERE id=?`).run(bronzeBout.id);
              }
            }
          }
        }
      }
    })();

    const bout = this.findById(id);
    let next = null;
    if (current.de_round && current.winner_id && current.bracket === 'main') {
      const row = db.prepare(`
        SELECT id FROM bouts WHERE phase_id=? AND bracket='main' AND de_round=? AND tableau_position=?
      `).get(current.phase_id, current.de_round + 1, Math.ceil(current.tableau_position / 2));
      if (row) next = this.findById(row.id);
    }
    return { bout, next };
  },
};

module.exports = Bout;
