'use strict';
const { randomUUID }    = require('crypto');
const db                = require('../db');
const Pipeline          = require('../services/pipeline');
const Bout              = require('../services/bouts');
const TeamMatch         = require('../services/teamMatches');
const Strip             = require('../services/strips');
const CardReason        = require('../services/cardReasons');
const Settings          = require('../services/settings');
const SSE               = require('./sse');
const { emitBoutUpdated }     = require('./notifications');
const Transport               = require('./opp2Transport');
const { detectCardEvents, detectUw2fEvents, detectVideoReviewEvents } = require('./opp2Audit');
const { isCorrectEnding, sendAck, sendNak, sendMatchData, publishRecord, clearRecord } =
  require('./opp2Composer');

// Per-piste state keyed by pisteId (= strip name, the OPP2 topic identifier).
// { stripId, apparatusOnline, slotId, boutId, recordSlotId,
//   lastScore, lastUw2f, lastVideoReview, lastBout, lastSlot }
const pisteState = {};

// Dynamic reorder: tracks when each competitor last finished a bout (epoch ms).
// Keyed by competitor_id (integer).
const fencerLastFenced = {};

function emitPisteState(pisteId) {
  const s = pisteState[pisteId];
  if (!s) return;
  let bout = null;
  if (s.boutId) {
    if (s.lastSlot?.type === 'team_match') {
      if (s.lastBout)
        bout = { bout_order: s.lastBout.relay_number, left: s.lastBout.left_last, right: s.lastBout.right_last };
    } else {
      const b = Bout.findById(s.boutId);
      if (b && b.status !== 'finished')
        bout = { bout_order: b.bout_order, left: b.left_last, right: b.right_last };
    }
  }
  SSE.emit('__strips__', 'piste-state', {
    pisteId, stripId: s.stripId, apparatusOnline: s.apparatusOnline,
    boutId: s.boutId, slotId: s.slotId, bout,
  });
}

// ── Dynamic reorder ──────────────────────────────────────────────────────────

// If dynamic reordering is enabled for this pool and either fencer in `bout`
// has insufficient rest, scan ahead (lookahead 3) for the first bout where
// both fencers are adequately rested.  Returns the (possibly swapped) bout.
function _applyDynamicReorder(pisteId, slot, bout) {
  if (!bout || slot.type !== 'pool') return bout;

  const pool = db.prepare('SELECT dynamic_reorder FROM pools WHERE id = ?').get(slot.pool_id);
  if (!pool || !pool.dynamic_reorder) return bout;

  const minRestMs = Number(Settings.get('opp2_min_rest_seconds') || 180) * 1000;
  const now = Date.now();

  function isRested(competitorId) {
    const last = fencerLastFenced[competitorId];
    return !last || (now - last) >= minRestMs;
  }

  if (isRested(bout.left_id) && isRested(bout.right_id)) return bout;

  // Look ahead up to 3 more bouts for a rested pair.
  const state = pisteState[pisteId];
  const candidates = Pipeline.nextBoutsAhead(slot, state?.boutId, 4);
  const eligible = candidates.find(b => isRested(b.left_id) && isRested(b.right_id));

  if (eligible) {
    const waitLeft  = Math.ceil((minRestMs - (now - (fencerLastFenced[bout.left_id] || 0))) / 1000);
    const waitRight = Math.ceil((minRestMs - (now - (fencerLastFenced[bout.right_id] || 0))) / 1000);
    const needRest  = waitLeft > 0 ? bout.left_id  : bout.right_id;
    const waitSec   = Math.max(waitLeft, waitRight);
    console.log(`[OPP2] Dynamic reorder on piste ${pisteId}: fencer ${needRest} needs ${waitSec}s rest — swapping to bout ${eligible.id}`);

    // Swap bout_order values so the eligible bout runs first on this strip.
    // Use a temp value to avoid unique constraint collision.
    const TEMP_ORDER = -9999999;
    db.prepare('UPDATE bouts SET bout_order = ? WHERE id = ?').run(TEMP_ORDER, eligible.id);
    db.prepare('UPDATE bouts SET bout_order = ? WHERE id = ?').run(eligible.bout_order, bout.id);
    db.prepare('UPDATE bouts SET bout_order = ? WHERE id = ?').run(bout.bout_order, eligible.id);

    return Pipeline.nextBout(slot, state?.boutId);
  }

  // No eligible swap found — warn and proceed with original.
  const waitSec = Math.ceil(minRestMs / 1000);
  console.warn(`[OPP2] Dynamic reorder on piste ${pisteId}: no rested bout found within lookahead — referee please wait ~${waitSec}s`);
  return bout;
}

