'use strict';
const db = require('../db');
const { buildSeedPositions } = require('../lib/deFormation');

const stmtPhaseRuleDoc = db.prepare('SELECT rule_doc FROM phases WHERE id=?');
const stmtDeBouts = db.prepare(`
  SELECT b.de_round, b.tableau_position, b.status, b.bracket,
         b.left_id, b.right_id, b.winner_id, b.place_rank,
         lc.first_name AS lf, lc.last_name AS ll, lcl.name AS lclub,
         rc.first_name AS rf, rc.last_name AS rl, rcl.name AS rclub
  FROM bouts b
  LEFT JOIN competitors lc  ON lc.id  = b.left_id
  LEFT JOIN people      lpl ON lpl.id = lc.person_id
  LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
  LEFT JOIN competitors rc  ON rc.id  = b.right_id
  LEFT JOIN people      rpl ON rpl.id = rc.person_id
  LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
  WHERE b.phase_id = ?
  ORDER BY b.de_round, b.tableau_position
`);
const stmtMaxRepRound = db.prepare(
  "SELECT COALESCE(MAX(de_round),0) AS m FROM bouts WHERE phase_id=? AND bracket='repechage'"
);
const stmtDePhaseEntrantCount = db.prepare(`
  SELECT COUNT(DISTINCT id) AS n FROM (
    SELECT left_id  AS id FROM bouts WHERE phase_id = ? AND left_id  IS NOT NULL
    UNION
    SELECT right_id AS id FROM bouts WHERE phase_id = ? AND right_id IS NOT NULL
  )
`);
const stmtPoolRowsAll = db.prepare(`
  SELECT r.position AS pool_rank, r.advanced, r.competitor_id,
         c.first_name, c.last_name, cl.name AS club_name
  FROM rankings r
  JOIN competitors c  ON c.id  = r.competitor_id
  LEFT JOIN people p  ON p.id  = c.person_id
  LEFT JOIN clubs  cl ON cl.id = p.club_id
  WHERE r.phase_id = ?
  ORDER BY r.position
`);
const stmtPoolRowsEliminatedOnly = db.prepare(`
  SELECT r.position AS pool_rank, r.advanced, r.competitor_id,
         c.first_name, c.last_name, cl.name AS club_name
  FROM rankings r
  JOIN competitors c  ON c.id  = r.competitor_id
  LEFT JOIN people p  ON p.id  = c.person_id
  LEFT JOIN clubs  cl ON cl.id = p.club_id
  WHERE r.phase_id = ? AND r.advanced = 0
  ORDER BY r.position
`);
const stmtAdvancedCount = db.prepare(
  'SELECT COUNT(*) AS n FROM rankings WHERE phase_id=? AND advanced=1'
);
const stmtPhasesForCompetition = db.prepare(
  'SELECT id, type, phase_order, status, format_stage FROM phases WHERE competition_id=? ORDER BY phase_order'
);
const stmtCompetitionFormatId = db.prepare('SELECT format_id FROM competitions WHERE id = ?');

