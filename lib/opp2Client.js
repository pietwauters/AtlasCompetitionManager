'use strict';
const mqtt           = require('mqtt');
const { randomUUID } = require('crypto');
const db             = require('../db');
const Pipeline    = require('../services/pipeline');
const Bout        = require('../services/bouts');
const Strip       = require('../services/strips');
const Event       = require('../services/events');
const CardReason  = require('../services/cardReasons');
const Settings    = require('../services/settings');
const SSE         = require('./sse');
const { emitBoutUpdated } = require('./notifications');

const PROTOCOL = 'OPP2';
const VERSION  = '1.0';

// Singleton state
let client    = null;
let brokerUrl = null;
let seq       = 0;        // global sequence counter for all published messages

// Per-piste state keyed by pisteId (strip name — the OPP2 topic identifier)
// { stripId, apparatusOnline, slotId, boutId, lastScore, lastBout, lastSlot }
const pisteState = {};

// ── Internal helpers ────────────────────────────────────────────────────────

function nextSeq() { return ++seq; }

function topic(pisteId, publisher, type) {
  return `openpiste/${pisteId}/${publisher}/${type}`;
}

function publish(pisteId, type, payload, opts = {}) {
  if (!client || !client.connected) return;
  const msg = JSON.stringify({ protocol: PROTOCOL, version: VERSION,
                               seq: nextSeq(), ...payload });
  client.publish(topic(pisteId, 'software', type), msg,
    { qos: 1, retain: false, ...opts });
}

function publishConnection(pisteId, online) {
  if (!client || !client.connected) return;
  const payload = online
    ? { protocol: PROTOCOL, version: VERSION, seq: nextSeq(),
        online: true, software: 'Atlas', sw_version: '0.1.0' }
    : { online: false };
  client.publish(topic(pisteId, 'software', 'connection'),
    JSON.stringify(payload), { qos: 1, retain: true });
}

function isCorrectEnding(score) {
  if (!score) return false;
  const { left, right, priority } = score;
  const abnormal = s => s === 'A' || s === 'E';
  if (abnormal(left?.status) || abnormal(right?.status)) return true;
  if ((left?.score ?? 0) !== (right?.score ?? 0)) return true;
  if (priority === 'L' || priority === 'R') return true;
  return false;
}

function sendMatchData(pisteId, bout, slot) {
  if (!bout) return;

  // fencers message
  const fencers = {
    left: {
      fencer: {
        id:        String(bout.left_id),
        name:      `${bout.left_first} ${bout.left_last}`,
        nation:    bout.left_nation || '',
        ...(bout.left_club      ? { club:      bout.left_club }      : {}),
        ...(bout.left_club_abbr ? { club_abbr: bout.left_club_abbr } : {}),
      },
    },
    right: {
      fencer: {
        id:        String(bout.right_id),
        name:      `${bout.right_first} ${bout.right_last}`,
        nation:    bout.right_nation || '',
        ...(bout.right_club      ? { club:      bout.right_club }      : {}),
        ...(bout.right_club_abbr ? { club_abbr: bout.right_club_abbr } : {}),
      },
    },
  };
  if (bout.ref_first || bout.ref_last) {
    fencers.common = { referee: {
      id:     String(slot.referee_id || ''),
      name:   `${bout.ref_first || ''} ${bout.ref_last || ''}`.trim(),
      nation: bout.ref_nation || '',
    }};
  }
  publish(pisteId, 'fencers', fencers);

  // match message
  const weaponMap = { foil: 'F', epee: 'E', sabre: 'S' };
  const match = {
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
  };
  publish(pisteId, 'match', match);

  const isFresh = bout.left_score === null && bout.right_score === null;

  // Publish current score (zeroed for fresh bouts, DB values when resuming).
  // Retained so scoreboards that reconnect see the latest state immediately.
  const scorePayload = {
    left:  { score: bout.left_score ?? 0, status: 'U', yellow_card: false, red_cards: 0, black_card: false },
    right: { score: bout.right_score ?? 0, status: 'U', yellow_card: false, red_cards: 0, black_card: false },
    priority: 'N',
  };
  publish(pisteId, 'score', scorePayload, { retain: true });
  if (pisteState[pisteId]) {
    pisteState[pisteId].lastScore = isFresh
      ? null
      : { left: { score: bout.left_score }, right: { score: bout.right_score }, priority: 'N' };
  }

  if (isFresh) {
    // clock: QoS 0 — no seq field per spec
    if (client && client.connected) {
      client.publish(
        topic(pisteId, 'software', 'clock'),
        JSON.stringify({ protocol: PROTOCOL, version: VERSION, ts: Date.now(),
                         running: false, time_ms: 180000, time: '3:00' }),
        { qos: 0, retain: true }
      );
    }
    // uw2f: QoS 1
    publish(pisteId, 'uw2f', {
      time_ms: 0, time: '0:00',
      right: { p_card: 0 }, left: { p_card: 0 },
    }, { retain: true });
    // Reset per-bout audit state so detectors start from a clean baseline
    if (pisteState[pisteId]) {
      pisteState[pisteId].lastUw2f        = null;
      pisteState[pisteId].lastVideoReview = null;
    }
  }
}

