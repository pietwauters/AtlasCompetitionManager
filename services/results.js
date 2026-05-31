'use strict';
const db = require('../db');
const { buildSeedPositions } = require('../lib/deFormation');

function getCompetitionResults(compId) {
  const phases = db.prepare(
    'SELECT id, type, phase_order, status FROM phases WHERE competition_id=? ORDER BY phase_order'
  ).all(compId);

  const dePhase   = [...phases].reverse().find(p => p.type === 'de');
  const poolPhase = [...phases].reverse().find(p => p.type === 'pool' && p.status === 'finished');

  const entries = [];

  // ── DE results ────────────────────────────────────────────────────────────
  if (dePhase) {
    const bouts = db.prepare(`
      SELECT b.de_round, b.tableau_position, b.status,
             b.left_id, b.right_id, b.winner_id,
             lp.first_name AS lf, lp.last_name AS ll, lcl.name AS lclub,
             rp.first_name AS rf, rp.last_name AS rl, rcl.name AS rclub
      FROM bouts b
      LEFT JOIN competitors lc  ON lc.id  = b.left_id
      LEFT JOIN fencers     lf2 ON lf2.id = lc.fencer_id
      LEFT JOIN people      lp  ON lp.id  = lf2.person_id
      LEFT JOIN clubs       lcl ON lcl.id = lp.club_id
      LEFT JOIN competitors rc  ON rc.id  = b.right_id
      LEFT JOIN fencers     rf2 ON rf2.id = rc.fencer_id
      LEFT JOIN people      rp  ON rp.id  = rf2.person_id
      LEFT JOIN clubs       rcl ON rcl.id = rp.club_id
      WHERE b.phase_id = ?
      ORDER BY b.de_round, b.tableau_position
    `).all(dePhase.id);

    const totalRounds = bouts.reduce((m, b) => Math.max(m, b.de_round || 0), 0);
    if (totalRounds > 0) {
      // Name/club lookup
      const info = {};
      for (const b of bouts) {
        if (b.left_id)  info[b.left_id]  = { first_name: b.lf, last_name: b.ll, club: b.lclub };
        if (b.right_id) info[b.right_id] = { first_name: b.rf, last_name: b.rl, club: b.rclub };
      }

      // DE seed lookup from R1 positions
      const r1 = bouts.filter(b => b.de_round === 1);
      const T  = r1.length * 2;
      const seedSlots = buildSeedPositions(T);
      const deSeed = {};
      for (const b of r1) {
        const p = b.tableau_position;
        if (b.left_id)  deSeed[b.left_id]  = seedSlots[2 * (p - 1)];
        if (b.right_id) deSeed[b.right_id] = seedSlots[2 * (p - 1) + 1];
      }

      const push = (place, placeLabel, id, note) => {
        const i = info[id] || {};
        entries.push({ place, place_label: placeLabel, competitor_id: id,
          de_seed: deSeed[id] || null,
          first_name: i.first_name, last_name: i.last_name, club: i.club, note });
      };

      const finalBout = bouts.find(b => b.de_round === totalRounds && b.tableau_position === 1);
      if (finalBout?.winner_id) {
        push(1, '1', finalBout.winner_id, 'DE winner');

        const silver = finalBout.winner_id === finalBout.left_id
          ? finalBout.right_id : finalBout.left_id;
        push(2, '2', silver, 'DE final');

        // SF losers share 3rd (no bronze bout)
        const sfLosers = bouts
          .filter(b => b.de_round === totalRounds - 1 && b.status === 'finished'
                    && b.winner_id && b.left_id && b.right_id)
          .map(b => b.winner_id === b.left_id ? b.right_id : b.left_id);
        sfLosers.forEach(id => push(3, '3', id, 'DE semi-final'));

        // All other rounds: sort losers by DE seed, assign sequential unique ranks
        let nextPlace = 3 + sfLosers.length; // 5 when 2 SF losers
        for (let r = totalRounds - 2; r >= 1; r--) {
          const roundNote = r === totalRounds - 2 ? 'DE quarter-final'
                          : 'DE round of ' + (2 ** (totalRounds - r + 1));
          const losers = bouts
            .filter(b => b.de_round === r && b.status === 'finished'
                      && b.winner_id && b.left_id && b.right_id)
            .map(b => ({ id: b.winner_id === b.left_id ? b.right_id : b.left_id }))
            .map(l => ({ ...l, seed: deSeed[l.id] || 999 }))
            .sort((a, b) => a.seed - b.seed);

          for (const l of losers) {
            push(nextPlace, String(nextPlace), l.id, roundNote);
            nextPlace++;
          }
        }
      }
    }
  }

  // ── Pool-eliminated fencers ───────────────────────────────────────────────
  if (poolPhase) {
    const deIds = new Set(entries.map(e => e.competitor_id));
    const eliminated = db.prepare(`
      SELECT r.position AS pool_rank, r.competitor_id,
             p.first_name, p.last_name, cl.name AS club_name
      FROM rankings r
      JOIN competitors c ON c.id  = r.competitor_id
      JOIN fencers     f ON f.id  = c.fencer_id
      JOIN people      p ON p.id  = f.person_id
      LEFT JOIN clubs  cl ON cl.id = p.club_id
      WHERE r.phase_id = ? AND r.advanced = 0
      ORDER BY r.position
    `).all(poolPhase.id);

    for (const row of eliminated) {
      if (deIds.has(row.competitor_id)) continue;
      const place = entries.length + 1;
      entries.push({
        place, place_label: String(place),
        competitor_id: row.competitor_id,
        de_seed: null,
        first_name: row.first_name, last_name: row.last_name, club: row.club_name,
        note: 'Pool phase (rank ' + row.pool_rank + ')',
      });
    }
  }

  return entries;
}

module.exports = { getCompetitionResults };
