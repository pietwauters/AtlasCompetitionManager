'use strict';
const db       = require('../db');
const Pipeline = require('../services/pipeline');
const { PROTOCOL, VERSION, topic, nextSeq, publish, rawPublish, clearRetained, isConnected } =
  require('./opp2Transport');

// ── Bout queries ─────────────────────────────────────────────────────────────

const FENCER_JOIN = `
  LEFT JOIN competitors lc  ON lc.id = b.left_id
  LEFT JOIN competitors rc  ON rc.id = b.right_id
`;

const stmtPoolBoutsForSlot = db.prepare(`
  SELECT b.id, b.left_id, b.right_id, b.status,
         b.left_score, b.right_score, b.winner_id, b.bout_order,
         lc.first_name AS left_first,  lc.last_name AS left_last,  lc.nationality AS left_nation,
         rc.first_name AS right_first, rc.last_name AS right_last, rc.nationality AS right_nation
  FROM bouts b ${FENCER_JOIN}
  WHERE b.pool_id = ?
  ORDER BY b.bout_order
`);

const stmtDEBoutsForSlot = db.prepare(`
  WITH ordered AS (
    SELECT b.id,
           ROW_NUMBER() OVER (PARTITION BY b.phase_id, b.de_round
                              ORDER BY b.tableau_position) AS round_index
    FROM bouts b WHERE b.de_round IS NOT NULL AND b.bracket = 'main'
  )
  SELECT b.id, b.left_id, b.right_id, b.status,
         b.left_score, b.right_score, b.winner_id, o.round_index,
         lc.first_name AS left_first,  lc.last_name AS left_last,  lc.nationality AS left_nation,
         rc.first_name AS right_first, rc.last_name AS right_last, rc.nationality AS right_nation
  FROM bouts b
  JOIN ordered o ON o.id = b.id
  ${FENCER_JOIN}
  WHERE b.phase_id = ? AND b.de_round = ?
    AND o.round_index BETWEEN ? AND ?
    AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
  ORDER BY o.round_index
`);

const stmtPoolParticipants = db.prepare(`
  SELECT c.id AS competitor_id, c.first_name, c.last_name, c.nationality
  FROM pool_competitors pc
  JOIN competitors c ON c.id = pc.competitor_id
  WHERE pc.pool_id = ?
  ORDER BY COALESCE(pc.pool_slot, c.initial_seed) ASC, c.last_name
`);

const stmtTeamMatchPhaseId = db.prepare('SELECT phase_id FROM team_matches WHERE id = ?');
const stmtPhaseRuleDoc     = db.prepare('SELECT rule_doc FROM phases WHERE id = ?');
const stmtRelaysForMatch   = db.prepare(`
  SELECT id, relay_number, left_touches, right_touches, status, left_position, right_position
  FROM relays WHERE team_match_id = ? ORDER BY relay_number
`);

function getBoutsForSlot(slot) {
  if (slot.type === 'pool') {
    return stmtPoolBoutsForSlot.all(slot.pool_id);
  }

  // DE slot: use bracket/tableau/partition to identify the round and range.
  const { deRound, lo, hi } = Pipeline.resolveDeSlot(slot);
  return stmtDEBoutsForSlot.all(slot.phase_id, deRound, lo, hi);
}

function getParticipantsForPool(poolId) {
  return stmtPoolParticipants.all(poolId).map(r => ({
    id:         String(r.competitor_id),
    name:       `${r.first_name} ${r.last_name}`,
    last_name:  r.last_name  || '',
    first_name: r.first_name || '',
    nation:     r.nationality || '',
  }));
}

// ── OPP2 message senders ─────────────────────────────────────────────────────

function isCorrectEnding(score) {
  if (!score) return false;
  const { left, right, priority } = score;
  const abnormal = s => s === 'A' || s === 'E';
  if (abnormal(left?.status) || abnormal(right?.status)) return true;
  if ((left?.score ?? 0) !== (right?.score ?? 0)) return true;
  if (priority === 'L' || priority === 'R') return true;
  return false;
}

function sendAck(pisteId) { publish(pisteId, 'control', { ts: Date.now(), command: 'ACK' }); }
function sendNak(pisteId) { publish(pisteId, 'control', { ts: Date.now(), command: 'NAK' }); }

// Format a Pipeline referee/official record ({referee_id, first_name, last_name, nation})
// as the spec's {id, name, nation} shape (docs/level2.md — same shape used by
// common.referee, software/record's officials, etc.). Undefined when absent, so
// callers can spread the result in without ever producing an empty object.
function officialToWire(o) {
  if (!o) return undefined;
  return { id: String(o.referee_id), name: `${o.first_name} ${o.last_name}`.trim(), nation: o.nation || '' };
}