// Ranks a single DE phase in isolation — returns entries with `place` numbered
// from 1 within that phase alone. Callers combining multiple independent
// terminal phases (see getCompetitionResults) are responsible for offsetting.
function rankDePhase(dePhaseId) {
  const entries = [];

  const phase = stmtPhaseRuleDoc.get(dePhaseId);
  const { loadRule } = require('../lib/rules');
  const ruleDoc     = loadRule(phase.rule_doc);
  const isRepechage = !!(ruleDoc.repechage?.enabled);

  const bouts = stmtDeBouts.all(dePhaseId);

  // Name/club lookup
  const info = {};
  for (const b of bouts) {
    if (b.left_id)  info[b.left_id]  = { first_name: b.lf, last_name: b.ll, club: b.lclub };
    if (b.right_id) info[b.right_id] = { first_name: b.rf, last_name: b.rl, club: b.rclub };
  }

  // Only main-bracket bouts drive totalRounds; placement bouts are handled separately.
  const mainBouts   = bouts.filter(b => b.bracket === 'main' || !b.bracket);
  const totalRounds = mainBouts.reduce((m, b) => Math.max(m, b.de_round || 0), 0);

  if (totalRounds > 0) {
    // DE seed lookup from R1 positions (main bracket only)
    const r1 = mainBouts.filter(b => b.de_round === 1);
    const T  = r1.length * 2;
    const seedSlots = buildSeedPositions(T);
    const deSeed = {};
    for (const b of r1) {
      const p = b.tableau_position;
      if (b.left_id)  deSeed[b.left_id]  = seedSlots[2 * (p - 1)];
      if (b.right_id) deSeed[b.right_id] = seedSlots[2 * (p - 1) + 1];
    }

    const push = (place, placeLabel, id, note) => {
      const i = info[id] || {};
      entries.push({ place, place_label: placeLabel, competitor_id: id,
        de_seed: deSeed[id] || null,
        first_name: i.first_name, last_name: i.last_name, club: i.club, note });
    };

    // 1st and 2nd — only when final is decided
    const finalBout = mainBouts.find(b => b.de_round === totalRounds && b.tableau_position === 1);
    if (finalBout?.winner_id) {
      push(1, '1', finalBout.winner_id, 'DE winner');
      const silver = finalBout.winner_id === finalBout.left_id
        ? finalBout.right_id : finalBout.left_id;
      push(2, '2', silver, 'DE final');
    }

    // Placement bouts with place_rank give unique places (allPlacesFenced or bronze).
    const terminalPlacements = bouts
      .filter(b => b.bracket === 'placement' && b.place_rank != null)
      .sort((a, b) => a.place_rank - b.place_rank);

    // Pre-014 phases: detect bronze by position if no place_rank column is present
    const legacyBronze = terminalPlacements.length === 0
      ? bouts.find(b => b.bracket === 'placement' && b.de_round === totalRounds && b.tableau_position === 2)
      : null;
    if (legacyBronze) terminalPlacements.push({ ...legacyBronze, place_rank: 3 });

    const placedByPlacement = new Set();
    for (const pb of terminalPlacements) {
      if (pb.status === 'finished' && pb.winner_id) {
        push(pb.place_rank, String(pb.place_rank), pb.winner_id, 'Placement bout');
        const loser = pb.winner_id === pb.left_id ? pb.right_id : pb.left_id;
        push(pb.place_rank + 1, String(pb.place_rank + 1), loser, 'Placement bout');
        placedByPlacement.add(pb.winner_id);
        if (loser) placedByPlacement.add(loser);
      }
    }

    if (isRepechage) {
      // Repechage ranking: determined by which repechage round a fencer was eliminated.
      // All fencers who finished in the finals (H/I/J) are handled by main-bracket logic above.
      // Repechage table losers get shared ranks based on their elimination round:
      //   G-losers (last rep injection losers): next band
      //   F-losers, E-losers, D-losers: further bands
      const reT   = ruleDoc.repechage.reentryAt;
      const maxRepRound = stmtMaxRepRound.get(dePhaseId).m;
      const n     = maxRepRound / 2;
      const lastMainRound = n + 1;
      const finalsRounds  = Math.log2(reT);
      const firstFinalsRound = lastMainRound + 1;

      // Finals losers not yet placed (H-losers = 5th-8th for T32→T8)
      // Exclude fencers still in a pending placement bout (e.g. SF losers awaiting bronze).
      const pendingPlacementIds = new Set(
        bouts.filter(b => b.bracket === 'placement' && b.status !== 'finished')
             .flatMap(b => [b.left_id, b.right_id].filter(Boolean))
      );
      for (let fr = finalsRounds - 1; fr >= 1; fr--) {
        const de_round = lastMainRound + fr;
        const bInRound = mainBouts.filter(b => b.de_round === de_round && b.status === 'finished'
                            && b.winner_id && b.left_id && b.right_id);
        if (!bInRound.length) continue;
        // Place: 2^(finalsRounds - fr) + 1 within the finals bracket
        const startPlace = Math.pow(2, finalsRounds - fr) + 1;
        const losers = bInRound
          .map(b => ({ id: b.winner_id === b.left_id ? b.right_id : b.left_id }))
          .filter(l => !placedByPlacement.has(l.id) && !entries.find(e => e.competitor_id === l.id)
                    && !pendingPlacementIds.has(l.id))
          .sort((a, b) => (deSeed[a.id] || 999) - (deSeed[b.id] || 999));
        const note = fr === finalsRounds - 1 ? 'Finals semi-final' : 'Finals quarter-final';
        losers.forEach((l, i) => push(startPlace + i, String(startPlace + i), l.id, note));
      }

      // Repechage losers by elimination round (highest de_round first = closest to finals)
      // Pre-compute the correct starting place for each round so that unscored higher
      // rounds still reserve their slots — e.g. Table C losers always rank below
      // Table D losers even when Table D hasn't been scored yet.
      const repBouts = bouts.filter(b => b.bracket === 'repechage');
      const placed = new Set(entries.map(e => e.competitor_id));

      const repRoundSize = {};
      for (let r = 1; r <= maxRepRound; r++)
        repRoundSize[r] = repBouts.filter(b => b.de_round === r).length;

      let repOffset = 0;
      const repRoundStart = {};
      for (let r = maxRepRound; r >= 1; r--) {
        repRoundStart[r] = reT + 1 + repOffset;
        repOffset += repRoundSize[r];
      }

      for (let r = maxRepRound; r >= 1; r--) {
        const eliminated = repBouts
          .filter(b => b.de_round === r && b.status === 'finished'
                    && b.winner_id && b.left_id && b.right_id)
          .map(b => ({ id: b.winner_id === b.left_id ? b.right_id : b.left_id }))
          .filter(l => !placed.has(l.id));
        if (!eliminated.length) continue;
        const sp = repRoundStart[r];
        eliminated.forEach((l, i) => {
          push(sp + i, String(sp + i), l.id, 'Repechage round ' + r);
          placed.add(l.id);
        });
      }

      // Main bracket losers who went to repechage but are not yet in entries
      // (they were eliminated by a repechage round, already handled above)

    } else {
      // Standard DE: main-bracket round losers not yet placed share a start-place.
      for (let r = totalRounds - 1; r >= 1; r--) {
        const roundStartPlace = 2 ** (totalRounds - r) + 1;
        const roundNote = r === totalRounds - 1 ? 'DE semi-final'
                        : r === totalRounds - 2 ? 'DE quarter-final'
                        : 'DE round of ' + (2 ** (totalRounds - r + 1));
        const losers = mainBouts
          .filter(b => b.de_round === r && b.status === 'finished'
                    && b.winner_id && b.left_id && b.right_id)
          .map(b => ({ id: b.winner_id === b.left_id ? b.right_id : b.left_id }))
          .filter(l => !placedByPlacement.has(l.id))
          .map(l => ({ ...l, seed: deSeed[l.id] || 999 }))
          .sort((a, b) => a.seed - b.seed);

        for (let i = 0; i < losers.length; i++) {
          push(roundStartPlace + i, String(roundStartPlace + i), losers[i].id, roundNote);
        }
      }
    }
  }

  return entries;
}

