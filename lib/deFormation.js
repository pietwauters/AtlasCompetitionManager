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
// Property: if every higher seed wins every bout, seeds 1 and 2 meet only in
// the final, seeds 1-4 only in the semi-finals, etc.
function buildSeedPositions(T) {
  let slots = [1, 2];
  while (slots.length < T) {
    const size = slots.length * 2;
    const next = [];
    for (const s of slots) {
      next.push(s, size + 1 - s);
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
