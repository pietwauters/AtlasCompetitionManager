'use strict';

// ---------------------------------------------------------------------------
// FIE Official Bout Orders — Individual Competitions (January 2004)
//
// Each entry is an array of [left, right] pairs using 1-based position indices
// within the pool.  The position indices refer to the *assigned* positions of
// the fencers, which may differ from serpentine order when teammates need to
// be placed at specific "preferred" positions (see assignPoolPositions below).
// ---------------------------------------------------------------------------

// Standard bout orders — used when there are no teammate groups, or when the
// standard table itself handles teammate placement (pool of 7).
const STANDARD = {
  4:  [[1,4],[2,3],[1,3],[2,4],[3,4],[1,2]],
  5:  [[1,2],[3,4],[5,1],[2,3],[5,4],[1,3],[2,5],[4,1],[3,5],[4,2]],
  6:  [[1,2],[4,5],[2,3],[5,6],[3,1],[6,4],[2,5],[1,4],[5,3],[1,6],[4,2],[3,6],[5,1],[3,4],[6,2]],
  // Pool of 7: standard order also handles up to 3 pairs — teammates at (1,4),
  // (2,5), (3,6) fence each other in bouts 1-2-3 respectively.
  7:  [[1,4],[2,5],[3,6],[7,1],[5,4],[2,3],[6,7],[5,1],[4,3],[6,2],[5,7],[3,1],[4,6],[7,2],[3,5],[1,6],[2,4],[7,3],[6,5],[1,2],[4,7]],
  8:  [[2,3],[1,5],[7,4],[6,8],[1,2],[3,4],[5,6],[8,7],[4,1],[5,2],[8,3],[6,7],[4,2],[8,1],[7,5],[3,6],[2,8],[5,4],[6,1],[3,7],[4,8],[2,6],[3,5],[1,7],[4,6],[8,5],[7,2],[1,3]],
  9:  [[1,9],[2,8],[3,7],[4,6],[1,5],[2,9],[8,3],[7,4],[6,5],[1,2],[9,3],[8,4],[7,5],[6,1],[3,2],[9,4],[5,8],[7,6],[3,1],[2,4],[5,9],[8,6],[7,1],[4,3],[5,2],[6,9],[8,7],[4,1],[5,3],[6,2],[9,7],[1,8],[4,5],[3,6],[2,7],[9,8]],
  10: [[1,4],[6,9],[2,5],[7,10],[3,1],[8,6],[4,5],[9,10],[2,3],[7,8],[5,1],[10,6],[4,2],[9,7],[5,3],[10,8],[1,2],[6,7],[3,4],[8,9],[5,10],[1,6],[2,7],[3,8],[4,9],[6,5],[10,2],[8,1],[7,4],[9,3],[2,6],[5,8],[4,10],[1,9],[3,7],[8,2],[6,4],[9,5],[10,3],[7,1],[4,8],[2,9],[3,6],[5,7],[1,10]],
  11: [[1,2],[7,8],[4,5],[10,11],[2,3],[8,9],[5,6],[3,1],[9,7],[6,4],[2,5],[8,11],[1,4],[7,10],[5,3],[11,9],[1,6],[4,2],[10,8],[3,6],[5,1],[11,7],[3,4],[9,10],[6,2],[1,7],[3,9],[10,4],[8,2],[5,11],[1,8],[9,2],[3,10],[4,11],[6,7],[9,1],[2,10],[11,3],[7,5],[6,8],[10,1],[11,2],[4,7],[8,5],[6,9],[11,1],[7,3],[4,8],[9,5],[6,10],[2,7],[8,3],[4,9],[10,5],[6,11]],
  12: [[1,2],[7,8],[4,5],[10,11],[2,3],[8,9],[5,6],[11,12],[3,1],[9,7],[6,4],[12,10],[2,5],[8,11],[1,4],[7,10],[5,3],[11,9],[1,6],[7,12],[4,2],[10,8],[3,6],[9,12],[5,1],[11,7],[3,4],[9,10],[6,2],[12,8],[1,7],[3,9],[10,4],[8,2],[5,11],[12,6],[1,8],[9,2],[3,10],[4,11],[12,5],[6,7],[9,1],[2,10],[11,3],[4,12],[7,5],[6,8],[10,1],[11,2],[12,3],[4,7],[8,5],[6,9],[11,1],[2,12],[7,3],[4,8],[9,5],[6,10],[12,1],[2,7],[8,3],[4,9],[10,5],[6,11]],
};