// Total real entrants in a DE phase (distinct competitors appearing in any of
// its bouts), independent of how far the bracket has progressed. Used to
// offset ranks correctly when merging multiple independent terminal phases —
// offsetting by *entries produced so far* would be wrong mid-tournament,
// since a phase with only 2 of 16 places decided must still shift the next
// track's ranks by its full 16, not by 2.
function _dePhaseEntrantCount(phaseId) {
  return stmtDePhaseEntrantCount.get(phaseId, phaseId).n;
}

function fetchPoolRows(phaseId, onlyEliminated) {
  return (onlyEliminated ? stmtPoolRowsEliminatedOnly : stmtPoolRowsAll).all(phaseId);
}

// Ranks any phase (pool or DE) into one shared entry shape, sorted best-to-
// worst, `place` relative to this phase alone — callers renumber. onlyEliminated
// only affects the pool branch (rankDePhase always returns exactly whoever has
// a decided outcome in that phase, nothing more).
function _rankPhase(phase, onlyEliminated) {
  if (phase.type === 'de') {
    return rankDePhase(phase.id).sort((a, b) => a.place - b.place);
  }
  return fetchPoolRows(phase.id, onlyEliminated).map(row => ({
    place: row.pool_rank, place_label: String(row.pool_rank),
    competitor_id: row.competitor_id, de_seed: null,
    first_name: row.first_name, last_name: row.last_name, club: row.club_name,
    note: 'Pool rank ' + row.pool_rank,
  }));
}

