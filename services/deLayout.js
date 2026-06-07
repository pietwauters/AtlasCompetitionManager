'use strict';
const db           = require('../db');
const Bout         = require('./bouts');
const { loadRule } = require('../lib/rules');

const A = 'A'.charCodeAt(0);
const letter = n => String.fromCharCode(A + n);

function ord(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function groupByRound(bouts) {
  const map = {};
  for (const b of bouts) {
    const r = b.de_round || 0;
    (map[r] = map[r] || []).push(b);
  }
  return map;
}

function sortByPosition(bouts) {
  return bouts.slice().sort((a, b) => (a.tableau_position || 0) - (b.tableau_position || 0));
}

function mainRoundLabel(ri, total, tableau) {
  const fromEnd = total - ri; // 1 = final, 2 = SF, 3 = QF
  if (fromEnd === 1) return 'Final';
  if (fromEnd === 2) return 'Semi-final';
  if (fromEnd === 3) return 'Quarter-final';
  return 'Round of ' + tableau;
}

function finalsRoundLabel(fi, total) {
  const fromEnd = total - fi;
  if (fromEnd === 1) return ' — Final';
  if (fromEnd === 2) return ' — Semi-final';
  if (fromEnd === 3) return ' — Quarter-final';
  return '';
}

function placementSectionLabel(startPlace, endPlace) {
  if (startPlace === 3 && endPlace === 4) return 'Bronze bout — 3rd–4th place';
  return ord(startPlace) + '–' + ord(endPlace - 1) + ' place';
}

function placementRoundLabel(lv, totalLevels) {
  if (lv === totalLevels - 1) return totalLevels === 1 ? 'Place bout' : 'Place bouts';
  return 'Round ' + (lv + 1);
}

function buildPlacementSections(bouts) {
  if (!bouts.length) return [];

  const pMap    = new Map(bouts.map(b => [b.id, b]));
  const inbound = new Map();
  for (const b of bouts) inbound.set(b.id, []);
  for (const b of bouts) {
    for (const nid of [b.winner_next_bout_id, b.loser_next_bout_id]) {
      if (nid && inbound.has(nid)) inbound.get(nid).push(b.id);
    }
  }

  // BFS to assign levels (round within group)
  const levels = new Map();
  const queue  = [];
  for (const b of bouts) {
    if (inbound.get(b.id).length === 0) { levels.set(b.id, 0); queue.push(b.id); }
  }
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    const lv = levels.get(id);
    const b  = pMap.get(id);
    for (const nid of [b.winner_next_bout_id, b.loser_next_bout_id]) {
      if (nid && pMap.has(nid) && !levels.has(nid)) {
        levels.set(nid, lv + 1);
        queue.push(nid);
      }
    }
  }

  // Connected components (bidirectional DFS)
  const visited    = new Set();
  const components = [];
  for (const b of bouts) {
    if (visited.has(b.id)) continue;
    const comp  = [];
    const stack = [b.id];
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id); comp.push(id);
      const bout = pMap.get(id);
      const nbrs = [
        ...inbound.get(id),
        ...[bout.winner_next_bout_id, bout.loser_next_bout_id].filter(n => n && pMap.has(n)),
      ];
      for (const nid of nbrs) if (!visited.has(nid)) stack.push(nid);
    }
    components.push(comp);
  }

  return components.map(comp => {
    const maxLevel  = Math.max(...comp.map(id => levels.get(id) ?? 0));
    const terminals = comp.filter(id => pMap.get(id).place_rank != null);

    let startPlace, endPlace;
    if (terminals.length) {
      startPlace = Math.min(...terminals.map(id => pMap.get(id).place_rank));
      endPlace   = Math.max(...terminals.map(id => pMap.get(id).place_rank)) + 1;
    } else {
      // Pre-014 fallback: detect bronze by tableau_position
      const bronzeId = comp.find(id => pMap.get(id).tableau_position === 2);
      if (bronzeId) { pMap.get(bronzeId).place_rank = 3; startPlace = 3; endPlace = 4; }
      else           { startPlace = 1; endPlace = 2; }
    }

    const totalLevels = maxLevel + 1;
    const rounds = [];
    for (let lv = 0; lv <= maxLevel; lv++) {
      const lvBouts = comp
        .filter(id => (levels.get(id) ?? 0) === lv)
        .map(id => pMap.get(id))
        .sort((a, b) => (a.bout_order || 0) - (b.bout_order || 0));
      rounds.push({
        label:    placementRoundLabel(lv, totalLevels),
        note:     null,
        stripSlot: { bracket: 'placement', tableau: startPlace, partition: String(lv) },
        bouts:    lvBouts,
      });
    }

    return {
      id:          'placement-' + startPlace,
      label:       placementSectionLabel(startPlace, endPlace),
      displayHint: 'list',
      note:        null,
      rounds,
    };
  }).sort((a, b) => {
    const pa = parseInt(a.id.split('-')[1], 10);
    const pb = parseInt(b.id.split('-')[1], 10);
    return pa - pb;
  });
}