// ── NEXT / PREV / END handlers ───────────────────────────────────────────────

function handleNext(pisteId) {
  const state = pisteState[pisteId];
  if (!state) return;

  let slot = Pipeline.activeSlot(state.stripId);
  if (!slot) {
    slot = Pipeline.recoverStaleSlot(state.stripId);
    if (slot) {
      console.warn(`[OPP2] WARNING: slot ${slot.id} was 'done' but still had pending bouts — auto-recovered for piste ${pisteId}`);
    } else {
      console.log(`[OPP2] Pipeline exhausted for piste ${pisteId}`);
      clearRecord(pisteId);
      return;
    }
  }

  if (slot.status === 'pending') Pipeline.markActive(slot.id);

  if (slot.type === 'team_match' && slot.team_match_id) {
    const match = db.prepare('SELECT draw_winner_team_id FROM team_matches WHERE id = ?').get(slot.team_match_id);
    if (!match?.draw_winner_team_id) {
      console.warn(`[OPP2] WARNING: piste ${pisteId} — team match ${slot.team_match_id} draw not done; fencer names will be empty`);
    } else {
      const orderCount = db.prepare('SELECT COUNT(*) AS n FROM team_match_orders WHERE team_match_id = ?').get(slot.team_match_id).n;
      if (orderCount < 6) {
        console.warn(`[OPP2] WARNING: piste ${pisteId} — team match ${slot.team_match_id} orders incomplete (${orderCount}/6); fencer names will be empty`);
      }
    }
  }

  if (slot.id !== state.slotId) {
    state.boutId       = null;
    state.recordSlotId = randomUUID();
  }

  let bout = Pipeline.nextBout(slot, state.boutId);
  bout = _applyDynamicReorder(pisteId, slot, bout);
  if (!bout) {
    if (Pipeline.pendingBoutCount(slot) > 0) {
      console.log(`[OPP2] NEXT on piste ${pisteId}: only current bout still pending, re-sending`);
      if (state.boutId && state.lastBout && state.lastSlot) {
        sendMatchData(pisteId, state.lastBout, state.lastSlot, state);
        publishRecord(pisteId, state);
      }
      return;
    }

    Pipeline.markDone(slot.id);
    slot = Pipeline.activeSlot(state.stripId);
    if (!slot) { console.log(`[OPP2] Pipeline exhausted for piste ${pisteId}`); clearRecord(pisteId); return; }
    Pipeline.markActive(slot.id);
    const nextBout = Pipeline.nextBout(slot, null);
    if (!nextBout) {
      console.warn(`[OPP2] New slot ${slot.id} for piste ${pisteId} has no pending bouts — skipping`);
      Pipeline.markDone(slot.id);
      return;
    }
    state.slotId       = slot.id;
    state.boutId       = nextBout.id;
    state.lastBout     = nextBout;
    state.lastSlot     = slot;
    state.recordSlotId = randomUUID();
    sendMatchData(pisteId, nextBout, slot, state);
    publishRecord(pisteId, state);
    emitPisteState(pisteId);
    return;
  }

  state.slotId   = slot.id;
  state.boutId   = bout.id;
  state.lastBout = bout;
  state.lastSlot = slot;
  sendMatchData(pisteId, bout, slot, state);
  publishRecord(pisteId, state);
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
      sendMatchData(pisteId, state.lastBout, state.lastSlot, state);
      publishRecord(pisteId, state);
    }
    return;
  }

  state.boutId   = bout.id;
  state.lastBout = bout;
  state.lastSlot = slot;
  sendMatchData(pisteId, bout, slot, state);
  publishRecord(pisteId, state);
}