// Special bout order for pool of 6 when teammate PAIRS are present.
// Teammates placed at (1,4), (2,5), (3,6) — they fence each other in bouts 1,2,3.
const PAIRS_6 = [[1,4],[2,5],[3,6],[5,1],[4,2],[3,1],[6,2],[5,3],[6,4],[1,2],[3,4],[5,6],[2,3],[1,6],[4,5]];

// Special bout order for pool of 7 when a TRIO of teammates is present.
// Trio placed at positions 1-2-3.
const TRIO_7 = [[1,2],[4,5],[6,7],[3,1],[4,7],[2,3],[5,1],[6,2],[3,4],[7,5],[1,6],[4,2],[7,3],[5,6],[1,4],[2,7],[5,3],[6,4],[7,1],[2,5],[3,6]];

// Special bout order for pool of 6 when a QUARTET of 4 teammates is present.
// Quartet placed at positions 1-2-3-4.
const QUARTET_6 = [[3,1],[4,2],[1,4],[2,3],[5,6],[1,2],[3,4],[1,6],[2,5],[3,6],[4,5],[6,2],[5,1],[6,4],[5,3]];

// For pool of 6 with a trio (placed at 1-2-3): same as the standard order.
const TRIO_6 = STANDARD[6];

// ---------------------------------------------------------------------------
// Position assignment
//
// After serpentine seeding we have an unordered list of fencers in a pool.
// Here we assign position numbers 1..N so that teammates end up at "preferred"
// position slots, ensuring they face each other as early as possible per the
// FIE bout order tables.
//
// `separation` — ordered list of fencer fields to use as teammate criterion,
//   e.g. ['nationality', 'club'].  The first non-null matching field is used.
// ---------------------------------------------------------------------------

/**
 * Group fencers by their value for the first non-null separation field.
 * Returns a Map<value, fencer[]> (only groups with ≥2 members).
 */
