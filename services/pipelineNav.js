'use strict';
// Live OPP2 bout-navigation hot path: activeSlot/markActive/markDone,
// pendingBoutCount, nextBout/prevBout, and the relay-resolution helpers they
// need. Split out of the former services/pipeline.js god-file (2026-07-29) —
// see services/pipeline.js for the orchestrator that recombines this with
// pipelineSlots.js/pipelineRosters.js into the same public `Pipeline` API
// every existing caller already uses.
const db = require('../db');
const DeLayout = require('./deLayout');
const PipelineSlots = require('./pipelineSlots');
const { DE_BOUT_ORDER, deSlotParams } = require('../lib/deSlotMath');

// type != 'virtual' on both of these: a virtual slot is a placeholder with no
// real bouts/roster behind it (services/pipelineVirtualSlots.js), and must
// never become "the current thing" this live hot path serves to an
// apparatus. See CLAUDE.md/the plan doc for the incident this guards
// against — handlePrevSlot (lib/opp2Client.js) does not gate on a real bout
// existing before publishing a record, so an unguarded virtual slot reaching
// here could push a misleading MQTT message to real hardware.
const stmtActiveSlot  = db.prepare(`
  SELECT * FROM pipeline_slots
  WHERE strip_id = ? AND status IN ('active', 'pending') AND type != 'virtual'
  ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, slot_order
  LIMIT 1
`);
const stmtMarkActive     = db.prepare("UPDATE pipeline_slots SET status='active'  WHERE id=?");
const stmtMarkDone       = db.prepare("UPDATE pipeline_slots SET status='done'    WHERE id=?");
const stmtSlotStripId    = db.prepare('SELECT strip_id FROM pipeline_slots WHERE id=?');
const stmtActiveCount    = db.prepare("SELECT COUNT(*) AS n FROM pipeline_slots WHERE strip_id=? AND status IN ('pending','active')");
const stmtSetStripIdle   = db.prepare("UPDATE strips SET status='idle' WHERE id=?");
const stmtPendingPool    = db.prepare(`
  SELECT COUNT(*) AS n FROM bouts b
  JOIN pools po ON po.id = b.pool_id
  WHERE b.pool_id = @pool_id AND b.status != 'finished'
    AND (po.strip_count <= 1 OR b.strip_id = @strip_id)
`);
const stmtPendingTeam    = db.prepare("SELECT COUNT(*) AS n FROM relays WHERE team_match_id=?  AND status!='finished'");
const stmtConfirmedPool  = db.prepare(`
  SELECT COUNT(*) AS n FROM bouts b
  JOIN pools po ON po.id = b.pool_id
  WHERE b.pool_id = @pool_id AND b.status = 'finished'
    AND (po.strip_count <= 1 OR b.strip_id = @strip_id)
`);
const stmtConfirmedTeam  = db.prepare("SELECT COUNT(*) AS n FROM relays WHERE team_match_id=? AND status='finished'");
const stmtStaleDoneSlots = db.prepare("SELECT * FROM pipeline_slots WHERE strip_id=? AND status='done' ORDER BY slot_order");
const stmtRecoverSlot    = db.prepare("UPDATE pipeline_slots SET status='pending' WHERE id=?");
// Same type != 'virtual' guard as stmtActiveSlot above — a separate query,
// not covered by that one, and the one handlePrevSlot actually calls.
const stmtPrevSlotForStrip = db.prepare(
  "SELECT * FROM pipeline_slots WHERE strip_id = ? AND slot_order < ? AND type != 'virtual' ORDER BY slot_order DESC LIMIT 1"
);
const stmtRefereeName    = db.prepare(`
  SELECT p.first_name AS ref_first, p.last_name AS ref_last, p.nationality AS ref_nation
  FROM referees r JOIN people p ON p.id = r.person_id WHERE r.id = ?
`);
const stmtPoolStripCount = db.prepare('SELECT strip_count FROM pools WHERE id = ?');
const stmtRelayNext = db.prepare(`
  SELECT id, relay_number, target, status, left_touches, right_touches,
         left_position, right_position
  FROM relays
  WHERE team_match_id = ?
    AND status != 'finished'
    AND (? IS NULL OR relay_number > (SELECT relay_number FROM relays WHERE id = ?))
  ORDER BY relay_number LIMIT 1
`);
const stmtRelayNextFallback = db.prepare(`
  SELECT id, relay_number, target, status, left_touches, right_touches,
         left_position, right_position
  FROM relays
  WHERE team_match_id = ? AND status != 'finished' AND id != ?
  ORDER BY relay_number LIMIT 1
`);
const stmtRelayPrev = db.prepare(`
  SELECT id, relay_number, target, status, left_touches, right_touches,
         left_position, right_position
  FROM relays
  WHERE team_match_id = ?
    AND relay_number < (SELECT relay_number FROM relays WHERE id = ?)
  ORDER BY relay_number DESC LIMIT 1
`);
const stmtResolveRelayFencerOrder = db.prepare(`
  SELECT COALESCE(sub.substitute_competitor_id, ord.competitor_id) AS competitor_id
  FROM team_match_orders ord
  LEFT JOIN team_match_substitutions sub
    ON sub.team_match_id = ord.team_match_id
    AND sub.team_id = ord.team_id
    AND sub.position_replaced = ord.position
    AND sub.effective_from_relay <= ?
  WHERE ord.team_match_id = ? AND ord.position = ?
`);
// Fixed 2026-07-29 (found while hoisting): this previously joined through a
// `co.fencer_id` column that competitors has never had — competitors carries
// its own first_name/last_name/nationality snapshot directly (see
// services/competitors.js's BASE query), the same schema mismatch found and
// fixed the same day in services/teamMatches.js's _fencerName. Latent since
// this was written: any team match with orders submitted would crash the
// instant nextBout/prevBout tried to resolve a relay fencer for real.
const stmtResolveRelayFencerDetails = db.prepare(`
  SELECT id AS competitor_id, first_name, last_name, nationality
  FROM competitors
  WHERE id = ?
`);
const stmtRelayMatchInfo = db.prepare(`
  SELECT tm.id, tm.left_team_id, tm.right_team_id, tm.phase_id,
         tl.name AS left_team_name, tr.name AS right_team_name,
         ph.phase_order,
         co.name AS competition_name, co.weapon
  FROM team_matches tm
  LEFT JOIN teams tl ON tl.id = tm.left_team_id
  LEFT JOIN teams tr ON tr.id = tm.right_team_id
  JOIN phases ph       ON ph.id = tm.phase_id
  JOIN competitions co ON co.id = ph.competition_id
  WHERE tm.id = ?
`);
const stmtPhaseRuleDocForRelay = db.prepare('SELECT rule_doc FROM phases WHERE id = ?');
const stmtRelayCumulative = db.prepare(`
  SELECT COALESCE(SUM(left_touches),  0) AS cum_left,
         COALESCE(SUM(right_touches), 0) AS cum_right
  FROM relays
  WHERE team_match_id = ? AND relay_number < ? AND status = 'finished'
`);
const stmtRelayTotalCount = db.prepare(
  'SELECT COUNT(*) AS n FROM relays WHERE team_match_id = ?'
);

