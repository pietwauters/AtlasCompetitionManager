'use strict';
const db       = require('../db');
const Pipeline = require('../services/pipeline');
const { PROTOCOL, VERSION, topic, nextSeq, publish, rawPublish, clearRetained, isConnected } =
  require('./opp2Transport');

// ── Bout queries ─────────────────────────────────────────────────────────────

const FENCER_JOIN = `
  LEFT JOIN competitors lc  ON lc.id = b.left_id
  LEFT JOIN fencers     lf  ON lf.id = lc.fencer_id
  LEFT JOIN people      lp  ON lp.id = lf.person_id
  LEFT JOIN competitors rc  ON rc.id = b.right_id
  LEFT JOIN fencers     rf  ON rf.id = rc.fencer_id
  LEFT JOIN people      rp  ON rp.id = rf.person_id
`;

function getBoutsForSlot(slot) {
  if (slot.type === 'pool') {
    return db.prepare(`
      SELECT b.id, b.left_id, b.right_id, b.status,
             b.left_score, b.right_score, b.winner_id, b.bout_order,
             lp.first_name AS left_first,  lp.last_name AS left_last,  lp.nationality AS left_nation,
             rp.first_name AS right_first, rp.last_name AS right_last, rp.nationality AS right_nation
      FROM bouts b ${FENCER_JOIN}
      WHERE b.pool_id = ?
      ORDER BY b.bout_order
    `).all(slot.pool_id);
  }

  // DE slot: use bracket/tableau/partition to identify the round and range.
  const { deRound, lo, hi } = Pipeline.resolveDeSlot(slot);
  return db.prepare(`
    WITH ordered AS (
      SELECT b.id,
             ROW_NUMBER() OVER (PARTITION BY b.phase_id, b.de_round
                                ORDER BY b.tableau_position) AS round_index
      FROM bouts b WHERE b.de_round IS NOT NULL AND b.bracket = 'main'
    )
    SELECT b.id, b.left_id, b.right_id, b.status,
           b.left_score, b.right_score, b.winner_id, o.round_index,
           lp.first_name AS left_first,  lp.last_name AS left_last,  lp.nationality AS left_nation,
           rp.first_name AS right_first, rp.last_name AS right_last, rp.nationality AS right_nation
    FROM bouts b
    JOIN ordered o ON o.id = b.id
    ${FENCER_JOIN}
    WHERE b.phase_id = ? AND b.de_round = ?
      AND o.round_index BETWEEN ? AND ?
    ORDER BY o.round_index
  `).all(slot.phase_id, deRound, lo, hi);
}

function getParticipantsForPool(poolId) {
  return db.prepare(`
    SELECT c.id AS competitor_id, p.first_name, p.last_name, p.nationality
    FROM pool_competitors pc
    JOIN competitors c ON c.id = pc.competitor_id
    JOIN fencers     f ON f.id = c.fencer_id
    JOIN people      p ON p.id = f.person_id
    WHERE pc.pool_id = ?
    ORDER BY c.initial_seed ASC, p.last_name
  `).all(poolId).map(r => ({
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

// pisteEntry = pisteState[pisteId] — passed by reference so we can update lastScore in-place.
function sendMatchData(pisteId, bout, slot, pisteEntry) {
  if (!bout) return;

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
  if (bout.ref_first || bout.ref_last) {
    fencers.common = { referee: {
      id:     String(slot.referee_id || ''),
      name:   `${bout.ref_first || ''} ${bout.ref_last || ''}`.trim(),
      nation: bout.ref_nation || '',
    }};
  }
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

  const isFresh = bout.left_score === null && bout.right_score === null;
  publish(pisteId, 'score', {
    left:  { score: bout.left_score ?? 0, status: 'U', yellow_card: false, red_cards: 0, black_card: false },
    right: { score: bout.right_score ?? 0, status: 'U', yellow_card: false, red_cards: 0, black_card: false },
    priority: 'N',
  }, { retain: true });

  if (pisteEntry) {
    pisteEntry.lastScore = isFresh
      ? null
      : { left: { score: bout.left_score }, right: { score: bout.right_score }, priority: 'N' };
  }

  if (isFresh) {
    // clock: QoS 0 — no seq field per spec
    rawPublish(topic(pisteId, 'software', 'clock'),
      { protocol: PROTOCOL, version: VERSION, ts: Date.now(), running: false, time_ms: 180000, time: '3:00' },
      { qos: 0, retain: true });
    publish(pisteId, 'uw2f',
      { time_ms: 0, time: '0:00', right: { p_card: 0 }, left: { p_card: 0 } },
      { retain: true });
    if (pisteEntry) {
      pisteEntry.lastUw2f        = null;
      pisteEntry.lastVideoReview = null;
    }
  }
}

function buildRecordLabel(pisteEntry) {
  const b = pisteEntry?.lastBout;
  if (!b) return '';
  const weaponMap = { foil: 'Foil', epee: 'Épée', sabre: 'Sabre' };
  const weapon = weaponMap[b.weapon] || b.weapon || '';
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

function clearRecord(pisteId) {
  const msg = JSON.stringify({
    protocol: PROTOCOL, version: VERSION, seq: nextSeq(),
    slot_id: null, phase_type: null, label: '', weapon: null,
    active_bout: null, bouts: [],
  });
  rawPublish(topic(pisteId, 'software', 'record'), msg, { qos: 1, retain: true });
}

module.exports = {
  isCorrectEnding, sendAck, sendNak,
  sendMatchData, publishRecord, clearRecord,
  getBoutsForSlot,
};
