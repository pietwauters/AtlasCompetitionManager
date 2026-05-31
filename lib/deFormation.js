'use strict';

// Smallest power of 2 that is >= n.
function getTableauSize(n) {
  if (n <= 2) return 2;
  let T = 2;
  while (T < n) T *= 2;
  return T;
}

// Returns an array of length T where each element is the seed rank (1-indexed)
// assigned to that tableau slot. Consecutive pairs are R1 bouts:
//   slots[0] vs slots[1], slots[2] vs slots[3], …
// Properties:
//   - Seed 1 is at slot 0 (position 1), seed 2 is at slot T-1 (position T).
//   - If every higher seed wins, seeds 1 and 2 meet only in the final,
//     seeds 2 and 3 meet only in the semi-final, etc.
// Algorithm: at each doubling, odd-indexed slots expand as [s, T+1-s]
// and even-indexed slots expand as [T+1-s, s], keeping seed 2 anchored
// at the last slot through every level.
function buildSeedPositions(T) {
  let slots = [1, 2];
  let cur = 2;
  while (cur < T) {
    cur *= 2;
    const next = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (i % 2 === 0) next.push(s, cur + 1 - s);   // odd position: seed first
      else             next.push(cur + 1 - s, s);    // even position: seed last
    }
    slots = next;
  }
  return slots;
}

// Build the DE structure from a ranked competitors array (index 0 = best rank).
// Returns:
//   tableauSize  – power-of-2 size of the bracket
//   byeCount     – number of top seeds that get a first-round bye
//   totalRounds  – log2(tableauSize)
//   r1Bouts      – array of R1 bout descriptors:
//                  { left, right, tableauPosition }
//                  left/right are competitor objects or null (bye slot)
function buildDE(competitors) {
  const N = competitors.length;
  if (N < 2) throw Object.assign(new Error('Need at least 2 competitors for DE.'), { status: 400 });

  const T       = getTableauSize(N);
  const byeCount = T - N;

  const seedSlots = buildSeedPositions(T);

  // Map seed rank → competitor (seeds beyond N are null = bye slot)
  const bySeed = {};
  for (let i = 0; i < N; i++) {
    bySeed[i + 1] = competitors[i];
  }

  const r1Bouts = [];
  for (let i = 0; i < T; i += 2) {
    r1Bouts.push({
      left:            bySeed[seedSlots[i]]     || null,
      right:           bySeed[seedSlots[i + 1]] || null,
      tableauPosition: i / 2 + 1,
      leftSeed:        seedSlots[i],
      rightSeed:       seedSlots[i + 1],
    });
  }

  return { tableauSize: T, byeCount, totalRounds: Math.log2(T), r1Bouts };
}

module.exports = { getTableauSize, buildSeedPositions, buildDE };
