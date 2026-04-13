'use strict';

/**
 * Calculate pool sizes for N fencers.
 * Returns an array of integers: [6, 6, 5] means three pools of sizes 6, 6, 5.
 * Respects min/max/preferred from the rule config.
 */
function calcPoolSizes(n, { minFencersPerPool: min, maxFencersPerPool: max, preferredSize: pref }) {
  if (n < min) {
    throw new Error(`Need at least ${min} fencers for a pool phase; only ${n} registered.`);
  }

  // Start from an ideal number of pools
  let numPools = Math.max(1, Math.round(n / pref));

  // Shrink if any pool would be too small
  while (numPools > 1 && Math.floor(n / numPools) < min) numPools--;

  // Grow if any pool would be too large
  while (Math.ceil(n / numPools) > max) numPools++;

  if (Math.floor(n / numPools) < min || Math.ceil(n / numPools) > max) {
    throw new Error(`Cannot form valid pools for ${n} fencers (min=${min}, max=${max}).`);
  }

  const base  = Math.floor(n / numPools);
  const extra = n % numPools;   // first `extra` pools get base+1
  return Array.from({ length: numPools }, (_, i) => (i < extra ? base + 1 : base));
}

/**
 * Serpentine seeding: distribute seeded fencers across pools in snake order.
 * Fencers must be sorted by seed (ascending) before calling.
 * Returns pools[i] = [fencer, ...].
 *
 * Pattern for 4 pools:
 *   Pass 0 (→): fencer[0]→pool0, fencer[1]→pool1, fencer[2]→pool2, fencer[3]→pool3
 *   Pass 1 (←): fencer[4]→pool3, fencer[5]→pool2, fencer[6]→pool1, fencer[7]→pool0
 *   Pass 2 (→): fencer[8]→pool0, ...
 */
function serpentineAssign(fencers, numPools) {
  const pools = Array.from({ length: numPools }, () => []);
  for (let i = 0; i < fencers.length; i++) {
    const pass    = Math.floor(i / numPools);
    const pos     = i % numPools;
    const poolIdx = (pass % 2 === 0) ? pos : (numPools - 1 - pos);
    pools[poolIdx].push(fencers[i]);
  }
  return pools;
}

/**
 * Return the first pair [a, b] in pool that share a non-null club, or null.
 */
function findClubConflict(pool) {
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      if (pool[i].club && pool[j].club && pool[i].club === pool[j].club) {
        return [pool[i], pool[j]];
      }
    }
  }
  return null;
}

/**
 * Best-effort club separation.
 * After serpentine assignment, try to swap fencers between pools to eliminate
 * same-club pairs.  Only swaps when both pools stay the same size and neither
 * swap target creates a new conflict.
 */
function applyClubSeparation(pools) {
  let improved = true;
  let passes   = 0;
  while (improved && passes < 20) {
    improved = false;
    passes++;
    outer:
    for (let pi = 0; pi < pools.length; pi++) {
      const conflict = findClubConflict(pools[pi]);
      if (!conflict) continue;
      const mover = conflict[0];   // candidate to move out of pool pi
      for (let pj = 0; pj < pools.length; pj++) {
        if (pj === pi) continue;
        if (pools[pj].length !== pools[pi].length) continue;  // keep sizes equal
        for (let k = 0; k < pools[pj].length; k++) {
          const swap = pools[pj][k];
          const newPi = pools[pi].map(f => (f === mover ? swap : f));
          const newPj = pools[pj].map(f => (f === swap  ? mover : f));
          if (!findClubConflict(newPi) && !findClubConflict(newPj)) {
            pools[pi] = newPi;
            pools[pj] = newPj;
            improved = true;
            break outer;
          }
        }
      }
    }
  }
  return pools;
}

/**
 * Generate all round-robin bouts for a single pool.
 * Returns [{left: fencer, right: fencer}, ...].
 */
function generateBouts(pool) {
  const bouts = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      bouts.push({ left: pool[i], right: pool[j] });
    }
  }
  return bouts;
}

/**
 * Main entry point.
 *
 * @param {Array}  fencers - [{id, name, club, nationality, initial_seed}, ...]
 * @param {Object} rules   - the poolFormation object from the rule JSON
 * @returns {Array}        - [{poolNumber, fencers, bouts}, ...]
 */
function formPools(fencers, rules) {
  if (!fencers.length) throw new Error('No fencers to assign to pools.');

  // Sort by initial_seed ASC; treat null/undefined as high number (unseeded fencer goes last)
  const sorted = [...fencers].sort((a, b) => {
    const sa = a.initial_seed ?? 99999;
    const sb = b.initial_seed ?? 99999;
    return sa - sb;
  });

  const poolSizes = calcPoolSizes(sorted.length, rules);
  let pools = serpentineAssign(sorted, poolSizes.length);

  if (rules.clubSeparation) {
    pools = applyClubSeparation(pools);
  }

  return pools.map((poolFencers, idx) => ({
    poolNumber: idx + 1,
    fencers:    poolFencers,
    bouts:      generateBouts(poolFencers),
  }));
}

module.exports = { formPools, calcPoolSizes, serpentineAssign };
