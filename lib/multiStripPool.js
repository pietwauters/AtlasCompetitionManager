'use strict';

// ---------------------------------------------------------------------------
// Multi-strip pool distribution
// See docs/multi-strip-pool-distribution.md for analysis and rationale.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Circle round-robin bout list for N fencers.
// For even N: N-1 rounds of N/2 perfect-matching bouts each.
// For odd N: adds a virtual bye; bouts involving the bye are omitted.
// Returns [[posA, posB], ...] (1-based position indices) in round order.
// ---------------------------------------------------------------------------
function generateRoundRobinBoutList(N) {
  const M = N % 2 === 0 ? N : N + 1; // work with even number
  const rot = Array.from({ length: M - 1 }, (_, i) => i + 1);
  const bouts = [];
  for (let r = 0; r < M - 1; r++) {
    const fixed = M;
    bouts.push([fixed, rot[0]]);
    for (let i = 1; i <= Math.floor((M - 2) / 2); i++) {
      bouts.push([rot[i], rot[M - 1 - i]]);
    }
    rot.push(rot.shift());
  }
  return N % 2 === 0 ? bouts : bouts.filter(([a, b]) => a <= N && b <= N);
}

// ---------------------------------------------------------------------------
// Extract waves from an ordered pair list.
// A wave is a maximal prefix of remaining pairs in which no token repeats.
// Returns an array of waves; each wave is an array of 0-based indices
// into `pairs`.
// ---------------------------------------------------------------------------
function extractWaveIndices(pairs) {
  const waves = [];
  let current = [], used = new Set();
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    if (used.has(a) || used.has(b)) {
      waves.push(current);
      current = [];
      used = new Set();
    }
    used.add(a);
    used.add(b);
    current.push(i);
  }
  if (current.length) waves.push(current);
  return waves;
}

// Same but returns the actual pairs rather than indices (used internally).
function extractWaves(pairs) {
  return extractWaveIndices(pairs).map(idxs => idxs.map(i => pairs[i]));
}

// ---------------------------------------------------------------------------
// Best-effort rest-fix at wave boundary.
// When a fencer appears in both the last time-slot of waveA and the first
// time-slot of waveB, they have zero planned rest.
// We try to swap the conflicted bout to an earlier slot in waveA (or a
// later slot in waveB), provided the swap doesn't introduce a within-wave
// fencer conflict.
// Operates on index arrays; modifies waveAIdxs and waveBIdxs in place.
// ---------------------------------------------------------------------------
function restFixBoundary(waveAIdxs, waveBIdxs, pairs, K) {
  const W = waveAIdxs.length;
  const lastSlot = Math.floor((W - 1) / K);
  const lastSlotStart = lastSlot * K; // first index position in last slot

  // Fencers in last slot of waveA
  const lastSlotFencers = new Set();
  for (let i = lastSlotStart; i < W; i++) {
    lastSlotFencers.add(pairs[waveAIdxs[i]][0]);
    lastSlotFencers.add(pairs[waveAIdxs[i]][1]);
  }
  // Fencers in first slot of waveB
  const nextFirstFencers = new Set();
  for (let i = 0; i < Math.min(K, waveBIdxs.length); i++) {
    nextFirstFencers.add(pairs[waveBIdxs[i]][0]);
    nextFirstFencers.add(pairs[waveBIdxs[i]][1]);
  }

  // Try to move conflicted bouts out of last slot of waveA
  for (let i = lastSlotStart; i < W; i++) {
    const [a, b] = pairs[waveAIdxs[i]];
    if (!nextFirstFencers.has(a) && !nextFirstFencers.has(b)) continue;
    // Swap with the first earlier bout whose fencers are not in nextFirstFencers
    for (let j = 0; j < lastSlotStart; j++) {
      const [c, d] = pairs[waveAIdxs[j]];
      if (!nextFirstFencers.has(c) && !nextFirstFencers.has(d)) {
        [waveAIdxs[i], waveAIdxs[j]] = [waveAIdxs[j], waveAIdxs[i]];
        break;
      }
    }
  }

  // Try to move conflicted bouts out of first slot of waveB
  const wbLastStart = Math.floor((waveBIdxs.length - 1) / K) * K;
  for (let i = 0; i < Math.min(K, waveBIdxs.length); i++) {
    const [a, b] = pairs[waveBIdxs[i]];
    if (!lastSlotFencers.has(a) && !lastSlotFencers.has(b)) continue;
    for (let j = wbLastStart; j < waveBIdxs.length; j++) {
      const [c, d] = pairs[waveBIdxs[j]];
      if (!lastSlotFencers.has(c) && !lastSlotFencers.has(d)) {
        [waveBIdxs[i], waveBIdxs[j]] = [waveBIdxs[j], waveBIdxs[i]];
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main distribution function.
//
// @param  {Array}  pairs  [[a, b], ...]  ordered pair list (any token type)
// @param  {number} K      number of strips (≥ 1)
// @returns {object}
//   strips:  K arrays of 0-based indices into `pairs` (per-strip bout order)
//   flags:   zero-rest warnings [{ token, waveIdx }]
// ---------------------------------------------------------------------------
function distributeBoutsToStrips(pairs, K) {
  if (K <= 1) {
    return { strips: [pairs.map((_, i) => i)], flags: [] };
  }

  const waveIdxArrays = extractWaveIndices(pairs);

  // Apply rest-fix at each wave boundary.
  for (let wi = 0; wi < waveIdxArrays.length - 1; wi++) {
    restFixBoundary(waveIdxArrays[wi], waveIdxArrays[wi + 1], pairs, K);
  }

  // Assign bouts to strips with alternating start for uneven waves (balancing).
  // Tracks how many bouts have gone to each strip so far to choose the start.
  const stripCounts = new Array(K).fill(0);
  const stripIdxs = Array.from({ length: K }, () => []);

  for (const waveIdxs of waveIdxArrays) {
    // Choose starting strip: the one with fewest bouts so far.
    const startStrip = stripCounts.indexOf(Math.min(...stripCounts));
    waveIdxs.forEach((boutIdx, i) => {
      const strip = (startStrip + i) % K;
      stripIdxs[strip].push(boutIdx);
      stripCounts[strip]++;
    });
  }

  // Detect zero-rest flags using global time slot model.
  // Global slot of a bout = cumulative slots before its wave + floor(pos_in_wave / K).
  const boutSlot = new Map(); // pairIdx → globalSlot
  let slotBase = 0;
  for (const waveIdxs of waveIdxArrays) {
    waveIdxs.forEach((boutIdx, pos) => {
      boutSlot.set(boutIdx, slotBase + Math.floor(pos / K));
    });
    slotBase += Math.ceil(waveIdxs.length / K);
  }

  const lastSeen = new Map(); // token → { slot, boutIdx }
  const flags = [];
  // Walk in global slot order.
  const sorted = [...boutSlot.entries()].sort((a, b) => a[1] - b[1]);
  for (const [boutIdx, slot] of sorted) {
    for (const token of pairs[boutIdx]) {
      const prev = lastSeen.get(token);
      if (prev && slot - prev.slot <= 1) {
        flags.push({ token, prevBoutIdx: prev.boutIdx, nextBoutIdx: boutIdx, gapSlots: slot - prev.slot - 1 });
      }
      lastSeen.set(token, { slot, boutIdx });
    }
  }

  return { strips: stripIdxs, flags };
}

module.exports = {
  generateRoundRobinBoutList,
  extractWaves,
  distributeBoutsToStrips,
};