function handleEnd(pisteId) {
  const state = pisteState[pisteId];
  if (!state || !state.boutId) { sendNak(pisteId); return; }

  const slot = state.slotId ? Pipeline.findById(state.slotId) : null;

  if (slot?.type === 'team_match') {
    const score = state.lastScore;
    if (!score) { sendNak(pisteId); return; }

    // Apparatus sends cumulative touches across the whole match; compute per-relay delta.
    const relayRow = db.prepare(
      'SELECT team_match_id, relay_number FROM relays WHERE id = ?'
    ).get(state.boutId);
    let leftTouches  = score.left?.score  ?? 0;
    let rightTouches = score.right?.score ?? 0;
    if (relayRow) {
      const cumul = db.prepare(`
        SELECT COALESCE(SUM(left_touches),  0) AS cum_left,
               COALESCE(SUM(right_touches), 0) AS cum_right
        FROM relays
        WHERE team_match_id = ? AND relay_number < ? AND status = 'finished'
      `).get(relayRow.team_match_id, relayRow.relay_number);
      leftTouches  = leftTouches  - cumul.cum_left;
      rightTouches = rightTouches - cumul.cum_right;
    }

    try {
      TeamMatch.updateRelay(state.boutId, { leftTouches, rightTouches, timeExpired: 0 });
    } catch (err) {
      console.error(`[OPP2] Relay update error for piste ${pisteId}:`, err.message);
      sendNak(pisteId);
      return;
    }

    publishRecord(pisteId, state, null);
    sendAck(pisteId);
    state.lastScore = null;

    if (state.slotId && slot.status === 'active' && Pipeline.pendingBoutCount(slot) === 0) {
      Pipeline.markDone(state.slotId);
      state.slotId = null;
      state.boutId = null;
    }
    emitPisteState(pisteId);
    if (Settings.get('opp2_auto_next_on_end') === '1') handleNext(pisteId);
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
  if (priority === 'L') {
    const b = Bout.findById(state.boutId);
    winnerId = b?.left_id ?? null;
  } else if (priority === 'R') {
    const b = Bout.findById(state.boutId);
    winnerId = b?.right_id ?? null;
  }

  const { bout: updatedBout, next } = Bout.updateScore(state.boutId, leftScore, rightScore, winnerId);
  emitBoutUpdated(updatedBout, next);

  // Record when each fencer finished, for dynamic reorder rest checks.
  if (updatedBout) {
    const now = Date.now();
    if (updatedBout.left_id)  fencerLastFenced[updatedBout.left_id]  = now;
    if (updatedBout.right_id) fencerLastFenced[updatedBout.right_id] = now;
  }

  publishRecord(pisteId, state, null);
  sendAck(pisteId);
  state.lastScore = null;

  if (state.slotId) {
    const slotCheck = Pipeline.findById(state.slotId);
    if (slotCheck && slotCheck.status === 'active' && Pipeline.pendingBoutCount(slotCheck) === 0) {
      Pipeline.markDone(state.slotId);
      state.slotId = null;
      state.boutId = null;
    }
  }
  emitPisteState(pisteId);

  if (Settings.get('opp2_auto_next_on_end') === '1') handleNext(pisteId);
}

// ── MQTT message router ──────────────────────────────────────────────────────

function handleMessage(mqttTopic, rawMessage) {
  const parts = mqttTopic.split('/');
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
    pisteState[pisteId].apparatusOnline = payload.online === true;
    emitPisteState(pisteId);
    console.log(`[OPP2] Piste ${pisteId} apparatus ${payload.online ? 'online' : 'offline'}`);
  }

  if (publisher === 'apparatus' && msgType === 'score') {
    const prevScore = pisteState[pisteId].lastScore;
    pisteState[pisteId].lastScore = {
      left: payload.left, right: payload.right,
      priority: payload.priority ?? 'N',
    };
    try { detectCardEvents(pisteState[pisteId].boutId, prevScore, payload); }
    catch (err) { console.error('[OPP2] card event error:', err.message); }
  }

  if (publisher === 'apparatus' && msgType === 'uw2f') {
    const prevUw2f = pisteState[pisteId].lastUw2f;
    pisteState[pisteId].lastUw2f = payload;
    try { detectUw2fEvents(pisteState[pisteId].boutId, prevUw2f, payload); }
    catch (err) { console.error('[OPP2] uw2f event error:', err.message); }
  }

  if ((publisher === 'apparatus' || publisher === 'var') && msgType === 'video_review') {
    const prevReview = pisteState[pisteId].lastVideoReview;
    pisteState[pisteId].lastVideoReview = payload;
    try { detectVideoReviewEvents(pisteState[pisteId].boutId, publisher, prevReview, payload); }
    catch (err) { console.error('[OPP2] video_review event error:', err.message); }
  }

  // Recover boutId/slotId from our own retained software/record after a restart.
  if (publisher === 'software' && msgType === 'record') {
    const state = pisteState[pisteId];
    if (state && !state.boutId && payload.active_bout) {
      const boutId = Number(payload.active_bout);
      const bout   = Bout.findById(boutId);
      if (bout && bout.status !== 'finished') {
        const slot = bout.pool_id
          ? db.prepare('SELECT * FROM pipeline_slots WHERE pool_id = ?').get(bout.pool_id)
          : db.prepare('SELECT * FROM pipeline_slots WHERE phase_id = ? AND type = ? ORDER BY slot_order LIMIT 1')
              .get(bout.phase_id, 'de');
        if (slot) {
          state.slotId       = slot.id;
          state.boutId       = boutId;
          state.lastBout     = bout;
          state.lastSlot     = slot;
          state.recordSlotId = payload.slot_id || null;
          console.log(`[OPP2] Recovered piste ${pisteId}: slot ${slot.id}, bout ${boutId}`);
          emitPisteState(pisteId);
        } else { clearRecord(pisteId); }
      } else {
        console.log(`[OPP2] Clearing stale retained record for piste ${pisteId} (bout ${payload.active_bout})`);
        clearRecord(pisteId);
      }
    }
    return;
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

// ── Public API ───────────────────────────────────────────────────────────────

function newPisteEntry(stripId) {
  return {
    stripId, apparatusOnline: false,
    slotId: null, boutId: null, recordSlotId: null,
    lastScore: null, lastUw2f: null, lastVideoReview: null,
    lastBout: null, lastSlot: null,
  };
}

const OPP2 = {
  isConnected() { return Transport.isConnected(); },
  brokerUrl()   { return Transport.getBrokerUrl(); },

  status() {
    return {
      connected: Transport.isConnected(),
      brokerUrl: Transport.getBrokerUrl(),
      pistes: Object.entries(pisteState).map(([pisteId, s]) => {
        let bout = null;
        if (s.boutId) {
          if (s.lastSlot?.type === 'team_match') {
            if (s.lastBout)
              bout = { bout_order: s.lastBout.relay_number, left: s.lastBout.left_last, right: s.lastBout.right_last };
          } else {
            const b = Bout.findById(s.boutId);
            if (b && b.status !== 'finished')
              bout = { bout_order: b.bout_order, left: b.left_last, right: b.right_last };
          }
        }
        return { pisteId, stripId: s.stripId, apparatusOnline: s.apparatusOnline,
                 boutId: s.boutId, slotId: s.slotId, bout };
      }),
    };
  },

  connect(url) {
    if (Transport.isConnected()) this.disconnect();

    const strips = Strip.findAll();
    for (const s of strips) {
      const id = s.name;
      if (pisteState[id]) {
        pisteState[id].stripId = s.id;
      } else {
        pisteState[id] = newPisteEntry(s.id);
      }
    }

    return Transport.connect(url, {
      onConnect() {
        for (const pisteId of Object.keys(pisteState)) {
          Transport.publishConnection(pisteId, true);
          for (const t of ['fencers', 'match'])
            Transport.clearRetained(Transport.topic(pisteId, 'software', t));
        }
        Transport.subscribe('openpiste/+/apparatus/connection',    1);
        Transport.subscribe('openpiste/+/apparatus/control',       1);
        Transport.subscribe('openpiste/+/apparatus/score',         1);
        Transport.subscribe('openpiste/+/apparatus/uw2f',          1);
        Transport.subscribe('openpiste/+/apparatus/video_review',  1);
        Transport.subscribe('openpiste/+/var/video_review',        1);
        Transport.subscribe('openpiste/+/scoresheet/event',        1);
        Transport.subscribe('openpiste/+/software/record',         1);
      },
      onReconnect() {
        for (const pisteId of Object.keys(pisteState))
          Transport.publishConnection(pisteId, true);
      },
      onClose() {
        for (const pisteId of Object.keys(pisteState)) {
          Transport.publishConnection(pisteId, false);
          pisteState[pisteId].apparatusOnline = false;
          emitPisteState(pisteId);
        }
      },
      onMessage: handleMessage,
    });
  },

  disconnect() {
    for (const pisteId of Object.keys(pisteState))
      Transport.publishConnection(pisteId, false);
    Transport.disconnect();
  },

  renamePiste(oldName, newName) {
    if (oldName === newName) return;
    if (pisteState[oldName]) {
      pisteState[newName] = pisteState[oldName];
      delete pisteState[oldName];
    } else {
      pisteState[newName] = pisteState[newName] || newPisteEntry(null);
    }
    if (Transport.isConnected()) {
      Transport.publishConnection(oldName, false);
      Transport.publishConnection(newName, true);
    }
    emitPisteState(newName);
  },

  addPiste(strip) {
    const id = strip.name;
    if (!pisteState[id]) pisteState[id] = newPisteEntry(strip.id);
    if (Transport.isConnected()) {
      Transport.publishConnection(id, true);
      Transport.subscribe(`openpiste/${id}/apparatus/connection`, 1);
    }
  },
};

module.exports = OPP2;