// Build the OPP2 software/fencers "common" block for a slot. Per spec
// (docs/level2.md §15), only the primary referee belongs here — the
// apparatus (and Cyrano-compatible systems) never need more than that.
// Second referee / video official / assessors live in software/record §17
// instead. Returns undefined when no referee is assigned.
function buildFencersCommon(slot) {
  const referee = officialToWire(Pipeline.refereeName(slot.referee_id));
  return referee ? { referee } : undefined;
}

// Build the full officiating roster for software/record (docs/level2.md §17):
// referee, referee2, video_official, assessor1, assessor2 — whichever are
// assigned. Spreadable directly into the payload object.
function buildRecordOfficials(slot) {
  const officials = Pipeline.getOfficials(slot.id);
  return {
    referee:         officialToWire(Pipeline.refereeName(slot.referee_id)),
    referee2:        officialToWire(officials.referee2),
    video_official:  officialToWire(officials.video_assistant),
    assessor1:       officialToWire(officials.assessor1),
    assessor2:       officialToWire(officials.assessor2),
  };
}

// pisteEntry = pisteState[pisteId] — passed by reference so we can update lastScore in-place.
function sendMatchData(pisteId, bout, slot, pisteEntry, { identifyingOnly = false } = {}) {
  if (!bout) return;

  if (slot.type === 'team_match') {
    return _sendRelayData(pisteId, bout, slot, pisteEntry, identifyingOnly);
  }

  const fencers = {
    left: { fencer: {
      id:     String(bout.left_id),
      name:   `${bout.left_first} ${bout.left_last}`,
      nation: bout.left_nation || '',
      ...(bout.left_club      ? { club:      bout.left_club }      : {}),
      ...(bout.left_club_abbr ? { club_abbr: bout.left_club_abbr } : {}),
    }},
    right: { fencer: {
      id:     String(bout.right_id),
      name:   `${bout.right_first} ${bout.right_last}`,
      nation: bout.right_nation || '',
      ...(bout.right_club      ? { club:      bout.right_club }      : {}),
      ...(bout.right_club_abbr ? { club_abbr: bout.right_club_abbr } : {}),
    }},
  };
  const common = buildFencersCommon(slot);
  if (common) fencers.common = common;
  publish(pisteId, 'fencers', fencers);

  const weaponMap = { foil: 'F', epee: 'E', sabre: 'S' };
  publish(pisteId, 'match', {
    weapon:      weaponMap[bout.weapon] || bout.weapon || 'F',
    type:        'I',
    competition: bout.competition_name || '',
    phase_type:  slot.type === 'pool' ? 'pool' : 'DE',
    phase:       String(bout.phase_order || ''),
    poule:       slot.type === 'pool'
                   ? String(bout.pool_number || '')
                   : `R${bout.de_round}`,
    match:       bout.bout_order ?? bout.round_index ?? 0,
    round:       1,
  });

  if (!identifyingOnly) {
    const isFresh = bout.left_score === null && bout.right_score === null;
    publish(pisteId, 'score', {
      left:  { score: bout.left_score ?? 0, status: 'U', yellow_card: false, red_cards: 0, black_card: false },
      right: { score: bout.right_score ?? 0, status: 'U', yellow_card: false, red_cards: 0, black_card: false },
      priority: 'N',
    });

    if (pisteEntry) {
      pisteEntry.lastScore = isFresh
        ? null
        : { left: { score: bout.left_score }, right: { score: bout.right_score }, priority: 'N' };
    }

    if (isFresh) {
      // clock: QoS 0 — no seq field per spec
      rawPublish(topic(pisteId, 'software', 'clock'),
        { protocol: PROTOCOL, version: VERSION, ts: Date.now(), running: false, time_ms: 180000, time: '3:00' },
        { qos: 0 });
      publish(pisteId, 'uw2f',
        { time_ms: 0, time: '0:00', right: { p_card: 0 }, left: { p_card: 0 } });
      if (pisteEntry) {
        pisteEntry.lastUw2f        = null;
        pisteEntry.lastVideoReview = null;
      }
    }
  }
}

