'use strict';
const SSE = require('./sse');

// Emit all SSE events that follow a bout score change.
// bout  — the updated bout (returned by Bout.updateScore / Bout.undo)
// next  — the next-round DE bout modified by advanceDEWinner, or null
function emitBoutUpdated(bout, next) {
  if (!bout) return;
  if (bout.pool_id)       SSE.emit(bout.pool_id,           'bout-updated',    bout);
  if (bout.phase_id)      SSE.emit(bout.phase_id,          'bout-updated',    bout);
  if (next?.phase_id)     SSE.emit(next.phase_id,          'bout-updated',    next);
  if (bout.competition_id) SSE.emit('comp_' + bout.competition_id, 'results-updated', {});
}

module.exports = { emitBoutUpdated };
