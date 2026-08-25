'use strict';
// Pure DE-tableau/partition math shared by services/pipelineSlots.js,
// pipelineNav.js, and pipelineRosters.js — extracted out of the former
// services/pipeline.js god-file (2026-07-29 split) since none of it needs
// the slot-CRUD/navigation/roster machinery around it, just a slot's own
// tableau/partition/de_round fields (and, for tableauToDeRound, one query
// against bouts).
const db = require('../db');
const DeLayout = require('../services/deLayout');

// Bouts in a DE round ordered by tableau position.
// round_index is 1-based within the round, matching partition ranges.
// bracket is bound as the first parameter of the outer query (see call sites).
const DE_BOUT_ORDER = `
  SELECT b.id, b.tableau_position, b.status, b.left_id, b.right_id,
         b.left_score, b.right_score, b.winner_id, b.de_round,
         ROW_NUMBER() OVER (PARTITION BY b.phase_id, b.de_round
                            ORDER BY b.tableau_position) AS round_index
  FROM bouts b
  WHERE b.de_round IS NOT NULL AND b.bracket = ?
`;

// Convert a slot's tableau size to the de_round integer stored on bouts.
// de_round 1 = first (largest) round; each subsequent round halves the field.
// Derived from the bout count in round 1: initial_tableau = count_in_round_1 × 2.
const stmtRound1CountForTableau = db.prepare(`
  SELECT COUNT(*) AS cnt FROM bouts WHERE phase_id = ? AND de_round = 1
`);
function tableauToDeRound(phaseId, tableau) {
  if (!phaseId || !tableau) return null;
  const r = stmtRound1CountForTableau.get(phaseId);
  if (!r || !r.cnt) return null;
  const initialTableau = r.cnt * 2;
  const round = Math.round(Math.log2(initialTableau / tableau)) + 1;
  return round >= 1 ? round : null;
}

// Convert a partition code to a 1-based [lo, hi] round_index range.
// Partition codes are hierarchical binary subdivisions of the round:
//   'full'      → all bouts   [1, n]
//   'A' / 'B'   → halves      [1, n/2] / [n/2+1, n]
//   'A1'/'A2'   → quarters    [1, n/4] / [n/4+1, n/2]
//   'B1'/'B2'   → right quart [n/2+1, 3n/4] / [3n/4+1, n]
//   'A1a'…      → eighths, etc.
// n = tableau / 2  (bouts in the round = fencers / 2)
// Each character halves the current range: A/1/a = lower half, B/2/b = upper half.
// Letters I and O are skipped in displayed labels to avoid confusion with 1 and 0.
function partitionToRange(partition, tableau) {
  const n = tableau / 2;
  if (!partition || partition === 'full') return [1, n];
  let lo = 1, hi = n;
  for (const ch of partition) {
    const mid = Math.floor((lo + hi) / 2);
    const isLower = (ch === 'A' || ch === '1' || ch === 'a' || ch === 'c' || ch === 'e' || ch === 'g');
    if (isLower) hi = mid; else lo = mid + 1;
  }
  return [lo, hi];
}

// Inverse of partitionToRange: encode a 1-based [lo, hi] range in [1, n] back
// to its canonical partition code, or null if [lo, hi] doesn't align with a
// binary-tree node (mirrors public/opp2.html's own rangeToPartition, used
// there to validate a bout-range selection before ever submitting it).
function rangeToPartition(lo, hi, n) {
  if (lo === 1 && hi === n) return 'full';
  const loChars = ['A', '1', 'a', 'c', 'e', 'g'];
  const hiChars = ['B', '2', 'b', 'd', 'f', 'h'];
  let lo_ = 1, hi_ = n, code = '', depth = 0;
  while (lo_ < hi_) {
    const mid = Math.floor((lo_ + hi_) / 2);
    if (lo >= lo_ && hi <= mid)          { code += loChars[depth]; hi_ = mid; }
    else if (lo >= mid + 1 && hi <= hi_) { code += hiChars[depth]; lo_ = mid + 1; }
    else break;
    depth++;
  }
  return (lo_ === lo && hi_ === hi) ? code : null;
}