function _sendRelayData(pisteId, relay, slot, pisteEntry, identifyingOnly = false) {
  const fencers = {
    left:  { fencer: { id: String(relay.left_id  || ''), name: `${relay.left_first  || ''} ${relay.left_last  || ''}`.trim(), nation: relay.left_nation  || '' }},
    right: { fencer: { id: String(relay.right_id || ''), name: `${relay.right_first || ''} ${relay.right_last || ''}`.trim(), nation: relay.right_nation || '' }},
  };
  const common = buildFencersCommon(slot);
  if (common) fencers.common = common;
  publish(pisteId, 'fencers', fencers);

  const weaponMap = { foil: 'F', epee: 'E', sabre: 'S' };
  publish(pisteId, 'match', {
    weapon:      weaponMap[relay.weapon] || relay.weapon || 'F',
    type:        'T',
    competition: relay.competition_name || '',
    phase_type:  'team_de',
    round:       relay.relay_number,
    relay_total: relay.relay_total,
    target:      relay.target,
    left_cumul:  relay.cumul_left,
    right_cumul: relay.cumul_right,
    left_team:   relay.left_team_name  || '',
    right_team:  relay.right_team_name || '',
  });

  if (!identifyingOnly) {
    // software/score carries the cumulative score so the apparatus display starts from the right base.
    const cumulLeft  = (relay.cumul_left  ?? 0) + (relay.left_touches  ?? 0);
    const cumulRight = (relay.cumul_right ?? 0) + (relay.right_touches ?? 0);
    const isFresh = relay.left_touches === null && relay.right_touches === null;
    publish(pisteId, 'score', {
      left:  { score: cumulLeft,  status: 'U', yellow_card: false, red_cards: 0, black_card: false },
      right: { score: cumulRight, status: 'U', yellow_card: false, red_cards: 0, black_card: false },
      priority: 'N',
    });

    if (pisteEntry) {
      pisteEntry.lastScore = isFresh
        ? null
        : { left: { score: cumulLeft }, right: { score: cumulRight }, priority: 'N' };
    }

    if (isFresh) {
      rawPublish(topic(pisteId, 'software', 'clock'),
        { protocol: PROTOCOL, version: VERSION, ts: Date.now(), running: false, time_ms: 180000, time: '3:00' },
        { qos: 0 });
      publish(pisteId, 'uw2f',
        { time_ms: 0, time: '0:00', right: { p_card: 0 }, left: { p_card: 0 } });
      if (pisteEntry) {
        pisteEntry.lastUw2f        = null;
        pisteEntry.lastVideoReview = null;
      }
    }
  }
}

function buildRecordLabel(pisteEntry) {
  const b = pisteEntry?.lastBout;
  if (!b) return '';
  const weaponMap = { foil: 'Foil', epee: 'Épée', sabre: 'Sabre' };
  const weapon = weaponMap[b.weapon] || b.weapon || '';
  if (pisteEntry.lastSlot?.type === 'team_match') {
    return [b.competition_name, weapon, `${b.left_team_name || '?'} vs ${b.right_team_name || '?'}`].filter(Boolean).join(' · ');
  }
  const loc = pisteEntry.lastSlot?.type === 'pool'
    ? `Pool ${b.pool_number || ''}`
    : `R${b.de_round || ''}`;
  return [b.competition_name, weapon, loc].filter(Boolean).join(' · ');
}

// pisteEntry = pisteState[pisteId]
function publishRecord(pisteId, pisteEntry, activeBoutId) {
  if (!isConnected()) return;
  if (!pisteEntry?.slotId || !pisteEntry.recordSlotId) return;

  const slot = Pipeline.findById(pisteEntry.slotId);
  if (!slot) return;

  if (slot.type === 'team_match') {
    return _publishTeamMatchRecord(pisteId, pisteEntry, slot, activeBoutId);
  }

  let bouts;
  try { bouts = getBoutsForSlot(slot); }
  catch (err) { console.error('[OPP2] publishRecord bouts error:', err.message); return; }

  const effectiveActive = activeBoutId !== undefined
    ? activeBoutId
    : (pisteEntry.boutId ? String(pisteEntry.boutId) : null);

  const weaponMap = { foil: 'F', epee: 'E', sabre: 'S' };
  const payload = {
    slot_id:     pisteEntry.recordSlotId,
    phase_type:  slot.type === 'pool' ? 'pool' : 'DE',
    label:       buildRecordLabel(pisteEntry),
    weapon:      weaponMap[pisteEntry.lastBout?.weapon] || 'F',
    active_bout: effectiveActive,
    ...buildRecordOfficials(slot),
    bouts: bouts.map(b => {
      const leftName  = (b.left_first  || b.left_last)
        ? `${b.left_first  || ''} ${b.left_last  || ''}`.trim() : null;
      const rightName = (b.right_first || b.right_last)
        ? `${b.right_first || ''} ${b.right_last || ''}`.trim() : null;
      return {
        id:    String(b.id),
        order: b.bout_order ?? b.round_index ?? 0,
        left:  b.left_id  ? { id: String(b.left_id),  name: leftName,
                               last_name: b.left_last  || '', first_name: b.left_first  || '',
                               nation: b.left_nation  || '' } : null,
        right: b.right_id ? { id: String(b.right_id), name: rightName,
                               last_name: b.right_last || '', first_name: b.right_first || '',
                               nation: b.right_nation || '' } : null,
        result: b.status === 'finished' ? {
          left_score:  b.left_score,
          right_score: b.right_score,
          winner_id:   b.winner_id ? String(b.winner_id) : null,
        } : null,
      };
    }),
  };

  if (slot.type === 'pool') {
    try { payload.participants = getParticipantsForPool(slot.pool_id); }
    catch (err) { console.error('[OPP2] publishRecord participants error:', err.message); }
  }

  const msg = JSON.stringify({ protocol: PROTOCOL, version: VERSION, seq: nextSeq(), ...payload });
  rawPublish(topic(pisteId, 'software', 'record'), msg, { qos: 1, retain: true });
}