// ── Audit event detectors ───────────────────────────────────────────────────

function boutContext(pisteId) {
  const s = pisteState[pisteId];
  if (!s || !s.boutId) return null;
  const b = Bout.findById(s.boutId);
  if (!b) return null;
  return { competition_id: b.competition_id, phase_id: b.phase_id, bout_id: s.boutId };
}

function detectCardEvents(pisteId, prevScore, nextScore) {
  const ctx = boutContext(pisteId);
  if (!ctx) return;
  const base = { ...ctx, actor: 'apparatus' };

  for (const side of ['left', 'right']) {
    const prev = prevScore?.[side] || {};
    const next = nextScore[side]   || {};

    if (!prev.yellow_card && next.yellow_card) {
      Event.record({ ...base, event_type: 'card.yellow', side,
                     payload: { before: false, after: true } });
    }
    const redBefore = prev.red_cards || 0;
    const redAfter  = next.red_cards || 0;
    for (let i = redBefore; i < redAfter; i++) {
      Event.record({ ...base, event_type: 'card.red', side,
                     payload: { before: redBefore, after: redAfter } });
    }
    if (!prev.black_card && next.black_card) {
      Event.record({ ...base, event_type: 'card.black', side,
                     payload: { before: false, after: true } });
    }
  }
}

function detectUw2fEvents(pisteId, prevUw2f, nextUw2f) {
  const ctx = boutContext(pisteId);
  if (!ctx) return;
  const base = { ...ctx, actor: 'apparatus' };

  for (const side of ['left', 'right']) {
    const before = prevUw2f?.[side]?.p_card || 0;
    const after  = nextUw2f[side]?.p_card   || 0;
    for (let i = before; i < after; i++) {
      Event.record({ ...base, event_type: 'card.p', side,
                     payload: { before, after } });
    }
  }
}

function detectVideoReviewEvents(pisteId, actor, prevReview, nextReview) {
  const ctx = boutContext(pisteId);
  if (!ctx) return;
  const base = { ...ctx, actor };

  for (const side of ['left', 'right']) {
    const prevMap = new Map((prevReview?.[side]?.calls || []).map(c => [c.id, c]));
    for (const call of (nextReview[side]?.calls || [])) {
      const existing = prevMap.get(call.id);
      const corrId   = `${ctx.bout_id}-video-${side}-${call.id}`;

      if (!existing) {
        Event.record({ ...base, event_type: 'video.call', side, correlation_id: corrId,
                       payload: { call_id: call.id, round: call.round, time_ms: call.time_ms } });
      } else if (existing.granted === undefined && call.granted !== undefined) {
        Event.record({ ...base, event_type: 'video.result', side, correlation_id: corrId,
                       payload: { call_id: call.id, granted: call.granted } });
      }
    }
  }
}

// ── software/record helpers ─────────────────────────────────────────────────

