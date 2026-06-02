'use strict';
const mqtt     = require('mqtt');
const Pipeline = require('../services/pipeline');
const Bout     = require('../services/bouts');
const Strip    = require('../services/strips');
const Event    = require('../services/events');
const SSE      = require('./sse');

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

// ── NEXT / PREV handlers ────────────────────────────────────────────────────

function handleNext(pisteId) {
  const state = pisteState[pisteId];
  if (!state) return;

  // Activate the current slot if still pending
  let slot = Pipeline.activeSlot(state.stripId);
  if (!slot) { console.log(`[OPP2] No pipeline slot for piste ${pisteId}`); return; }

  if (slot.status === 'pending') Pipeline.markActive(slot.id);

  // If the current bout is still unfinished, the apparatus is asking for its
  // current state (reconnect scenario). Re-send without advancing.
  // Normal advancement happens after END marks the bout finished.
  if (state.boutId && state.lastBout) {
    const current = Bout.findById(state.boutId);
    if (current && current.status !== 'finished') {
      sendMatchData(pisteId, state.lastBout, state.lastSlot || slot);
      return;
    }
  }

  const bout = Pipeline.nextBout(slot, state.boutId);
  if (!bout) {
    // nextBout returns null when the only remaining pending bout is the current
    // one (being fenced on the piste) or when all bouts are finished.
    // Only advance to the next slot when every bout is actually finished.
    if (Pipeline.pendingBoutCount(slot) > 0) return; // still a bout in progress

    Pipeline.markDone(slot.id);
    slot = Pipeline.activeSlot(state.stripId);
    if (!slot) { console.log(`[OPP2] Pipeline exhausted for piste ${pisteId}`); return; }
    Pipeline.markActive(slot.id);
    const nextBout = Pipeline.nextBout(slot, null);
    if (!nextBout) return;
    state.slotId   = slot.id;
    state.boutId   = nextBout.id;
    state.lastBout = nextBout;
    state.lastSlot = slot;
    sendMatchData(pisteId, nextBout, slot);
    return;
  }

  state.slotId   = slot.id;
  state.boutId   = bout.id;
  state.lastBout = bout;
  state.lastSlot = slot;
  sendMatchData(pisteId, bout, slot);
  emitPisteState(pisteId);
}

function handlePrev(pisteId) {
  const state = pisteState[pisteId];
  if (!state || !state.slotId) return;

  const slot = Pipeline.findById(state.slotId);
  if (!slot) return;

  const bout = Pipeline.prevBout(slot, state.boutId);
  if (!bout) { console.log(`[OPP2] Already at first bout for piste ${pisteId}`); return; }

  state.boutId = bout.id;
  sendMatchData(pisteId, bout, slot);
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

  Bout.updateScore(state.boutId, leftScore, rightScore, winnerId);

  sendAck(pisteId);

  // Clear boutId so next NEXT starts fresh from the slot cursor
  state.boutId    = state.boutId;  // keep as last completed, nextBout uses > this
  state.lastScore = null;
}

function emitPisteState(pisteId) {
  const s = pisteState[pisteId];
  if (!s) return;
  let bout = null;
  if (s.boutId) {
    const b = Bout.findById(s.boutId);
    if (b) bout = { bout_order: b.bout_order, left: b.left_last, right: b.right_last };
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
          if (b) bout = { bout_order: b.bout_order, left: b.left_last, right: b.right_last };
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
          slotId: null, boutId: null,
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
        slotId: null, boutId: null,
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
