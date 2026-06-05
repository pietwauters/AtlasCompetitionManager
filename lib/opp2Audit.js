'use strict';
const Bout  = require('../services/bouts');
const Event = require('../services/events');

function boutCtx(boutId) {
  if (!boutId) return null;
  const b = Bout.findById(boutId);
  if (!b) return null;
  return { competition_id: b.competition_id, phase_id: b.phase_id, bout_id: boutId };
}

function detectCardEvents(boutId, prevScore, nextScore) {
  const ctx = boutCtx(boutId);
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

function detectUw2fEvents(boutId, prevUw2f, nextUw2f) {
  const ctx = boutCtx(boutId);
  if (!ctx) return;
  const base = { ...ctx, actor: 'apparatus' };

  for (const side of ['left', 'right']) {
    const before = prevUw2f?.[side]?.p_card || 0;
    const after  = nextUw2f[side]?.p_card   || 0;
    for (let i = before; i < after; i++) {
      Event.record({ ...base, event_type: 'card.p', side, payload: { before, after } });
    }
  }
}

function detectVideoReviewEvents(boutId, actor, prevReview, nextReview) {
  const ctx = boutCtx(boutId);
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

module.exports = { detectCardEvents, detectUw2fEvents, detectVideoReviewEvents };