const DeLayout = {
  buildSections(phaseId) {
    const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
    if (!phase) return null;

    const rule  = loadRule(phase.rule_doc);
    const bouts = Bout.findByPhase(phaseId);

    const isRepechage = !!(rule.repechage?.enabled);
    const reT         = isRepechage ? rule.repechage.reentryAt : null;

    const mainBouts      = bouts.filter(b => b.bracket === 'main' || !b.bracket);
    const repBouts       = bouts.filter(b => b.bracket === 'repechage');
    const placementBouts = bouts.filter(b => b.bracket === 'placement');

    const r1 = mainBouts.filter(b => b.de_round === 1);
    const T  = r1.length * 2;

    const sections = [];

    if (isRepechage) {
      const maxRepRound   = repBouts.reduce((m, b) => Math.max(m, b.de_round || 0), 0);
      const lastMainRound = maxRepRound / 2 + 1;

      // ── Main bracket (Tables A, B, C…)
      const mainByRound = groupByRound(mainBouts.filter(b => b.de_round <= lastMainRound));
      const mainSection = {
        id: 'main', label: 'Main bracket', displayHint: 'bracket',
        note: 'Losers enter repechage', rounds: [],
      };
      for (let r = 1; r <= lastMainRound; r++) {
        const tableau = T >> (r - 1);
        mainSection.rounds.push({
          label:    'Table ' + letter(r - 1),
          note:     'Round of ' + tableau,
          stripSlot: { bracket: 'main', tableau, partition: 'full' },
          bouts:    sortByPosition(mainByRound[r] || []),
        });
      }
      sections.push(mainSection);

      // ── Repechage tables (Tables D, E, F, G…)
      const repByRound  = groupByRound(repBouts);
      const repSection  = {
        id: 'repechage', label: 'Repechage', displayHint: 'list', note: null, rounds: [],
      };
      for (let r = 1; r <= maxRepRound; r++) {
        repSection.rounds.push({
          label:    'Table ' + letter(lastMainRound + r - 1),
          note:     null,
          stripSlot: null,
          bouts:    sortByPosition(repByRound[r] || []),
        });
      }
      sections.push(repSection);

      // ── Finals (Tables H, I, J…)
      const finalsMain    = mainBouts.filter(b => b.de_round > lastMainRound);
      const finalsByRound = groupByRound(finalsMain);
      const finalsRoundNums = Object.keys(finalsByRound).map(Number).sort((a, b) => a - b);
      if (finalsRoundNums.length) {
        const numFinalsRounds = finalsRoundNums.length;
        const finalsSection = {
          id: 'finals', label: 'Finals', displayHint: 'bracket', note: null, rounds: [],
        };
        finalsRoundNums.forEach((r, fi) => {
          const tableau   = reT >> fi;
          const letterIdx = lastMainRound + maxRepRound + fi;
          finalsSection.rounds.push({
            label:    'Table ' + letter(letterIdx) + finalsRoundLabel(fi, numFinalsRounds),
            note:     null,
            stripSlot: { bracket: 'main', tableau, partition: 'full' },
            bouts:    sortByPosition(finalsByRound[r] || []),
          });
        });
        sections.push(finalsSection);
      }

    } else {
      // ── Standard DE (no repechage)
      const mainByRound = groupByRound(mainBouts);
      const totalRounds = Object.keys(mainByRound).map(Number).sort((a, b) => a - b);
      const N           = totalRounds.length;
      const mainSection = {
        id: 'main', label: 'Tableau', displayHint: 'bracket', note: null, rounds: [],
      };
      totalRounds.forEach((r, ri) => {
        const tableau = T >> (r - 1);
        mainSection.rounds.push({
          label:    mainRoundLabel(ri, N, tableau),
          note:     null,
          stripSlot: { bracket: 'main', tableau, partition: 'full' },
          bouts:    sortByPosition(mainByRound[r] || []),
        });
      });
      sections.push(mainSection);
    }

    // ── Placement groups
    sections.push(...buildPlacementSections(placementBouts));

    return { tableauSize: T, sections };
  },
};

module.exports = DeLayout;
