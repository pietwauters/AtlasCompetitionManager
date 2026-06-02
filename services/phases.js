'use strict';

const db             = require('../db');
const { loadRule }   = require('../lib/rules');
const { formPools, calcPoolOptions } = require('../lib/poolFormation');
const { buildDE }    = require('../lib/deFormation');
const Competitor     = require('./competitors');

const DEFAULT_CRITERIA = [
  'victory_ratio_desc', 'indicator_desc',
  'touches_scored_desc', 'touches_received_asc', 'initial_seed_asc',
];

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const Phase = {
  findByCompetition(compId) {
    return db.prepare(`
      SELECT ph.*,
        COUNT(DISTINCT p.id)  AS pool_count,
        COUNT(b.id)           AS bouts_total,
        SUM(CASE WHEN b.status='finished' THEN 1 ELSE 0 END) AS bouts_complete
      FROM phases ph
      LEFT JOIN pools p ON p.phase_id = ph.id
      LEFT JOIN bouts b ON b.phase_id = ph.id
      WHERE ph.competition_id = ?
      GROUP BY ph.id
      ORDER BY ph.phase_order
    `).all(compId);
  },

  findById(id) {
    return db.prepare('SELECT * FROM phases WHERE id = ?').get(id);
  },

  // ---------------------------------------------------------------------------
  // Pool options — tell the UI what pool size configurations are possible.
  // Returns { options, recommended, fencerCount } where recommended is the
  // index of the default choice (equal-size pool if N divisible by 6 or 7).
  // ---------------------------------------------------------------------------
  calcOptions(compId, ruleDoc) {
    const rule       = loadRule(ruleDoc);
    const competitors = Competitor.findAll(compId).filter(c => c.competitor_status === 'active');
    const N          = competitors.length;

    if (N < 2) throw Object.assign(new Error('At least 2 active competitors required.'), { status: 400 });

    const options = calcPoolOptions(N, rule.poolFormation);

    // Recommended: first uniform (equal-size) option if one exists, otherwise index 0.
    // calcPoolOptions already sorts uniform before mixed, so index 0 is usually best.
    const recIdx = options.findIndex(o => o.every(s => s === o[0]));
    const recommended = recIdx >= 0 ? recIdx : 0;

    return { options, recommended, fencerCount: N, ruleDoc };
  },

  // ---------------------------------------------------------------------------
  // Create pool phase: insert phase + pools + pool_competitors + bouts.
  // chosenSizes: sorted-desc array, e.g. [7, 7, 6]
  // separation: optional override array, e.g. ['club'] or ['nationality','club']
  //             replaces the value from the rule JSON.
  // ---------------------------------------------------------------------------
  create(compId, ruleDoc, chosenSizes, separation) {
    const rule       = loadRule(ruleDoc);
    if (Array.isArray(separation)) rule.poolFormation.separation = separation;
    const competitors = Competitor.findAll(compId).filter(c => c.competitor_status === 'active');

    if (!competitors.length) throw Object.assign(new Error('No active competitors.'), { status: 400 });

    // If a previous pool phase exists, use its rankings as the seed order so
    // that round 2 (and beyond) serpentine-seeds from the actual results of
    // the preceding round rather than from the original pre-competition seed.
    const prevRankings = this._getPrevPoolRankings(compId);

    // Map competitors to the shape expected by formPools / boutOrder
    const fencerInput = competitors.map(c => ({
      id:            c.competitor_id,
      competitor_id: c.competitor_id,
      initial_seed:  prevRankings.get(c.competitor_id) ?? c.initial_seed,
      nationality:   c.nationality,
      club:          c.club_name,
      first_name:    c.first_name,
      last_name:     c.last_name,
    }));

    const pools = formPools(fencerInput, chosenSizes, rule.poolFormation);

    const phaseId = db.transaction(() => {
      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(phase_order), 0) AS m FROM phases WHERE competition_id = ?'
      ).get(compId).m;

      if (maxOrder > 0) {
        const prev = db.prepare(
          'SELECT status FROM phases WHERE competition_id = ? ORDER BY phase_order DESC LIMIT 1'
        ).get(compId);
        if (prev && prev.status !== 'finished') {
          throw Object.assign(new Error('Previous phase must be finished before creating a new one.'), { status: 400 });
        }
      }

      const { lastInsertRowid: phaseId } = db.prepare(`
        INSERT INTO phases (competition_id, phase_order, type, rule_doc, status)
        VALUES (@comp_id, @order, 'pool', @rule_doc, 'pending')
      `).run({ comp_id: Number(compId), order: maxOrder + 1, rule_doc: ruleDoc });

      for (const pool of pools) {
        const { lastInsertRowid: poolId } = db.prepare(`
          INSERT INTO pools (phase_id, pool_number, status) VALUES (?, ?, 'pending')
        `).run(phaseId, pool.poolNumber);

        for (const fencer of pool.fencers) {
          db.prepare(
            'INSERT INTO pool_competitors (pool_id, competitor_id) VALUES (?, ?)'
          ).run(poolId, fencer.competitor_id);
        }

        pool.bouts.forEach((bout, i) => {
          db.prepare(`
            INSERT INTO bouts (phase_id, pool_id, left_id, right_id, status, bout_order)
            VALUES (?, ?, ?, ?, 'pending', ?)
          `).run(phaseId, poolId, bout.left.competitor_id, bout.right.competitor_id, i + 1);
        });
      }

      return phaseId;
    })();

    return this.findById(phaseId);
  },

  activate(phaseId) {
    db.prepare("UPDATE phases SET status='active' WHERE id=?").run(phaseId);
    db.prepare("UPDATE pools  SET status='active' WHERE phase_id=?").run(phaseId);
    return this.findById(phaseId);
  },

  // ---------------------------------------------------------------------------
  // Rankings — computed from bout results. Not yet saved to DB.
  // ---------------------------------------------------------------------------
  calculateRankings(phaseId) {
    const phase = this.findById(phaseId);
    if (!phase) return [];

    let criteria = DEFAULT_CRITERIA;
    let levelPools = false;
    try {
      const rule = loadRule(phase.rule_doc);
      criteria   = rule.seeding?.criteria || DEFAULT_CRITERIA;
      levelPools = rule.levelPools === true;
    } catch {}

    // All competitors in this phase, including their pool_number for level-pool ranking
    const competitorRows = db.prepare(`
      SELECT DISTINCT pc.competitor_id, c.initial_seed,
        p.first_name, p.last_name, cl.name AS club_name, p.nationality,
        ph.pool_number
      FROM pool_competitors pc
      JOIN pools ph ON ph.id = pc.pool_id AND ph.phase_id = ?
      JOIN competitors c ON c.id = pc.competitor_id
      JOIN fencers f ON f.id = c.fencer_id
      JOIN people p ON p.id = f.person_id
      LEFT JOIN clubs cl ON cl.id = p.club_id
    `).all(phaseId);

    // All finished bouts
    const bouts = db.prepare(`
      SELECT left_id, right_id, left_score, right_score, winner_id
      FROM bouts WHERE phase_id = ? AND left_score IS NOT NULL AND right_score IS NOT NULL
    `).all(phaseId);

    // Accumulate stats per competitor
    const stats = {};
    for (const c of competitorRows) {
      stats[c.competitor_id] = {
        competitor_id:    c.competitor_id,
        first_name:       c.first_name,
        last_name:        c.last_name,
        club_name:        c.club_name,
        nationality:      c.nationality,
        initial_seed:     c.initial_seed ?? 9999,
        pool_number:      c.pool_number,
        victories:        0,
        matches:          0,
        touches_scored:   0,
        touches_received: 0,
        indicator:        0,
        victory_ratio:    0,
      };
    }

    for (const b of bouts) {
      if (stats[b.left_id]) {
        stats[b.left_id].matches++;
        stats[b.left_id].touches_scored   += b.left_score;
        stats[b.left_id].touches_received += b.right_score;
        if (b.winner_id === b.left_id) stats[b.left_id].victories++;
      }
      if (stats[b.right_id]) {
        stats[b.right_id].matches++;
        stats[b.right_id].touches_scored   += b.right_score;
        stats[b.right_id].touches_received += b.left_score;
        if (b.winner_id === b.right_id) stats[b.right_id].victories++;
      }
    }

    for (const s of Object.values(stats)) {
      s.indicator     = s.touches_scored - s.touches_received;
      s.victory_ratio = s.matches > 0 ? s.victories / s.matches : 0;
    }

    const compareByCriteria = (a, b) => {
      for (const crit of criteria) {
        let diff = 0;
        switch (crit) {
          case 'victory_ratio_desc':   diff = b.victory_ratio   - a.victory_ratio;   break;
          case 'victories_desc':       diff = b.victories       - a.victories;       break;
          case 'indicator_desc':       diff = b.indicator       - a.indicator;       break;
          case 'touches_scored_desc':  diff = b.touches_scored  - a.touches_scored;  break;
          case 'touches_received_asc': diff = a.touches_received - b.touches_received; break;
          case 'initial_seed_asc':     diff = (a.initial_seed ?? 9999) - (b.initial_seed ?? 9999); break;
        }
        if (diff !== 0) return diff;
      }
      return 0;
    };

    let sorted;
    if (levelPools) {
      // Rank within each pool independently; pool level order is derived from
      // the actual seeding (previous phase rankings), not from pool_number labels.
      const byPool = {};
      for (const s of Object.values(stats)) {
        if (!byPool[s.pool_number]) byPool[s.pool_number] = [];
        byPool[s.pool_number].push(s);
      }

      // Find previous pool phase to anchor level ordering
      const prevPhase = db.prepare(`
        SELECT id FROM phases
        WHERE competition_id = ? AND type = 'pool' AND phase_order < ?
        ORDER BY phase_order DESC LIMIT 1
      `).get(phase.competition_id, phase.phase_order);

      const prevRankMap = prevPhase
        ? new Map(db.prepare('SELECT competitor_id, position FROM rankings WHERE phase_id = ?')
            .all(prevPhase.id).map(r => [r.competitor_id, r.position]))
        : null;

      // Level key = min rank of pool members in the previous phase (or min initial_seed)
      const poolLevelKey = pn => {
        const members = byPool[pn];
        if (prevRankMap) return Math.min(...members.map(m => prevRankMap.get(m.competitor_id) ?? 9999));
        return Math.min(...members.map(m => m.initial_seed));
      };

      sorted = Object.keys(byPool)
        .map(Number)
        .sort((a, b) => poolLevelKey(a) - poolLevelKey(b))
        .flatMap(pn => byPool[pn].sort(compareByCriteria));
    } else {
      sorted = Object.values(stats).sort(compareByCriteria);
    }

    return sorted.map((s, i) => ({ ...s, position: i + 1 }));
  },

  // ---------------------------------------------------------------------------
  // Close phase: save rankings, mark advanced/eliminated, update statuses.
  // advancementOverride: optional { method, value, multipleOf } from manager.
  // ---------------------------------------------------------------------------
  close(phaseId, advancementOverride = null) {
    const phase = this.findById(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });

    const rankings = this.calculateRankings(phaseId);
    const N        = rankings.length;

    // Determine advancement rule
    let rule;
    try { rule = loadRule(phase.rule_doc); } catch { rule = {}; }
    const adv = advancementOverride || rule.advancement || { method: 'percentage', value: 70 };

    let advanceN;
    if (!advancementOverride && adv.eliminateAfterPhase === true) {
      // Rule says this phase is final: no one advances regardless of the percentage value.
      advanceN = 0;
    } else {
      advanceN = N;
      switch (adv.method) {
        case 'count':
          advanceN = Math.min(Number(adv.value), N);
          break;
        case 'multiple':
          advanceN = Math.floor(N / Number(adv.multipleOf)) * Number(adv.multipleOf);
          if (advanceN < 1) advanceN = N;
          break;
        case 'percentage':
        default: {
          const pct = Number(adv.value ?? 70) / 100;
          advanceN = Math.round(N * pct);
          if (adv.roundTo) {
            const rt = Number(adv.roundTo);
            advanceN = Math.ceil(advanceN / rt) * rt;
          }
          break;
        }
      }
      advanceN = Math.max(0, Math.min(advanceN, N));
    }

    db.transaction(() => {
      // Clear previous rankings for this phase (in case of re-close)
      db.prepare('DELETE FROM rankings WHERE phase_id = ?').run(phaseId);

      const insertRanking = db.prepare(`
        INSERT INTO rankings
          (phase_id, competitor_id, position, victories, matches,
           indicator, touches_scored, touches_received, advanced)
        VALUES (@phase_id, @competitor_id, @position, @victories, @matches,
                @indicator, @touches_scored, @touches_received, @advanced)
      `);

      for (let i = 0; i < rankings.length; i++) {
        const r       = rankings[i];
        const advanced = i < advanceN ? 1 : 0;
        insertRanking.run({ ...r, phase_id: phaseId, advanced });

        // Update competitor status
        if (advanced) {
          db.prepare("UPDATE competitors SET status='active' WHERE id=?").run(r.competitor_id);
        } else {
          db.prepare(`
            UPDATE competitors SET status='eliminated', eliminated_after=?, final_rank=?
            WHERE id=?
          `).run(phaseId, r.position, r.competitor_id);
        }
      }

      db.prepare("UPDATE phases SET status='finished' WHERE id=?").run(phaseId);
      db.prepare("UPDATE pools  SET status='finished' WHERE phase_id=?").run(phaseId);
    })();

    return { rankings, advanced: advanceN, eliminated: N - advanceN };
  },

  // ---------------------------------------------------------------------------
  // Returns a Map<competitor_id, rank> from the most recent finished pool phase.
  // Used to seed a subsequent pool phase from real results rather than from the
  // original pre-competition seed numbers.
  // ---------------------------------------------------------------------------
  _getPrevPoolRankings(compId) {
    const prev = db.prepare(`
      SELECT id FROM phases
      WHERE competition_id = ? AND type = 'pool' AND status = 'finished'
      ORDER BY phase_order DESC LIMIT 1
    `).get(compId);
    if (!prev) return new Map();
    const rows = db.prepare(
      'SELECT competitor_id, position FROM rankings WHERE phase_id = ? AND advanced = 1'
    ).all(prev.id);
    return new Map(rows.map(r => [r.competitor_id, r.position]));
  },

  // ---------------------------------------------------------------------------
  // DE: preview — returns { N, tableauSize, byeCount, totalRounds, finishedPoolPhases }
  // finishedPoolPhases: count of finished pool phases (drives the seeding selector)
  // ---------------------------------------------------------------------------
  getDeOptions(compId) {
    const finishedPoolPhases = db.prepare(
      "SELECT COUNT(*) AS n FROM phases WHERE competition_id=? AND type='pool' AND status='finished'"
    ).get(compId).n;
    const rows = this._getDeSeeding(compId, 'last');
    if (rows.length < 2) throw Object.assign(new Error('At least 2 active competitors required.'), { status: 400 });
    const T = 2 ** Math.ceil(Math.log2(rows.length));
    return { N: rows.length, tableauSize: T, byeCount: T - rows.length, totalRounds: Math.log2(T), finishedPoolPhases };
  },

  // Returns an ordered array of { competitor_id } for DE seeding.
  //
  // seedingMethod:
  //   'last'     — rank from the most recent finished pool phase (advanced only)
  //   'combined' — aggregate stats across ALL finished pool phases, re-rank,
  //                include all currently active competitors
  //   (fallback) — active competitors sorted by initial_seed
  _getDeSeeding(compId, seedingMethod = 'last') {
    const finishedPhases = db.prepare(`
      SELECT id FROM phases
      WHERE competition_id = ? AND type = 'pool' AND status = 'finished'
      ORDER BY phase_order
    `).all(compId);

    if (finishedPhases.length === 0) {
      return Competitor.findAll(compId)
        .filter(c => c.competitor_status === 'active')
        .sort((a, b) => (a.initial_seed || 9999) - (b.initial_seed || 9999))
        .map(c => ({ competitor_id: c.competitor_id }));
    }

    if (seedingMethod === 'combined') {
      return this._combinedSeeding(compId, finishedPhases);
    }

    // 'last': use only the most recent finished pool phase
    const lastId = finishedPhases[finishedPhases.length - 1].id;
    return db.prepare(`
      SELECT r.competitor_id
      FROM rankings r
      WHERE r.phase_id = ? AND r.advanced = 1
      ORDER BY r.position
    `).all(lastId);
  },

  // Aggregate bout stats across every finished pool phase, re-rank using FIE
  // criteria, and return all active competitors in that combined order.
  _combinedSeeding(compId, finishedPhases) {
    const phaseIds = finishedPhases.map(p => p.id);

    // Collect all active competitors
    const active = Competitor.findAll(compId).filter(c => c.competitor_status === 'active');
    const stats  = {};
    for (const c of active) {
      stats[c.competitor_id] = {
        competitor_id:    c.competitor_id,
        initial_seed:     c.initial_seed ?? 9999,
        victories:        0, matches:          0,
        touches_scored:   0, touches_received: 0,
      };
    }

    // Sum bout stats across all finished pool phases
    const placeholders = phaseIds.map(() => '?').join(',');
    const bouts = db.prepare(`
      SELECT left_id, right_id, left_score, right_score, winner_id
      FROM bouts
      WHERE phase_id IN (${placeholders}) AND left_score IS NOT NULL AND right_score IS NOT NULL
    `).all(...phaseIds);

    for (const b of bouts) {
      if (stats[b.left_id]) {
        stats[b.left_id].matches++;
        stats[b.left_id].touches_scored   += b.left_score;
        stats[b.left_id].touches_received += b.right_score;
        if (b.winner_id === b.left_id) stats[b.left_id].victories++;
      }
      if (stats[b.right_id]) {
        stats[b.right_id].matches++;
        stats[b.right_id].touches_scored   += b.right_score;
        stats[b.right_id].touches_received += b.left_score;
        if (b.winner_id === b.right_id) stats[b.right_id].victories++;
      }
    }

    const sorted = Object.values(stats).map(s => ({
      ...s,
      indicator:     s.touches_scored - s.touches_received,
      victory_ratio: s.matches > 0 ? s.victories / s.matches : 0,
    })).sort((a, b) => {
      for (const [fn] of [
        [() => b.victory_ratio   - a.victory_ratio],
        [() => b.indicator       - a.indicator],
        [() => b.touches_scored  - a.touches_scored],
        [() => a.touches_received - b.touches_received],
        [() => a.initial_seed    - b.initial_seed],
      ]) {
        const d = fn(); if (d !== 0) return d;
      }
      return 0;
    });

    return sorted.map(s => ({ competitor_id: s.competitor_id }));
  },

  // ---------------------------------------------------------------------------
  // Create DE phase: inserts phase + all bout slots for every round.
  // seedingMethod: 'last' (default) or 'combined'
  // ---------------------------------------------------------------------------
  createDE(compId, ruleDoc, seedingMethod = 'last') {
    const seeding     = this._getDeSeeding(compId, seedingMethod);
    const competitors = seeding.map(r => ({ competitor_id: r.competitor_id }));

    const { tableauSize, totalRounds, r1Bouts } = buildDE(competitors);

    const phaseId = db.transaction(() => {
      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(phase_order), 0) AS m FROM phases WHERE competition_id = ?'
      ).get(compId).m;

      if (maxOrder > 0) {
        const prev = db.prepare(
          'SELECT status FROM phases WHERE competition_id = ? ORDER BY phase_order DESC LIMIT 1'
        ).get(compId);
        if (prev && prev.status !== 'finished') {
          throw Object.assign(new Error('Previous phase must be finished before creating a new one.'), { status: 400 });
        }
      }

      const { lastInsertRowid: phaseId } = db.prepare(`
        INSERT INTO phases (competition_id, phase_order, type, rule_doc, status)
        VALUES (@comp_id, @order, 'de', @rule_doc, 'pending')
      `).run({ comp_id: Number(compId), order: maxOrder + 1, rule_doc: ruleDoc });

      // Pre-create all bouts for every round.
      // boutIds[round][position] lets us wire winners to next-round slots.
      const boutIds = {};
      for (let round = 1; round <= totalRounds; round++) {
        boutIds[round] = {};
        const boutsInRound = tableauSize / (2 ** round);

        for (let pos = 1; pos <= boutsInRound; pos++) {
          let leftId = null, rightId = null, status = 'pending', winnerId = null;
          let leftScore = null, rightScore = null;

          if (round === 1) {
            const spec = r1Bouts[pos - 1];
            leftId  = spec.left?.competitor_id  ?? null;
            rightId = spec.right?.competitor_id ?? null;

            // Auto-finish bye bouts (one side is null).
            if (leftId === null || rightId === null) {
              status    = 'finished';
              winnerId  = leftId ?? rightId;
              leftScore  = leftId  ? 1 : 0;
              rightScore = rightId ? 1 : 0;
            }
          }

          const { lastInsertRowid: boutId } = db.prepare(`
            INSERT INTO bouts
              (phase_id, left_id, right_id, de_round, tableau_position,
               status, winner_id, left_score, right_score, bout_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(phaseId, leftId, rightId, round, pos, status, winnerId, leftScore, rightScore, pos);

          boutIds[round][pos] = boutId;
        }
      }

      // Wire bye winners into round-2 slots immediately.
      for (const spec of r1Bouts) {
        if (spec.left !== null && spec.right !== null) continue; // not a bye
        const winner = spec.left ?? spec.right;
        if (!winner) continue;

        const r2Pos  = Math.ceil(spec.tableauPosition / 2);
        const r2Id   = boutIds[2]?.[r2Pos];
        if (!r2Id) continue;

        const side = spec.tableauPosition % 2 === 1 ? 'left_id' : 'right_id';
        db.prepare(`UPDATE bouts SET ${side} = ? WHERE id = ?`).run(winner.competitor_id, r2Id);
      }

      return phaseId;
    })();

    return this.findById(phaseId);
  },

  // ---------------------------------------------------------------------------
  // Simulate: randomly score all pending bouts in the phase.
  // Pool: scores every pending bout.
  // DE: processes round by round so each winner is placed before the next
  //     round is simulated.
  // Returns count of bouts simulated.
  // ---------------------------------------------------------------------------
  simulate(phaseId) {
    const phase = this.findById(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found'), { status: 404 });
    if (phase.status !== 'active') throw Object.assign(new Error('Phase must be active to simulate'), { status: 400 });

    let touchTarget = phase.type === 'de' ? 15 : 5;
    try {
      const rule = loadRule(phase.rule_doc);
      touchTarget = rule.bout?.touchTarget ?? touchTarget;
    } catch {}

    function randomScores(target) {
      const winnerLeft = Math.random() < 0.5;
      const loserScore = Math.floor(Math.random() * target);
      return winnerLeft ? [target, loserScore] : [loserScore, target];
    }

    const Bout = require('./bouts');
    let count = 0;

    if (phase.type === 'pool') {
      const pending = db.prepare(`
        SELECT id FROM bouts
        WHERE phase_id=? AND status='pending'
          AND left_id IS NOT NULL AND right_id IS NOT NULL
      `).all(phaseId);
      for (const b of pending) {
        const [ls, rs] = randomScores(touchTarget);
        Bout.updateScore(b.id, ls, rs);
        count++;
      }
    } else if (phase.type === 'de') {
      const maxRound = db.prepare(
        'SELECT MAX(de_round) AS m FROM bouts WHERE phase_id=?'
      ).get(phaseId).m || 1;

      for (let r = 1; r <= maxRound; r++) {
        const pending = db.prepare(`
          SELECT id FROM bouts
          WHERE phase_id=? AND de_round=? AND status='pending'
            AND left_id IS NOT NULL AND right_id IS NOT NULL
        `).all(phaseId, r);
        for (const b of pending) {
          const [ls, rs] = randomScores(touchTarget);
          Bout.updateScore(b.id, ls, rs);
          count++;
        }
      }
    }

    return { simulated: count };
  },

  // ---------------------------------------------------------------------------
  // Reopen a finished phase: undo the close — restore eliminated competitors,
  // drop saved rankings, set phase and pools back to active.
  // Scores are untouched; the manager re-closes when ready.
  // ---------------------------------------------------------------------------
  reopen(id) {
    db.transaction(() => {
      const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(id);
      if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });
      if (phase.status !== 'finished') throw Object.assign(new Error('Only finished phases can be reopened.'), { status: 400 });

      // Restore competitors eliminated by this phase
      db.prepare(`
        UPDATE competitors SET status='active', eliminated_after=NULL, final_rank=NULL
        WHERE eliminated_after = ?
      `).run(id);

      // Drop saved rankings (live rankings are recomputed on the fly)
      db.prepare('DELETE FROM rankings WHERE phase_id = ?').run(id);

      // Set phase and pools back to active
      db.prepare("UPDATE phases SET status='active' WHERE id=?").run(id);
      db.prepare("UPDATE pools  SET status='active' WHERE phase_id=?").run(id);
    })();
  },

  delete(id) {
    db.transaction(() => {
      // Restore any competitors eliminated by this phase before cascading
      db.prepare(`
        UPDATE competitors SET status='active', eliminated_after=NULL, final_rank=NULL
        WHERE eliminated_after = ?
      `).run(id);
      db.prepare('DELETE FROM phases WHERE id = ?').run(id);
    })();
  },
};

module.exports = Phase;