// ---------------------------------------------------------------------------
// Format-driven competitions: rank every terminal stage (see
// services/formats.js's getTerminalStages — nothing else depends on it; the
// usual case is one DE phase, independent parallel tracks like Division 1/2
// have one per track, and a stage like pool-level-pools.json's level_pools
// (isFinalRanking) can be a terminal *pool* phase), merged/offset in
// format-declared order. Then walk every other (non-terminal) phase, in
// reverse pipeline order, appending whoever was eliminated there — pool or
// DE — continuing the running place counter. This replaces the old
// "guess the boundary from the last pool phase's advanced count" heuristic,
// which broke on any format with a pre-pool exempt cohort or an intermediate
// DE stage that itself eliminates people (e.g. grand-prix-fie's preliminary
// tableau) — see docs/format-system-comparison.md §12 for the full account.
// ---------------------------------------------------------------------------
function _getResultsForFormat(compId, phases, format) {
  const Format = require('./formats');
  const terminalStageIds = new Set(Format.getTerminalStages(format));
  const stageOrder = new Map(format.stages.map((s, i) => [s.id, i]));

  const terminalPhases = phases
    .filter(p => p.format_stage && terminalStageIds.has(p.format_stage))
    .sort((a, b) => stageOrder.get(a.format_stage) - stageOrder.get(b.format_stage));

  if (terminalPhases.length === 0) return []; // nothing created yet

  const entries = [];
  let placeOffset = 0;
  for (const phase of terminalPhases) {
    // false: a terminal pool phase (e.g. level_pools) shows everyone — by
    // definition nothing comes after it, so there's no "advanced" subset
    // reserved for a later stage.
    const rows = _rankPhase(phase, false);
    for (const e of rows) {
      const place = e.place + placeOffset;
      entries.push({ ...e, place, place_label: String(place) });
    }
    placeOffset += phase.type === 'de' ? _dePhaseEntrantCount(phase.id) : rows.length;
  }

  const seen = new Set(entries.map(e => e.competitor_id));
  const terminalIds = new Set(terminalPhases.map(p => p.id));
  const nonTerminal = phases
    .filter(p => !terminalIds.has(p.id) && (p.type === 'pool' || p.type === 'de'))
    .sort((a, b) => b.phase_order - a.phase_order);

  for (const phase of nonTerminal) {
    const stage = format.stages.find(s => s.id === phase.format_stage);
    const label = stage?.label || (phase.type === 'de' ? 'Preliminary tableau' : 'Pool round');
    // true: only the eliminated subset — whoever advanced continues into a
    // later stage and gets placed from there instead.
    const rows = _rankPhase(phase, true);
    for (const row of rows) {
      if (seen.has(row.competitor_id)) continue;
      const place = ++placeOffset;
      const note = phase.type === 'pool' ? `${label} (rank ${row.place})` : `${label} — eliminated`;
      entries.push({ ...row, place, place_label: String(place), note });
      seen.add(row.competitor_id);
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Free-form (no format) competitions: unchanged from before independent
// parallel tracks or the format-driven rewrite above existed. Kept verbatim
// on its own path so nothing here can regress — free-form competitions have
// no cohorts or multi-stage structure, so "advanced out of the last pool
// phase == the DE bracket's headcount" always holds exactly.
// ---------------------------------------------------------------------------
function _getResultsFreeForm(compId, phases) {
  const dePhase = [...phases].reverse().find(p => p.type === 'de');
  const entries = dePhase ? rankDePhase(dePhase.id) : [];

  const finishedPools = phases
    .filter(p => p.type === 'pool' && p.status === 'finished')
    .sort((a, b) => b.phase_order - a.phase_order);

  if (finishedPools.length > 0) {
    const seen = new Set(entries.map(e => e.competitor_id));
    const lastPool = finishedPools[0];

    const pushEntry = (place, row, note) => {
      entries.push({
        place, place_label: String(place),
        competitor_id: row.competitor_id,
        de_seed: null,
        first_name: row.first_name, last_name: row.last_name, club: row.club_name,
        note,
      });
      seen.add(row.competitor_id);
    };

    const advancedCount = stmtAdvancedCount.get(lastPool.id).n;
    const hasLaterPhase = phases.some(p => p.phase_order > lastPool.phase_order) || advancedCount > 0;

    let nextPlace;
    if (hasLaterPhase) {
      nextPlace = advancedCount + 1;
      for (const row of fetchPoolRows(lastPool.id, true)) {
        if (seen.has(row.competitor_id)) continue;
        pushEntry(nextPlace++, row, 'Pool phase (rank ' + row.pool_rank + ')');
      }
    } else {
      nextPlace = 1;
      for (const row of fetchPoolRows(lastPool.id, false)) {
        if (seen.has(row.competitor_id)) continue;
        pushEntry(nextPlace++, row, 'Pool phase (rank ' + row.pool_rank + ')');
      }
    }

    for (let i = 1; i < finishedPools.length; i++) {
      for (const row of fetchPoolRows(finishedPools[i].id, true)) {
        if (seen.has(row.competitor_id)) continue;
        pushEntry(nextPlace++, row,
          'Pool round ' + finishedPools[i].phase_order + ' (rank ' + row.pool_rank + ')');
      }
    }
  }

  return entries;
}

function getCompetitionResults(compId) {
  const phases = stmtPhasesForCompetition.all(compId);

  const comp = stmtCompetitionFormatId.get(compId);
  let format = null;
  if (comp?.format_id) {
    const Format = require('./formats');
    try { format = Format.loadFormat(comp.format_id); } catch { /* format file missing/renamed */ }
  }

  return format ? _getResultsForFormat(compId, phases, format) : _getResultsFreeForm(compId, phases);
}

module.exports = { getCompetitionResults };