function _publishTeamMatchRecord(pisteId, pisteEntry, slot, activeBoutId) {
  // Resolve relay positions in JS to handle relays created before migration 017
  // (where left_position/right_position may be null in the DB).
  const matchRow = stmtTeamMatchPhaseId.get(slot.team_match_id);
  const phaseRow = matchRow ? stmtPhaseRuleDoc.get(matchRow.phase_id) : null;
  const ruleRelays = phaseRow
    ? (require('../lib/rules').loadRule(phaseRow.rule_doc).relays || [])
    : [];

  const relays = stmtRelaysForMatch.all(slot.team_match_id);

  const effectiveActive = activeBoutId !== undefined
    ? activeBoutId
    : (pisteEntry.boutId ? String(pisteEntry.boutId) : null);

  const weaponMap = { foil: 'F', epee: 'E', sabre: 'S' };
  const payload = {
    slot_id:     pisteEntry.recordSlotId,
    phase_type:  'team_de',
    label:       buildRecordLabel(pisteEntry),
    weapon:      weaponMap[pisteEntry.lastBout?.weapon] || 'F',
    active_bout: effectiveActive,
    ...buildRecordOfficials(slot),
    bouts: relays.map(r => {
      let leftPos  = r.left_position;
      let rightPos = r.right_position;
      if (leftPos == null || rightPos == null) {
        const def = ruleRelays[r.relay_number - 1];
        if (def) { leftPos = def.left; rightPos = def.right; }
      }
      const lf = Pipeline._resolveRelayFencer(slot.team_match_id, leftPos,  r.relay_number);
      const rf = Pipeline._resolveRelayFencer(slot.team_match_id, rightPos, r.relay_number);
      const ln = lf ? `${lf.first_name || ''} ${lf.last_name || ''}`.trim() : null;
      const rn = rf ? `${rf.first_name || ''} ${rf.last_name || ''}`.trim() : null;
      return {
        id:    String(r.id),
        order: r.relay_number,
        left:  lf ? { id: String(lf.competitor_id), name: ln, last_name: lf.last_name  || '', first_name: lf.first_name  || '', nation: lf.nationality  || '' } : null,
        right: rf ? { id: String(rf.competitor_id), name: rn, last_name: rf.last_name || '', first_name: rf.first_name || '', nation: rf.nationality || '' } : null,
        result: r.status === 'finished' ? { left_score: r.left_touches, right_score: r.right_touches, winner_id: null } : null,
      };
    }),
  };

  const msg = JSON.stringify({ protocol: PROTOCOL, version: VERSION, seq: nextSeq(), ...payload });
  rawPublish(topic(pisteId, 'software', 'record'), msg, { qos: 1, retain: true });
}

function clearRecord(pisteId) {
  const msg = JSON.stringify({
    protocol: PROTOCOL, version: VERSION, seq: nextSeq(),
    slot_id: null, phase_type: null, label: '', weapon: null,
    active_bout: null, referee: null, referee2: null,
    video_official: null, assessor1: null, assessor2: null, bouts: [],
  });
  rawPublish(topic(pisteId, 'software', 'record'), msg, { qos: 1, retain: true });
}

module.exports = {
  isCorrectEnding, sendAck, sendNak,
  sendMatchData, publishRecord, clearRecord,
  getBoutsForSlot,
};