// DE_BOUT_ORDER is a fixed module-level string, so every query embedding it
// via template literal below is still 100% static SQL text — the `${...}`
// is a compile-time JS concatenation, not a per-call variable clause.
const stmtDePendingCount = db.prepare(`
  WITH ordered AS (${DE_BOUT_ORDER})
  SELECT COUNT(*) AS n FROM bouts b
  JOIN ordered o ON o.id = b.id
  WHERE b.phase_id=? AND b.de_round=?
    AND o.round_index BETWEEN ? AND ?
    AND b.status != 'finished'
    AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
`);
const stmtDeConfirmedCount = db.prepare(`
  WITH ordered AS (${DE_BOUT_ORDER})
  SELECT COUNT(*) AS n FROM bouts b
  JOIN ordered o ON o.id = b.id
  WHERE b.phase_id=? AND b.de_round=?
    AND o.round_index BETWEEN ? AND ?
    AND b.status = 'finished'
    AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
`);
const stmtDeNext = db.prepare(`
  WITH ordered AS (${DE_BOUT_ORDER})
  SELECT b.*, b.id AS bout_id, o.round_index,
    lc.first_name AS left_first,  lc.last_name  AS left_last,
    lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
    rc.first_name AS right_first, rc.last_name  AS right_last,
    rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
    ph.phase_order,
    co.name AS competition_name, co.weapon
  FROM bouts b
  JOIN ordered o ON o.id = b.id
  JOIN phases     ph  ON ph.id  = b.phase_id
  JOIN competitions co ON co.id = ph.competition_id
  LEFT JOIN competitors lc  ON lc.id  = b.left_id
  LEFT JOIN people      lpl ON lpl.id = lc.person_id
  LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
  LEFT JOIN competitors rc  ON rc.id  = b.right_id
  LEFT JOIN people      rpl ON rpl.id = rc.person_id
  LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
  WHERE b.phase_id = ? AND b.de_round = ?
    AND o.round_index BETWEEN ? AND ?
    AND b.status != 'finished'
    AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
    AND (? IS NULL OR o.round_index > (
          SELECT o2.round_index FROM ordered o2 WHERE o2.id = ?
        ))
  ORDER BY o.round_index
  LIMIT 1
`);
const stmtDePrev = db.prepare(`
  WITH ordered AS (${DE_BOUT_ORDER})
  SELECT b.*, b.id AS bout_id, o.round_index,
    lc.first_name AS left_first,  lc.last_name  AS left_last,
    lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
    rc.first_name AS right_first, rc.last_name  AS right_last,
    rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
    ph.phase_order, co.name AS competition_name, co.weapon
  FROM bouts b
  JOIN ordered o ON o.id = b.id
  JOIN phases ph ON ph.id = b.phase_id
  JOIN competitions co ON co.id = ph.competition_id
  LEFT JOIN competitors lc  ON lc.id  = b.left_id
  LEFT JOIN people      lpl ON lpl.id = lc.person_id
  LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
  LEFT JOIN competitors rc  ON rc.id  = b.right_id
  LEFT JOIN people      rpl ON rpl.id = rc.person_id
  LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
  WHERE b.phase_id = ? AND b.de_round = ?
    AND o.round_index BETWEEN ? AND ?
    AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
    AND o.round_index < (SELECT o2.round_index FROM ordered o2 WHERE o2.id = ?)
  ORDER BY o.round_index DESC
  LIMIT 1
`);

