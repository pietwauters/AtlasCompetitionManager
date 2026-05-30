'use strict';

const db             = require('../db');
const { loadRule }   = require('../lib/rules');
const { formPools, calcPoolOptions } = require('../lib/poolFormation');
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

    // Recommended: equal-size pool divisible by 7 or 6, otherwise first option
    let recommended = 0;
    if (N % 7 === 0 || N % 6 === 0) {
      const idx = options.findIndex(o => o.every(s => s === o[0]));
      if (idx >= 0) recommended = idx;
    }

    return { options, recommended, fencerCount: N, ruleDoc };
  },

  // ---------------------------------------------------------------------------
  // Create pool phase: insert phase + pools + pool_competitors + bouts.
  // chosenSizes: sorted-desc array, e.g. [7, 7, 6]
  // ---------------------------------------------------------------------------
  create(compId, ruleDoc, chosenSizes) {
    const rule       = loadRule(ruleDoc);
    const competitors = Competitor.findAll(compId).filter(c => c.competitor_status === 'active');

    if (!competitors.length) throw Object.assign(new Error('No active competitors.'), { status: 400 });

    // Map competitors to the shape expected by formPools / boutOrder
    const fencerInput = competitors.map(c => ({
      id:            c.competitor_id,   // used internally by poolFormation
      competitor_id: c.competitor_id,
      initial_seed:  c.initial_seed,
      nationality:   c.nationality,
      club:          c.club_name,       // separation field name in rule JSON
      first_name:    c.first_name,
      last_name:     c.last_name,
    }));

    const pools = formPools(fencerInput, chosenSizes, rule.poolFormation);

    const phaseId = db.transaction(() => {
      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(phase_order), 0) AS m FROM phases WHERE competition_id = ?'
      ).get(compId).m;

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
    try { criteria = loadRule(phase.rule_doc).seeding?.criteria || DEFAULT_CRITERIA; } catch {}

    // All competitors in this phase
    const competitorRows = db.prepare(`
      SELECT DISTINCT pc.competitor_id, c.initial_seed,
        p.first_name, p.last_name, cl.name AS club_name, p.nationality
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

    const sorted = Object.values(stats).sort((a, b) => {
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
    });

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

    let advanceN = N;
    if (adv.eliminateAfterPhase !== false) {
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
      advanceN = Math.max(1, Math.min(advanceN, N));
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

  delete(id) {
    return db.prepare('DELETE FROM phases WHERE id = ?').run(id);
  },
};

module.exports = Phase;