function findTeammateGroups(fencers, separation) {
  for (const field of (separation || [])) {
    const groups = new Map();
    for (const f of fencers) {
      const key = f[field];
      if (key == null) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    // Only keep groups with ≥2 members
    for (const [k, v] of groups) if (v.length < 2) groups.delete(k);
    if (groups.size > 0) return groups;
  }
  return new Map();
}

/**
 * Assign positions 1..N to `fencers` within a pool.
 *
 * Strategy for pool sizes 6 and 7 (the main FIE cases):
 *   - Up to 3 pairs of teammates → place at preferred pair slots (1,4),(2,5),(3,6)
 *   - A trio grouped together → place at positions 1,2,3
 *   - Remaining fencers fill other slots in their serpentine order
 *
 * For all other pool sizes: keep current order (positions match serpentine).
 *
 * Returns an ordered array of fencers (index 0 = position 1).
 */
function assignPoolPositions(fencers, separation) {
  const n = fencers.length;
  const groups = findTeammateGroups(fencers, separation);

  // No teammates: keep current serpentine order
  if (groups.size === 0) return [...fencers];

  // Identify the max group size and collect pairs vs trios
  const pairs  = [];   // groups of exactly 2
  const trios  = [];   // groups of 3+
  for (const members of groups.values()) {
    if (members.length === 2) pairs.push(members);
    else                       trios.push(members);
  }

  const hasTrio  = trios.length > 0;
  const maxTrio  = hasTrio ? Math.max(...trios.map(t => t.length)) : 0;

  // Only do special positioning for pools of 6 and 7 (FIE standard cases)
  if (n !== 6 && n !== 7) return [...fencers];

  const positions = new Array(n).fill(null);
  const used      = new Set();   // fencer ids already placed

  if (hasTrio && maxTrio >= 3) {
    // Place the largest trio at positions 1, 2, 3 (0-indexed: 0, 1, 2)
    const trioMembers = [...trios].sort((a, b) => b.length - a.length)[0];
    trioMembers.slice(0, 3).forEach((f, i) => { positions[i] = f; used.add(f.id); });
    // Place remaining pairs at the next preferred pair slots
    const pairSlots = (n === 7) ? [[3,6],[4,5]] : [];  // pairs at (4,7),(5,6) for pool of 7 after trio at 1-2-3
    pairs.forEach((pair, pi) => {
      if (pi < pairSlots.length) {
        const [a, b] = pairSlots[pi];
        positions[a] = pair[0]; used.add(pair[0].id);
        positions[b] = pair[1]; used.add(pair[1].id);
      }
    });
  } else {
    // Pairs only: place at (1,4),(2,5),(3,6) — 0-indexed: (0,3),(1,4),(2,5)
    const pairSlots = [[0,3],[1,4],[2,5]];
    pairs.slice(0, 3).forEach((pair, pi) => {
      const [a, b] = pairSlots[pi];
      positions[a] = pair[0]; used.add(pair[0].id);
      positions[b] = pair[1]; used.add(pair[1].id);
    });
  }

  // Fill remaining slots with unused fencers in their original serpentine order
  const remaining = fencers.filter(f => !used.has(f.id));
  let ri = 0;
  for (let i = 0; i < n; i++) {
    if (positions[i] === null) positions[i] = remaining[ri++];
  }

  return positions;
}

/**
 * Select the correct bout order template given the assigned positions.
 * Returns an array of [left_pos, right_pos] 1-indexed pairs.
 */
function selectBoutOrder(n, fencers, separation) {
  const groups = findTeammateGroups(fencers, separation);

  if (groups.size === 0) return STANDARD[n] || fallbackOrder(n);

  const pairs = [...groups.values()].filter(g => g.length === 2);
  const trios = [...groups.values()].filter(g => g.length >= 3);

  if (n === 6) {
    if (trios.length > 0) {
      const maxSize = Math.max(...trios.map(t => t.length));
      return maxSize >= 4 ? QUARTET_6 : TRIO_6;
    }
    if (pairs.length > 0) return PAIRS_6;
    return STANDARD[6];
  }

  if (n === 7) {
    if (trios.length > 0) return TRIO_7;
    // Standard handles pairs (positions 1-4,2-5,3-6 fence first)
    return STANDARD[7];
  }

  return STANDARD[n] || fallbackOrder(n);
}

/**
 * Fallback: simple round-robin for pool sizes not in the FIE table.
 */
function fallbackOrder(n) {
  const bouts = [];
  for (let i = 1; i <= n; i++)
    for (let j = i + 1; j <= n; j++)
      bouts.push([i, j]);
  return bouts;
}

/**
 * Main entry point.
 *
 * @param {Array}  fencers    - pool fencers in serpentine order
 * @param {Array}  separation - ordered list of fields to use as teammate criterion
 *                              e.g. ['nationality', 'club']
 * @returns {Array}           - [{left: fencer, right: fencer}, ...] in FIE bout order
 */
function generateFIEBouts(fencers, separation) {
  const ordered  = assignPoolPositions(fencers, separation);
  const template = selectBoutOrder(fencers.length, ordered, separation);
  return template.map(([l, r]) => ({ left: ordered[l - 1], right: ordered[r - 1] }));
}

module.exports = { generateFIEBouts, assignPoolPositions, STANDARD };