// Attach referee name fields to a bout result using slot.referee_id.
function attachReferee(bout, slot) {
  if (!bout || !slot.referee_id) return bout;
  const ref = stmtRefereeName.get(slot.referee_id);
  if (ref) { bout.ref_first = ref.ref_first; bout.ref_last = ref.ref_last; bout.ref_nation = ref.ref_nation; }
  return bout;
}

// Resolve which competitor fences at a given position for a given relay.
function resolveRelayFencer(matchId, position, relayNumber) {
  if (!position) return null;
  const row = stmtResolveRelayFencerOrder.get(relayNumber, matchId, position);
  if (!row?.competitor_id) return null;
  return stmtResolveRelayFencerDetails.get(row.competitor_id);
}

// Build the full relay bout object returned by nextBout / prevBout for team_match slots.
function buildRelayBout(matchId, relay) {
  const match = stmtRelayMatchInfo.get(matchId);
  if (!match) return null;

  // left_position/right_position may be null for relays created before migration 017.
  // Fall back to the rule definition (indexed by relay_number) when not stored on the row.
  let leftPos  = relay.left_position;
  let rightPos = relay.right_position;
  if (leftPos == null || rightPos == null) {
    const phaseRow = stmtPhaseRuleDocForRelay.get(match.phase_id);
    const rule     = require('../lib/rules').loadRule(phaseRow.rule_doc);
    const def      = rule.relays?.[relay.relay_number - 1];
    if (def) { leftPos = def.left; rightPos = def.right; }
  }

  const leftFencer  = resolveRelayFencer(matchId, leftPos,  relay.relay_number);
  const rightFencer = resolveRelayFencer(matchId, rightPos, relay.relay_number);

  const cumul = stmtRelayCumulative.get(matchId, relay.relay_number);

  const relayTotal = stmtRelayTotalCount.get(matchId).n;

  return {
    id:              relay.id,
    relay_number:    relay.relay_number,
    relay_total:     relayTotal,
    target:          relay.target,
    status:          relay.status,
    left_touches:    relay.left_touches,
    right_touches:   relay.right_touches,
    left_position:   leftPos,
    right_position:  rightPos,
    left_id:         leftFencer?.competitor_id  ?? null,
    left_first:      leftFencer?.first_name     ?? '',
    left_last:       leftFencer?.last_name      ?? '',
    left_nation:     leftFencer?.nationality    ?? '',
    right_id:        rightFencer?.competitor_id ?? null,
    right_first:     rightFencer?.first_name    ?? '',
    right_last:      rightFencer?.last_name     ?? '',
    right_nation:    rightFencer?.nationality   ?? '',
    team_match_id:   matchId,
    left_team_id:    match.left_team_id,
    left_team_name:  match.left_team_name,
    right_team_id:   match.right_team_id,
    right_team_name: match.right_team_name,
    cumul_left:      cumul.cum_left,
    cumul_right:     cumul.cum_right,
    weapon:          match.weapon,
    competition_name: match.competition_name,
    phase_order:     match.phase_order,
  };
}

