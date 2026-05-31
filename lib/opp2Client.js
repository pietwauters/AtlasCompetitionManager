'use strict';
const mqtt     = require('mqtt');
const Pipeline = require('../services/pipeline');
const Bout     = require('../services/bouts');
const Strip    = require('../services/strips');

const PROTOCOL = 'OPP2';
const VERSION  = '1.0';

// Singleton state
let client    = null;
let brokerUrl = null;
let seq       = 0;        // global sequence counter for all published messages

// Per-piste state keyed by pisteId (strip_number as string)
// { stripId, apparatusOnline, slotId, boutId, lastScore }
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
}

// ── NEXT / PREV handlers ────────────────────────────────────────────────────

function handleNext(pisteId) {
  const state = pisteState[pisteId];
  if (!state) return;

  // Activate the current slot if still pending
  let slot = Pipeline.activeSlot(state.stripId);
  if (!slot) { console.log(`[OPP2] No pipeline slot for piste ${pisteId}`); return; }

  if (slot.status === 'pending') Pipeline.markActive(slot.id);

  const bout = Pipeline.nextBout(slot, state.boutId);
  if (!bout) {
    // Slot exhausted — advance to next
    Pipeline.markDone(slot.id);
    slot = Pipeline.activeSlot(state.stripId);
    if (!slot) { console.log(`[OPP2] Pipeline exhausted for piste ${pisteId}`); return; }
    Pipeline.markActive(slot.id);
    const nextBout = Pipeline.nextBout(slot, null);
    if (!nextBout) return;
    state.slotId  = slot.id;
    state.boutId  = nextBout.id;
    sendMatchData(pisteId, nextBout, slot);
    return;
  }

  state.slotId = slot.id;
  state.boutId = bout.id;
  sendMatchData(pisteId, bout, slot);
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

  if (!pisteState[pisteId]) return; // unknown piste — ignore

  if (publisher === 'apparatus' && msgType === 'connection') {
    pisteState[pisteId].apparatusOnline = payload.online === true;
    console.log(`[OPP2] Piste ${pisteId} apparatus ${payload.online ? 'online' : 'offline'}`);
    // Spec §23: when apparatus reconnects with no match, it sends NEXT itself.
    // Nothing for us to do here proactively.
  }

  if (publisher === 'apparatus' && msgType === 'score') {
    pisteState[pisteId].lastScore = {
      left:     payload.left,
      right:    payload.right,
      priority: payload.priority ?? 'N',
    };
  }

  if (publisher === 'apparatus' && msgType === 'control') {
    const cmd = payload.command;
    if (cmd === 'NEXT') handleNext(pisteId);
    if (cmd === 'PREV') handlePrev(pisteId);
    if (cmd === 'END')  handleEnd(pisteId);
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
      pistes: Object.entries(pisteState).map(([pisteId, s]) => ({
        pisteId,
        stripId:         s.stripId,
        apparatusOnline: s.apparatusOnline,
        boutId:          s.boutId,
        slotId:          s.slotId,
      })),
    };
  },

  connect(url) {
    if (client) this.disconnect();
    brokerUrl = url;

    // Build per-piste state from all known strips
    const strips = Strip.findAll();
    for (const s of strips) {
      const id = String(s.strip_number);
      pisteState[id] = pisteState[id] || {
        stripId: s.id, apparatusOnline: false,
        slotId: null, boutId: null, lastScore: null,
      };
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

        client.subscribe('openpiste/+/apparatus/connection', { qos: 1 });
        client.subscribe('openpiste/+/apparatus/control',    { qos: 1 });
        client.subscribe('openpiste/+/apparatus/score',      { qos: 1 });

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
        for (const pisteId of Object.keys(pisteState)) publishConnection(pisteId, false);
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

  // Re-announce when strips are added at runtime.
  addPiste(strip) {
    const id = String(strip.strip_number);
    if (!pisteState[id]) {
      pisteState[id] = {
        stripId: strip.id, apparatusOnline: false,
        slotId: null, boutId: null, lastScore: null,
      };
    }
    if (this.isConnected()) publishConnection(id, true);
  },
};

module.exports = OPP2;
