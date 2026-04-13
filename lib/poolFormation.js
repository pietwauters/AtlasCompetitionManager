'use strict';

const { generateFIEBouts } = require('./boutOrder');

// ---------------------------------------------------------------------------
// Pool size calculation
// ---------------------------------------------------------------------------

/**
 * Find all ways to express N as a sum of terms chosen from `sizes`.
 * `sizes` must be sorted descending (e.g. [7, 6, 5]).
 * Returns array of solutions; each solution is a sorted-desc array of the
 * individual pool sizes, e.g. [[7,7,6], [7,6,6,6]].
 */
function findAllSolutions(N, sizes) {
  const results = [];
  function recurse(remaining, idx, current) {
    if (remaining === 0) { results.push([...current]); return; }
    if (idx >= sizes.length) return;
    const s = sizes[idx];
    for (let count = Math.floor(remaining / s); count >= 0; count--) {
      recurse(remaining - count * s, idx + 1, current.concat(Array(count).fill(s)));
    }
  }
  recurse(N, 0, []);
  return results;
}

/**
 * Max − min pool size (0 if all pools are the same size).
 * Solutions are stored sorted descending, so this is solution[0] − solution[last].
 */
function spread(solution) {
  if (solution.length <= 1) return 0;
  return solution[0] - solution[solution.length - 1];
}

/**
 * Calculate the pool size options for N fencers.
 *
 * Returns an array of options, each option being a sorted-desc array of pool
 * sizes (e.g. [7, 7, 6]).
 *   length === 1  → only one valid configuration, use it automatically
 *   length  >  1  → multiple equally valid configurations, present them to the
 *                   user and let them choose
 *
 * Algorithm (FIE-aligned):
 *   1. N divisible by allowedSizes[0] (top size, usually 7)
 *      → single option: all pools of that size.
 *   2. N divisible by allowedSizes[1] (second size, usually 6)
 *      → single option: all pools of that size.
 *   3. Otherwise, find all solutions using only the top-2 sizes.
 *      If any exist, return them all (user picks when >1).
 *   4. If no top-2 solution, fall back to all allowedSizes and keep only
 *      the solutions with minimum spread (most equal pool sizes).
 *   5. Additionally, if N ≤ singlePoolMaxN, always include the
 *      single-pool-of-N option so the organiser can choose it.
 *
 * @param {number} N
 * @param {{ allowedSizes: number[], singlePoolMaxN?: number }} config
 * @returns {Array<Array<number>>}
 */
function calcPoolOptions(N, { allowedSizes, singlePoolMaxN = 10 }) {
  if (!allowedSizes || !allowedSizes.length) throw new Error('allowedSizes must be a non-empty array.');
  if (N < 2) throw new Error('Not enough fencers for a pool phase.');

  const sizes = [...allowedSizes].sort((a, b) => b - a);   // descending
  const [top, second] = sizes;
  let options = [];

  // Steps 1 & 2 — clean equal-size solutions
  if (top && N % top === 0) {
    options = [Array(N / top).fill(top)];
  } else if (second && N % second === 0) {
    options = [Array(N / second).fill(second)];
  } else {
    // Step 3 — try with only the top-2 sizes
    const primarySols = sizes.length >= 2 ? findAllSolutions(N, sizes.slice(0, 2)) : [];
    if (primarySols.length > 0) {
      options = primarySols;
    } else {
      // Step 4 — fall back to all allowed sizes, keep min-spread solutions
      const allSols = findAllSolutions(N, sizes);
      if (allSols.length > 0) {
        const minSpread = Math.min(...allSols.map(spread));
        options = allSols.filter(s => spread(s) === minSpread);
      }
    }
  }

  // Step 5 — single-pool option for small competitions
  if (N <= singlePoolMaxN) {
    const alreadyPresent = options.some(o => o.length === 1 && o[0] === N);
    if (!alreadyPresent) options.push([N]);
  }

  if (options.length === 0) {
    throw new Error(`Cannot form valid pools for ${N} fencers with allowed sizes [${sizes.join(', ')}].`);
  }

  return options;
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
 * Return the first conflicting pair [a, b] in pool that share a value for any
 * of the given separation fields, or null if no conflict.
 */
function findConflict(pool, separation) {
  for (const field of (separation || [])) {
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const vi = pool[i][field];
        const vj = pool[j][field];
        if (vi && vj && vi === vj) return [pool[i], pool[j]];
      }
    }
  }
  return null;
}

/**
 * Best-effort separation across pools.
 * Tries to swap fencers between pools to eliminate same-group pairs
 * (nationality first, then club, depending on `separation` field order).
 * Only swaps when both pools keep the same size and neither swap creates a new conflict.
 */
function applySeparation(pools, separation) {
  if (!separation || !separation.length) return pools;
  let improved = true;
  let passes   = 0;
  while (improved && passes < 20) {
    improved = false;
    passes++;
    outer:
    for (let pi = 0; pi < pools.length; pi++) {
      const conflict = findConflict(pools[pi], separation);
      if (!conflict) continue;
      const mover = conflict[0];
      for (let pj = 0; pj < pools.length; pj++) {
        if (pj === pi) continue;
        if (pools[pj].length !== pools[pi].length) continue;
        for (let k = 0; k < pools[pj].length; k++) {
          const swap  = pools[pj][k];
          const newPi = pools[pi].map(f => (f === mover ? swap  : f));
          const newPj = pools[pj].map(f => (f === swap  ? mover : f));
          if (!findConflict(newPi, separation) && !findConflict(newPj, separation)) {
            pools[pi] = newPi;
            pools[pj] = newPj;
            improved  = true;
            break outer;
          }
        }
      }
    }
  }
  return pools;
}

/**
 * Main entry point.
 *
 * @param {Array}  fencers      - [{id, name, club, nationality, initial_seed}, ...]
 * @param {Array}  chosenSizes  - sorted-desc pool sizes chosen for this phase, e.g. [7, 7, 6]
 * @param {Object} ruleConfig   - the poolFormation object from the rule JSON
 * @returns {Array}             - [{poolNumber, fencers, bouts}, ...]
 */
function formPools(fencers, chosenSizes, ruleConfig) {
  if (!fencers.length) throw new Error('No fencers to assign to pools.');

  const numPools = chosenSizes.length;

  // Sort by initial_seed ASC; unseeded fencers go last
  const sorted = [...fencers].sort((a, b) => {
    const sa = a.initial_seed ?? 99999;
    const sb = b.initial_seed ?? 99999;
    return sa - sb;
  });

  // Serpentine naturally distributes ceil/floor, matching chosenSizes (spread ≤ 1)
  let pools = serpentineAssign(sorted, numPools);

  const separation = ruleConfig.separation || [];
  pools = applySeparation(pools, separation);

  return pools.map((poolFencers, idx) => ({
    poolNumber: idx + 1,
    fencers:    poolFencers,
    bouts:      generateFIEBouts(poolFencers, separation),
  }));
}

module.exports = { formPools, calcPoolOptions, serpentineAssign };