const PipelineNav = {
  activeSlot(stripId) {
    return stmtActiveSlot.get(stripId) || null;
  },

  markActive(slotId) {
    stmtMarkActive.run(slotId);
  },

  markDone(slotId) {
    stmtMarkDone.run(slotId);
    const slot = stmtSlotStripId.get(slotId);
    if (slot) {
      const active = stmtActiveCount.get(slot.strip_id).n;
      if (active === 0) stmtSetStripIdle.run(slot.strip_id);
    }
  },

  markPending(slotId) {
    stmtRecoverSlot.run(slotId);
  },

  recoverStaleSlot(stripId) {
    const slots = stmtStaleDoneSlots.all(stripId);
    for (const slot of slots) {
      if (PipelineNav.pendingBoutCount(slot) > 0) {
        PipelineNav.markPending(slot.id);
        return PipelineSlots.findById(slot.id);
      }
    }
    return null;
  },

  pendingBoutCount(slot) {
    if (slot.type === 'pool') {
      return stmtPendingPool.get({ pool_id: slot.pool_id, strip_id: slot.strip_id }).n;
    }
    if (slot.type === 'team_match') {
      if (!slot.team_match_id) return 0;
      return stmtPendingTeam.get(slot.team_match_id).n;
    }
    if (slot.bracket === 'placement') {
      const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
      if (!ids.length) return 0;
      // dynamic-sql-ok: IN(...) placeholder count varies with ids.length
      return db.prepare(`
        SELECT COUNT(*) AS n FROM bouts
        WHERE id IN (${ids.map(() => '?').join(',')})
          AND status != 'finished' AND left_id IS NOT NULL AND right_id IS NOT NULL
      `).get(...ids).n;
    }
    const { deRound, lo, hi, bracket } = deSlotParams(slot);
    if (!deRound) return 0;
    return stmtDePendingCount.get(bracket, slot.phase_id, deRound, lo, hi).n;
  },

  // Mirrors pendingBoutCount but counts confirmed (finished) bouts instead —
  // used to guard PREV_SLOT (Section 17): stepping back to a previous slot
  // is only safe while the current one has zero confirmed results, otherwise
  // it would silently undo real results.
  confirmedBoutCount(slot) {
    if (slot.type === 'pool') {
      return stmtConfirmedPool.get({ pool_id: slot.pool_id, strip_id: slot.strip_id }).n;
    }
    if (slot.type === 'team_match') {
      if (!slot.team_match_id) return 0;
      return stmtConfirmedTeam.get(slot.team_match_id).n;
    }
    if (slot.bracket === 'placement') {
      const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
      if (!ids.length) return 0;
      // dynamic-sql-ok: IN(...) placeholder count varies with ids.length
      return db.prepare(`
        SELECT COUNT(*) AS n FROM bouts
        WHERE id IN (${ids.map(() => '?').join(',')})
          AND status = 'finished' AND left_id IS NOT NULL AND right_id IS NOT NULL
      `).get(...ids).n;
    }
    const { deRound, lo, hi, bracket } = deSlotParams(slot);
    if (!deRound) return 0;
    return stmtDeConfirmedCount.get(bracket, slot.phase_id, deRound, lo, hi).n;
  },

  // The slot immediately before this one in slot_order on the same strip —
  // the target of a PREV_SLOT request. Null if this is the first slot.
  prevSlotFor(slot) {
    return stmtPrevSlotForStrip.get(slot.strip_id, slot.slot_order) || null;
  },

  nextBout(slot, afterBoutId = null) {
    if (slot.type === 'team_match') {
      const relay = stmtRelayNext.get(slot.team_match_id, afterBoutId, afterBoutId);

      const effective = relay || (afterBoutId
        ? stmtRelayNextFallback.get(slot.team_match_id, afterBoutId)
        : null);

      return effective ? buildRelayBout(slot.team_match_id, effective) : null;
    }

    if (slot.type === 'pool') {
      const POOL_JOIN = `
        SELECT b.*, b.id AS bout_id,
          lc.first_name AS left_first,  lc.last_name  AS left_last,
          lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
          rc.first_name AS right_first, rc.last_name  AS right_last,
          rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
          ref_p.first_name AS ref_first, ref_p.last_name AS ref_last,
          po.pool_number,
          ph.phase_order,
          co.name AS competition_name, co.weapon
        FROM bouts b
        JOIN pools      po  ON po.id  = b.pool_id
        JOIN phases     ph  ON ph.id  = po.phase_id
        JOIN competitions co ON co.id = ph.competition_id
        LEFT JOIN competitors lc  ON lc.id  = b.left_id
        LEFT JOIN people      lpl ON lpl.id = lc.person_id
        LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
        LEFT JOIN competitors rc  ON rc.id  = b.right_id
        LEFT JOIN people      rpl ON rpl.id = rc.person_id
        LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
        LEFT JOIN pools       po2 ON po2.id = b.pool_id
        LEFT JOIN referees    ref ON ref.id  = po2.referee_id
        LEFT JOIN people      ref_p ON ref_p.id = ref.person_id
      `;

      // For multi-strip pools, filter by strip_id so each strip sees only its bouts.
      // strip_count > 1 means the pool was distributed; bouts.strip_id is set per bout.
      const pool = stmtPoolStripCount.get(slot.pool_id);
      const stripFilter = (pool && pool.strip_count > 1)
        ? `AND b.strip_id = ${Number(slot.strip_id)}`
        : '';

      // dynamic-sql-ok: stripFilter clause is conditionally present (multi-strip pools only)
      const forward = db.prepare(`${POOL_JOIN}
        WHERE b.pool_id = ?
          ${stripFilter}
          AND b.status != 'finished'
          AND (? IS NULL OR b.bout_order > (SELECT bout_order FROM bouts WHERE id = ?))
        ORDER BY b.bout_order LIMIT 1
      `).get(slot.pool_id, afterBoutId, afterBoutId);
      if (forward) return forward;

      if (!afterBoutId) return null;
      // dynamic-sql-ok: stripFilter clause is conditionally present (multi-strip pools only)
      return db.prepare(`${POOL_JOIN}
        WHERE b.pool_id = ? ${stripFilter} AND b.status != 'finished' AND b.id != ?
        ORDER BY b.bout_order LIMIT 1
      `).get(slot.pool_id, afterBoutId) || null;
    }

    if (slot.bracket === 'placement') {
      const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
      if (!ids.length) return null;
      const idList = ids.map(() => '?').join(',');
      const PLACEMENT_JOIN = `
        SELECT b.*, b.id AS bout_id,
          lc.first_name AS left_first,  lc.last_name  AS left_last,
          lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
          rc.first_name AS right_first, rc.last_name  AS right_last,
          rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
          ph.phase_order,
          co.name AS competition_name, co.weapon
        FROM bouts b
        JOIN phases     ph  ON ph.id  = b.phase_id
        JOIN competitions co ON co.id = ph.competition_id
        LEFT JOIN competitors lc  ON lc.id  = b.left_id
        LEFT JOIN people      lpl ON lpl.id = lc.person_id
        LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
        LEFT JOIN competitors rc  ON rc.id  = b.right_id
        LEFT JOIN people      rpl ON rpl.id = rc.person_id
        LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
      `;
      // dynamic-sql-ok: IN(...) placeholder count varies with ids.length
      const forward = db.prepare(`${PLACEMENT_JOIN}
        WHERE b.id IN (${idList})
          AND b.status != 'finished'
          AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
          AND (? IS NULL OR b.bout_order > (SELECT bout_order FROM bouts WHERE id = ?))
        ORDER BY b.bout_order LIMIT 1
      `).get(...ids, afterBoutId, afterBoutId);
      // dynamic-sql-ok: IN(...) placeholder count varies with ids.length
      const bout = forward || (afterBoutId ? db.prepare(`${PLACEMENT_JOIN}
        WHERE b.id IN (${idList}) AND b.status != 'finished'
          AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL AND b.id != ?
        ORDER BY b.bout_order LIMIT 1
      `).get(...ids, afterBoutId) : null);
      return attachReferee(bout, slot);
    }

    const { deRound, lo, hi, bracket } = deSlotParams(slot);
    if (!deRound) return null;

    const bout = stmtDeNext.get(bracket, slot.phase_id, deRound, lo, hi, afterBoutId, afterBoutId);
    return attachReferee(bout, slot);
  },

  // Return the next `limit` pending bouts for a pool slot (for dynamic reorder lookahead).
  nextBoutsAhead(slot, afterBoutId, limit = 4) {
    if (slot.type !== 'pool') return [];
    const pool = stmtPoolStripCount.get(slot.pool_id);
    const stripFilter = (pool && pool.strip_count > 1)
      ? `AND b.strip_id = ${Number(slot.strip_id)}`
      : '';
    const POOL_JOIN = `
      SELECT b.id, b.bout_order, b.left_id, b.right_id, b.pool_id, b.strip_id
      FROM bouts b
    `;
    // dynamic-sql-ok: stripFilter clause is conditionally present (multi-strip pools only)
    return db.prepare(`${POOL_JOIN}
      WHERE b.pool_id = ?
        ${stripFilter}
        AND b.status != 'finished'
        AND (? IS NULL OR b.bout_order > (SELECT bout_order FROM bouts WHERE id = ?))
      ORDER BY b.bout_order LIMIT ?
    `).all(slot.pool_id, afterBoutId, afterBoutId, limit);
  },

  prevBout(slot, beforeBoutId) {
    if (!beforeBoutId) return null;

    if (slot.type === 'team_match') {
      const relay = stmtRelayPrev.get(slot.team_match_id, beforeBoutId);
      return relay ? buildRelayBout(slot.team_match_id, relay) : null;
    }

    if (slot.type === 'pool') {
      const POOL_JOIN = `
        SELECT b.*, b.id AS bout_id,
          lc.first_name AS left_first,  lc.last_name  AS left_last,
          lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
          rc.first_name AS right_first, rc.last_name  AS right_last,
          rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
          ref_p.first_name AS ref_first, ref_p.last_name AS ref_last,
          po.pool_number, ph.phase_order,
          co.name AS competition_name, co.weapon
        FROM bouts b
        JOIN pools      po  ON po.id  = b.pool_id
        JOIN phases     ph  ON ph.id  = po.phase_id
        JOIN competitions co ON co.id = ph.competition_id
        LEFT JOIN competitors lc  ON lc.id  = b.left_id
        LEFT JOIN people      lpl ON lpl.id = lc.person_id
        LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
        LEFT JOIN competitors rc  ON rc.id  = b.right_id
        LEFT JOIN people      rpl ON rpl.id = rc.person_id
        LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
        LEFT JOIN pools       po2 ON po2.id = b.pool_id
        LEFT JOIN referees    ref ON ref.id  = po2.referee_id
        LEFT JOIN people      ref_p ON ref_p.id = ref.person_id
      `;

      const pool2 = stmtPoolStripCount.get(slot.pool_id);
      const stripFilter2 = (pool2 && pool2.strip_count > 1)
        ? `AND b.strip_id = ${Number(slot.strip_id)}`
        : '';
      // dynamic-sql-ok: stripFilter clause is conditionally present (multi-strip pools only)
      return db.prepare(`${POOL_JOIN}
        WHERE b.pool_id = ?
          ${stripFilter2}
          AND b.bout_order < (SELECT bout_order FROM bouts WHERE id = ?)
        ORDER BY b.bout_order DESC LIMIT 1
      `).get(slot.pool_id, beforeBoutId) || null;
    }

    if (slot.bracket === 'placement') {
      const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
      if (!ids.length) return null;
      const idList = ids.map(() => '?').join(',');
      // dynamic-sql-ok: IN(...) placeholder count varies with ids.length
      const bout = db.prepare(`
        SELECT b.*, b.id AS bout_id,
          lc.first_name AS left_first,  lc.last_name  AS left_last,
          lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
          rc.first_name AS right_first, rc.last_name  AS right_last,
          rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
          ph.phase_order, co.name AS competition_name, co.weapon
        FROM bouts b
        JOIN phases ph ON ph.id = b.phase_id
        JOIN competitions co ON co.id = ph.competition_id
        LEFT JOIN competitors lc  ON lc.id  = b.left_id
        LEFT JOIN people      lpl ON lpl.id = lc.person_id
        LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
        LEFT JOIN competitors rc  ON rc.id  = b.right_id
        LEFT JOIN people      rpl ON rpl.id = rc.person_id
        LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
        WHERE b.id IN (${idList})
          AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
          AND b.bout_order < (SELECT bout_order FROM bouts WHERE id = ?)
        ORDER BY b.bout_order DESC LIMIT 1
      `).get(...ids, beforeBoutId);
      return attachReferee(bout, slot);
    }

    const { deRound, lo, hi, bracket } = deSlotParams(slot);
    if (!deRound) return null;

    const bout = stmtDePrev.get(bracket, slot.phase_id, deRound, lo, hi, beforeBoutId);
    return attachReferee(bout, slot);
  },

  // Public alias used by opp2Composer to build bout queries from a DE slot.
  resolveDeSlot(slot) { return deSlotParams(slot); },

  // Resolve which competitor fences at a given position for a given relay —
  // exposed on the public Pipeline API (lib/opp2Composer.js calls this
  // directly as Pipeline._resolveRelayFencer, not just internally here).
  _resolveRelayFencer: resolveRelayFencer,
};

module.exports = PipelineNav;