function getBoutsForSlot(slot) {
  const FENCER_JOIN = `
    LEFT JOIN competitors lc  ON lc.id = b.left_id
    LEFT JOIN fencers     lf  ON lf.id = lc.fencer_id
    LEFT JOIN people      lp  ON lp.id = lf.person_id
    LEFT JOIN competitors rc  ON rc.id = b.right_id
    LEFT JOIN fencers     rf  ON rf.id = rc.fencer_id
    LEFT JOIN people      rp  ON rp.id = rf.person_id
  `;
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
  const start = slot.bout_start ?? 1;
  const end   = slot.bout_end   ?? 9999;
  return db.prepare(`
    WITH ordered AS (
      SELECT b.id,
             ROW_NUMBER() OVER (PARTITION BY b.phase_id, b.de_round
                                ORDER BY b.tableau_position) AS round_index
      FROM bouts b WHERE b.de_round IS NOT NULL
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
  `).all(slot.phase_id, slot.de_round, start, end);
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

function buildRecordLabel(state) {
  const b = state.lastBout;
  if (!b) return '';
  const weaponMap = { foil: 'Foil', epee: 'Épée', sabre: 'Sabre' };
  const weapon = weaponMap[b.weapon] || b.weapon || '';
  const loc = state.lastSlot?.type === 'pool'
    ? `Pool ${b.pool_number || ''}`
    : `R${b.de_round || ''}`;
  return [b.competition_name, weapon, loc].filter(Boolean).join(' · ');
}

function publishRecord(pisteId, activeBoutId) {
  if (!client || !client.connected) return;
  const state = pisteState[pisteId];
  if (!state || !state.slotId || !state.recordSlotId) return;

  const slot = Pipeline.findById(state.slotId);
  if (!slot) return;

  let bouts;
  try { bouts = getBoutsForSlot(slot); }
  catch (err) { console.error('[OPP2] publishRecord bouts error:', err.message); return; }

  const effectiveActive = activeBoutId !== undefined
    ? activeBoutId
    : (state.boutId ? String(state.boutId) : null);

  const weaponMap = { foil: 'F', epee: 'E', sabre: 'S' };

  const payload = {
    slot_id:     state.recordSlotId,
    phase_type:  slot.type === 'pool' ? 'pool' : 'DE',
    label:       buildRecordLabel(state),
    weapon:      weaponMap[state.lastBout?.weapon] || 'F',
    active_bout: effectiveActive,
    bouts: bouts.map(b => {
      const leftName  = b.left_first || b.left_last
        ? `${b.left_first  || ''} ${b.left_last  || ''}`.trim() : null;
      const rightName = b.right_first || b.right_last
        ? `${b.right_first || ''} ${b.right_last || ''}`.trim() : null;
      return {
        id:    String(b.id),
        order: b.bout_order ?? b.round_index ?? 0,
        left:  b.left_id  ? { id: String(b.left_id),  name: leftName,  last_name: b.left_last  || '', first_name: b.left_first  || '', nation: b.left_nation  || '' } : null,
        right: b.right_id ? { id: String(b.right_id), name: rightName, last_name: b.right_last || '', first_name: b.right_first || '', nation: b.right_nation || '' } : null,
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
  client.publish(topic(pisteId, 'software', 'record'), msg, { qos: 1, retain: true });
}

// ── NEXT / PREV handlers ────────────────────────────────────────────────────

function handleNext(pisteId) {
  const state = pisteState[pisteId];
  if (!state) return;

  // Activate the current slot if still pending
  let slot = Pipeline.activeSlot(state.stripId);
  if (!slot) {
    slot = Pipeline.recoverStaleSlot(state.stripId);
    if (slot) {
      console.warn(`[OPP2] WARNING: slot ${slot.id} was 'done' but still had pending bouts — auto-recovered for piste ${pisteId}`);
    } else {
      console.log(`[OPP2] Pipeline exhausted for piste ${pisteId}`);
      return;
    }
  }

  if (slot.status === 'pending') Pipeline.markActive(slot.id);

  // New slot picked up — cursor from previous slot is meaningless for this one.
  if (slot.id !== state.slotId) {
    state.boutId      = null;
    state.recordSlotId = randomUUID();
  }

  const bout = Pipeline.nextBout(slot, state.boutId);
  if (!bout) {
    if (Pipeline.pendingBoutCount(slot) > 0) {
      // The only remaining pending bout is the one currently on the piste.
      // Re-publish it so the apparatus and scoresheet stay in sync.
      console.log(`[OPP2] NEXT on piste ${pisteId}: only current bout still pending, re-sending`);
      if (state.boutId && state.lastBout && state.lastSlot) {
        sendMatchData(pisteId, state.lastBout, state.lastSlot);
        publishRecord(pisteId);
      }
      return;
    }

    Pipeline.markDone(slot.id);
    slot = Pipeline.activeSlot(state.stripId);
    if (!slot) { console.log(`[OPP2] Pipeline exhausted for piste ${pisteId}`); return; }
    Pipeline.markActive(slot.id);
    const nextBout = Pipeline.nextBout(slot, null);
    if (!nextBout) {
      console.warn(`[OPP2] New slot ${slot.id} for piste ${pisteId} has no pending bouts — skipping`);
      Pipeline.markDone(slot.id);
      return;
    }
    state.slotId        = slot.id;
    state.boutId        = nextBout.id;
    state.lastBout      = nextBout;
    state.lastSlot      = slot;
    state.recordSlotId  = randomUUID();
    sendMatchData(pisteId, nextBout, slot);
    publishRecord(pisteId);
    emitPisteState(pisteId);
    return;
  }

  state.slotId   = slot.id;
  state.boutId   = bout.id;
  state.lastBout = bout;
  state.lastSlot = slot;
  sendMatchData(pisteId, bout, slot);
  publishRecord(pisteId);
  emitPisteState(pisteId);
}

function handlePrev(pisteId) {
  const state = pisteState[pisteId];
  if (!state || !state.slotId) return;

  const slot = Pipeline.findById(state.slotId);
  if (!slot) return;

  const bout = Pipeline.prevBout(slot, state.boutId);
  if (!bout) {
    console.log(`[OPP2] Already at first bout for piste ${pisteId} — re-sending`);
    if (state.lastBout && state.lastSlot) {
      sendMatchData(pisteId, state.lastBout, state.lastSlot);
      publishRecord(pisteId);
    }
    return;
  }

  state.boutId   = bout.id;
  state.lastBout = bout;
  state.lastSlot = slot;
  sendMatchData(pisteId, bout, slot);
  publishRecord(pisteId);
}

function handleEnd(pisteId) {
  const state = pisteState[pisteId];
  if (!state || !state.boutId) {
    sendNak(pisteId);
    return;
  }

  const score = state.lastScore;
  if (!isCorrectEnding(score)) {
    console.log(`[OPP2] NAK for piste ${pisteId} — no clear winner`);
    sendNak(pisteId);
    return;
  }

  const { left, right, priority } = score;
  const leftScore  = left?.score  ?? 0;
  const rightScore = right?.score ?? 0;

  let winnerId = null;
  if      (leftScore > rightScore)  winnerId = null; // auto from scores
  else if (rightScore > leftScore)  winnerId = null;
  else if (priority === 'L') {
    const b = Bout.findById(state.boutId);
    winnerId = b?.left_id ?? null;
  } else if (priority === 'R') {
    const b = Bout.findById(state.boutId);
    winnerId = b?.right_id ?? null;
  }

  const { bout: updatedBout, next } = Bout.updateScore(state.boutId, leftScore, rightScore, winnerId);
  emitBoutUpdated(updatedBout, next);

  publishRecord(pisteId, null);
  sendAck(pisteId);

  state.lastScore = null;

  // If no unfinished bouts remain in this slot, mark it done immediately
  // (avoids a stale 'active' slot when no NEXT will follow, e.g. after the final).
  if (state.slotId) {
    const slot = Pipeline.findById(state.slotId);
    if (slot && slot.status === 'active' && Pipeline.pendingBoutCount(slot) === 0) {
      Pipeline.markDone(state.slotId);
      state.slotId = null;
      state.boutId = null;
    }
  }
  emitPisteState(pisteId);

  if (Settings.get('opp2_auto_next_on_end') === '1') handleNext(pisteId);
}

function emitPisteState(pisteId) {
  const s = pisteState[pisteId];
  if (!s) return;
  let bout = null;
  if (s.boutId) {
    const b = Bout.findById(s.boutId);
    if (b && b.status !== 'finished') bout = { bout_order: b.bout_order, left: b.left_last, right: b.right_last };
  }
  SSE.emit('__strips__', 'piste-state', {
    pisteId,
    stripId:         s.stripId,
    apparatusOnline: s.apparatusOnline,
    boutId:          s.boutId,
    slotId:          s.slotId,
    bout,
  });
}

function sendAck(pisteId) {
  publish(pisteId, 'control', {
    ts:      Date.now(),
    command: 'ACK',
  });
}

function sendNak(pisteId) {
  publish(pisteId, 'control', {
    ts:      Date.now(),
    command: 'NAK',
  });
}

// ── MQTT message router ─────────────────────────────────────────────────────

function handleMessage(mqttTopic, rawMessage) {
  const parts = mqttTopic.split('/');
  // openpiste / {pisteId} / {publisher} / {type}
  if (parts.length < 4 || parts[0] !== 'openpiste') return;
  const [, pisteId, publisher, msgType] = parts;

  let payload;
  try { payload = JSON.parse(rawMessage.toString()); }
  catch { return; }

  if (!pisteState[pisteId]) {
    console.warn(`[OPP2] Message from unknown piste "${pisteId}" (${publisher}/${msgType}) — not in pisteState`);
    return;
  }

  if (publisher === 'apparatus' && msgType === 'connection') {
    const online = payload.online === true;
    pisteState[pisteId].apparatusOnline = online;
    emitPisteState(pisteId);
    console.log(`[OPP2] Piste ${pisteId} apparatus ${online ? 'online' : 'offline'}`);
  }

  if (publisher === 'apparatus' && msgType === 'score') {
    const prevScore = pisteState[pisteId].lastScore;
    pisteState[pisteId].lastScore = {
      left:     payload.left,
      right:    payload.right,
      priority: payload.priority ?? 'N',
    };
    try { detectCardEvents(pisteId, prevScore, payload); }
    catch (err) { console.error('[OPP2] card event error:', err.message); }
  }

  if (publisher === 'apparatus' && msgType === 'uw2f') {
    const prevUw2f = pisteState[pisteId].lastUw2f;
    pisteState[pisteId].lastUw2f = payload;
    try { detectUw2fEvents(pisteId, prevUw2f, payload); }
    catch (err) { console.error('[OPP2] uw2f event error:', err.message); }
  }

  if ((publisher === 'apparatus' || publisher === 'var') && msgType === 'video_review') {
    const prevReview = pisteState[pisteId].lastVideoReview;
    pisteState[pisteId].lastVideoReview = payload;
    try { detectVideoReviewEvents(pisteId, publisher, prevReview, payload); }
    catch (err) { console.error('[OPP2] video_review event error:', err.message); }
  }

  if (publisher === 'scoresheet' && msgType === 'event') {
    if (payload.event === 'CARD_REASON' && payload.side && payload.card && payload.reason) {
      const boutId = pisteState[pisteId]?.boutId || null;
      try {
        CardReason.record({ boutId, pisteId, side: payload.side, card: payload.card, reason: payload.reason });
        console.log(`[OPP2] Card reason — piste ${pisteId} ${payload.side} ${payload.card}: ${payload.reason}`);
      } catch (err) {
        console.error('[OPP2] Card reason record error:', err.message);
      }
    }
    return;
  }

  if (publisher === 'apparatus' && msgType === 'control') {
    const cmd = payload.command;
    try {
      if (cmd === 'NEXT') handleNext(pisteId);
      if (cmd === 'PREV') handlePrev(pisteId);
      if (cmd === 'END')  handleEnd(pisteId);
    } catch (err) {
      console.error(`[OPP2] Error handling ${cmd} for piste ${pisteId}:`, err);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

const OPP2 = {
  isConnected() { return client?.connected === true; },
  brokerUrl()   { return brokerUrl; },

  status() {
    return {
      connected:  this.isConnected(),
      brokerUrl,
      pistes: Object.entries(pisteState).map(([pisteId, s]) => {
        let bout = null;
        if (s.boutId) {
          const b = Bout.findById(s.boutId);
          if (b && b.status !== 'finished') bout = { bout_order: b.bout_order, left: b.left_last, right: b.right_last };
        }
        return {
          pisteId,
          stripId:         s.stripId,
          apparatusOnline: s.apparatusOnline,
          boutId:          s.boutId,
          slotId:          s.slotId,
          bout,
        };
      }),
    };
  },

  connect(url) {
    if (client) this.disconnect();
    brokerUrl = url;

    // Build per-piste state from all known strips
    const strips = Strip.findAll();
    for (const s of strips) {
      const id = s.name;
      if (pisteState[id]) {
        pisteState[id].stripId = s.id; // refresh in case strip was recreated with a new id
      } else {
        pisteState[id] = {
          stripId: s.id, apparatusOnline: false,
          slotId: null, boutId: null, recordSlotId: null,
          lastScore: null, lastUw2f: null, lastVideoReview: null,
          lastBout: null, lastSlot: null,
        };
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Connection timeout')), 10000);

      // MQTT only allows one LWT per connection; use a generic atlas topic.
      client = mqtt.connect(url, {
        clientId:        'atlas-cms-' + Math.random().toString(16).slice(2, 8),
        clean:           true,
        reconnectPeriod: 5000,
        connectTimeout:  8000,
        will: {
          topic:   'openpiste/atlas/software/connection',
          payload: JSON.stringify({ online: false }),
          qos: 1, retain: true,
        },
      });

      client.once('connect', () => {
        clearTimeout(timer);
        console.log('[OPP2] Connected to', url);
        seq = 0;

        for (const pisteId of Object.keys(pisteState)) publishConnection(pisteId, true);

        client.subscribe('openpiste/+/apparatus/connection',   { qos: 1 });
        client.subscribe('openpiste/+/apparatus/control',     { qos: 1 });
        client.subscribe('openpiste/+/apparatus/score',       { qos: 1 });
        client.subscribe('openpiste/+/apparatus/uw2f',        { qos: 1 });
        client.subscribe('openpiste/+/apparatus/video_review',{ qos: 1 });
        client.subscribe('openpiste/+/var/video_review',      { qos: 1 });
        client.subscribe('openpiste/+/scoresheet/event',      { qos: 1 });

        resolve();
      });

      client.once('error', err => {
        clearTimeout(timer);
        console.error('[OPP2] MQTT error:', err.message);
        reject(err);
      });

      client.on('message', handleMessage);

      client.on('error', err => console.error('[OPP2] MQTT error:', err.message));
      client.on('offline', () => console.warn('[OPP2] MQTT client offline'));
      client.on('reconnect', () => {
        // Re-announce on every reconnect
        for (const pisteId of Object.keys(pisteState)) publishConnection(pisteId, true);
      });
      client.on('close', () => {
        for (const pisteId of Object.keys(pisteState)) {
          publishConnection(pisteId, false);
          pisteState[pisteId].apparatusOnline = false;
          emitPisteState(pisteId);
        }
      });
    });
  },

  disconnect() {
    if (!client) return;
    for (const pisteId of Object.keys(pisteState)) {
      publishConnection(pisteId, false);
    }
    client.end(true);
    client = null;
    brokerUrl = null;
  },

  // Re-key pisteState when a strip is renamed.
  renamePiste(oldName, newName) {
    if (oldName === newName) return;
    if (pisteState[oldName]) {
      pisteState[newName] = pisteState[oldName];
      delete pisteState[oldName];
    } else {
      pisteState[newName] = pisteState[newName] || {
        stripId: null, apparatusOnline: false,
        slotId: null, boutId: null,
        lastScore: null, lastUw2f: null, lastVideoReview: null,
      };
    }
    if (this.isConnected()) {
      // Clear retained announcement on old topic, announce on new topic
      publishConnection(oldName, false);
      publishConnection(newName, true);
    }
    emitPisteState(newName);
  },

  // Re-announce when strips are added at runtime.
  addPiste(strip) {
    const id = strip.name;
    if (!pisteState[id]) {
      pisteState[id] = {
        stripId: strip.id, apparatusOnline: false,
        slotId: null, boutId: null, recordSlotId: null,
        lastScore: null, lastUw2f: null, lastVideoReview: null,
        lastBout: null, lastSlot: null,
      };
    }
    if (this.isConnected()) {
      publishConnection(id, true);
      // Subscribing to the specific topic (even though the wildcard already covers it)
      // causes the broker to re-deliver the retained apparatus/connection message,
      // so we immediately learn whether this piste's apparatus is online.
      client.subscribe(`openpiste/${id}/apparatus/connection`, { qos: 1 });
    }
  },
};

module.exports = OPP2;