// Is `partition` an actual, structurally valid subdivision code for this
// tableau — not just a string partitionToRange happens not to crash on?
// partitionToRange alone can't tell: it silently tolerates garbage (unknown
// characters are just treated as "upper half", and an over-long string can
// walk lo past hi into an empty/invalid range) rather than rejecting it.
// Added 2026-07-28 (architecture review) — previously opp2.html's own
// rangeToPartition-returning-null check was the *only* validation of this
// anywhere, and it only ever ran client-side; Pipeline.addSlot accepted any
// partition string a request happened to include.
function isValidPartition(partition, tableau) {
  if (!partition || partition === 'full') return true;
  const n = tableau / 2;
  const [lo, hi] = partitionToRange(partition, tableau);
  if (!(lo >= 1 && hi <= n && lo <= hi)) return false;
  return rangeToPartition(lo, hi, n) === partition;
}

// Resolve a DE slot's bracket parameters into the values the SQL queries need.
// Slots created since migration 026 carry an explicit de_round (set by
// de.html/opp2.html from deLayout's stripSlot) so no guessing is needed —
// this is what lets repechage/Finals rounds be told apart even though a
// repechage phase's last main round and first Finals round always share
// the same `tableau` value. Older slots (pre-026, main bracket only) fall
// back to the previous tableau-based inference.
function deSlotParams(slot) {
  const bracket = slot.bracket || 'main';
  if (slot.de_round != null) {
    const [lo, hi] = partitionToRange(slot.partition, slot.tableau);
    return { deRound: slot.de_round, lo, hi, bracket };
  }
  const deRound = tableauToDeRound(slot.phase_id, slot.tableau);
  const [lo, hi] = partitionToRange(slot.partition, slot.tableau);
  return { deRound, lo, hi, bracket };
}

// Fill in bout_count for DE slots (needed for predicted-end computation).
function fillDeBoutCount(slot) {
  if (slot.type !== 'de' || slot.bout_count != null) return slot;
  if (slot.bracket === 'placement') {
    const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
    return { ...slot, bout_count: ids.length };
  }
  if (!slot.tableau) return slot;
  const [lo, hi] = partitionToRange(slot.partition, slot.tableau);
  return { ...slot, bout_count: hi - lo + 1 };
}

// How many of a DE slot's bouts have already resolved as byes (finished,
// with only one real side) — a slot scheduled ahead of time against a
// services/dePhases.js skeleton round can't know this until real seeding
// happens (bye positions only exist once real N is known), so this is
// deliberately a live DB check, not derivable from the slot's own fields the
// way fillDeBoutCount's plain range math is. public/js/opp2-core.js's
// slotLabel uses this to mark a slot "(bye)" once it's no longer real work,
// instead of it silently sitting in the queue looking like a normal match.
// Placement bouts have no de_round-scoped bye concept the same way (a bye
// only ever happens in the main bracket's round 1) — skipped.
const stmtDeByeInfo = db.prepare(`
  WITH ordered AS (${DE_BOUT_ORDER})
  SELECT COUNT(*) AS total,
    SUM(CASE WHEN b.status = 'finished' AND (b.left_id IS NULL OR b.right_id IS NULL) THEN 1 ELSE 0 END) AS byes
  FROM bouts b
  JOIN ordered o ON o.id = b.id
  WHERE b.phase_id = ? AND b.de_round = ? AND o.round_index BETWEEN ? AND ?
`);
function fillDeByeInfo(slot) {
  if (slot.type !== 'de' || slot.bracket === 'placement' || !slot.tableau) return slot;
  const { deRound, lo, hi, bracket } = deSlotParams(slot);
  if (deRound == null || lo == null) return slot;
  const row = stmtDeByeInfo.get(bracket, slot.phase_id, deRound, lo, hi);
  // Also normalize de_round onto the returned object: opp2-add-slot.js and
  // opp2-bulk-assign.js's submit functions never sent de_round/bracket in
  // their POST body (a real bug, fixed alongside this), so every DE slot
  // created through opp2.html before that fix has de_round=NULL in the DB.
  // deSlotParams already resolves the same value from tableau+phase_id for
  // the query above — piggyback it here so public/js/opp2-core.js's
  // slotLabel can show the round without a DB backfill of existing rows.
  return { ...slot, de_round: deRound, de_bye_count: row?.byes || 0, de_bout_total: row?.total || 0 };
}

module.exports = {
  DE_BOUT_ORDER,
  tableauToDeRound,
  partitionToRange,
  rangeToPartition,
  isValidPartition,
  deSlotParams,
  fillDeBoutCount,
  fillDeByeInfo,
};
