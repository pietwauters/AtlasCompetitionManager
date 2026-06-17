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

  // Step 1 — collect ALL uniform (equal-size) solutions within allowedSizes.
  // Never stop at the first one: if N is divisible by multiple allowed sizes,
  // the organiser must be able to choose (e.g. 42 → 6×7 OR 7×6).
  const uniform = sizes.filter(sz => N % sz === 0).map(sz => Array(N / sz).fill(sz));

  // Step 2 — mixed solutions using only the top-2 sizes (spread ≤ 1).
  // Exclude any that are already covered by a uniform option.
  const uniformKeys = new Set(uniform.map(o => JSON.stringify(o)));
  const mixed = sizes.length >= 2
    ? findAllSolutions(N, sizes.slice(0, 2)).filter(sol => !uniformKeys.has(JSON.stringify(sol)))
    : [];

  let options = [...uniform, ...mixed];

  // Step 3 — if still nothing (can happen with unusual sizes), fall back to
  // all allowed sizes keeping only min-spread solutions.
  if (options.length === 0) {
    const allSols = findAllSolutions(N, sizes);
    if (allSols.length > 0) {
      const minSpread = Math.min(...allSols.map(spread));
      options = allSols.filter(s => spread(s) === minSpread);
    }
  }

  // Step 4 — single-pool option for small competitions.
  if (N <= singlePoolMaxN && !options.some(o => o.length === 1 && o[0] === N)) {
    options.push([N]);
  }

  if (options.length === 0) {
    throw new Error(`Cannot form valid pools for ${N} fencers with allowed sizes [${sizes.join(', ')}].`);
  }

  // Sort: uniform (spread 0) before mixed, then by ascending pool count.
  options.sort((a, b) => spread(a) - spread(b) || a.length - b.length);

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
 * Serpentine seeding with inline FIE nationality/club separation (FIE t.38).
 *
 * At each serpentine slot, the first fencer in the remaining queue who does
 * not conflict with the pool's current members is placed there.  Skipped
 * fencers stay in the queue in their original relative order and are tried
 * again at the very next slot.  If no fencer fits (all remaining share a
 * value with the pool), the first fencer is placed anyway — the spec says
 * "he must remain in the original pool".
 *
 * This produces a single deterministic result that matches Engarde / FIE
 * software exactly.
 */
function serpentineAssignWithSeparation(fencers, numPools, separation) {
  const pools = Array.from({ length: numPools }, () => []);
  const queue = [...fencers];
  let forward = true;
  let pos     = 0;

  while (queue.length > 0) {
    const poolIdx = forward ? pos : (numPools - 1 - pos);
    const pool    = pools[poolIdx];

    let placed = -1;
    if (separation && separation.length) {
      for (let i = 0; i < queue.length; i++) {
        const f = queue[i];
        let conflict = false;
        for (const field of separation) {
          if (f[field] && pool.some(p => p[field] === f[field])) { conflict = true; break; }
        }
        if (!conflict) { placed = i; break; }
      }
    } else {
      placed = 0;
    }

    // No fit possible → place first fencer (spec: "remain in the original pool").
    if (placed === -1) placed = 0;

    pool.push(queue.splice(placed, 1)[0]);

    pos++;
    if (pos === numPools) { pos = 0; forward = !forward; }
  }

  return pools;
}

/**
 * Block seeding: assign fencers to pools in blocks of N (e.g., 6).
 * Fencers must be sorted by seed (ascending) before calling.
 * Returns pools[i] = [fencer, ...].
 *
 * Example: blockSize = 6, 18 fencers → 3 pools of 6, first 6 to pool 1, next 6 to pool 2, etc.
 */
function blockAssign(fencers, blockSize) {
  const pools = [];
  for (let i = 0; i < fencers.length; i += blockSize) {
    pools.push(fencers.slice(i, i + blockSize));
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

// Count conflicting pairs in a pool.
function conflictCount(pool, separation) {
  let count = 0;
  for (const field of (separation || [])) {
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const vi = pool[i][field];
        const vj = pool[j][field];
        if (vi && vj && vi === vj) count++;
      }
    }
  }
  return count;
}

/**
 * Best-effort separation across pools.
 * Swaps fencers between same-size pools to eliminate same-group pairs
 * (nationality first, then club, depending on `separation` field order).
 *
 * A swap is accepted whenever it strictly reduces the total number of
 * conflicting pairs across the two pools involved. This handles pools that
 * have more than one nationality conflict simultaneously, where a single swap
 * can only fix one conflict at a time.
 *
 * The worse-seeded fencer in each conflict pair (conflict[1]) is tried first
 * so that top seeds are displaced as little as possible.
 */
function applySeparation(pools, separation) {
  if (!separation || !separation.length) return pools;
  let improved = true;
  let passes   = 0;
  while (improved && passes < 50) {
    improved = false;
    passes++;
    outer:
    for (let pi = 0; pi < pools.length; pi++) {
      const conflict = findConflict(pools[pi], separation);
      if (!conflict) continue;
      const before = conflictCount(pools[pi], separation);
      // Try moving conflict[1] (worse seed) first, then conflict[0].
      for (const mover of [conflict[1], conflict[0]]) {
        for (let pj = 0; pj < pools.length; pj++) {
          if (pj === pi) continue;
          if (pools[pj].length !== pools[pi].length) continue;
          const beforePj = conflictCount(pools[pj], separation);
          for (let k = 0; k < pools[pj].length; k++) {
            const swap  = pools[pj][k];
            const newPi = pools[pi].map(f => (f === mover ? swap  : f));
            const newPj = pools[pj].map(f => (f === swap  ? mover : f));
            const afterPi = conflictCount(newPi, separation);
            const afterPj = conflictCount(newPj, separation);
            if (afterPi + afterPj < before + beforePj) {
              pools[pi] = newPi;
              pools[pj] = newPj;
              improved  = true;
              break outer;
            }
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

  const separation = ruleConfig.separation || [];
  let pools;

  if (ruleConfig.algorithm === 'block-seeding') {
    const blockSize = ruleConfig.blockSize || chosenSizes[chosenSizes.length - 1];
    pools = blockAssign(sorted, blockSize);
    pools = applySeparation(pools, separation);
  } else {
    pools = serpentineAssignWithSeparation(sorted, numPools, separation);
  }

  return pools.map((poolFencers, idx) => ({
    poolNumber: idx + 1,
    fencers:    poolFencers,
    bouts:      generateFIEBouts(poolFencers, separation),
  }));
}

/**
 * For block-seeding, return options if N is not divisible by blockSize.
 * Returns: { type: 'ok', pools } | { type: 'options', drop: [...], redistribute: [[sizes]] }
 */
function blockSeedingOptions(fencers, blockSize) {
  const N = fencers.length;
  const remainder = N % blockSize;
  if (remainder === 0) {
    // Clean division
    return { type: 'ok', pools: blockAssign(fencers, blockSize) };
  }
  // Option 1: Drop lowest ranked
  const drop = fencers.slice(-remainder).map(f => f.id);
  // Option 2: Redistribute remainder over last pools (make last pools +1)
  const numPools = Math.floor(N / blockSize);
  const base = blockSize;
  const sizes = Array(numPools).fill(base);
  for (let i = 0; i < remainder; ++i) sizes[numPools - 1 - i]++;
  // Only valid if no pool exceeds blockSize+1
  if (sizes[0] > blockSize + 1) {
    // Not possible to redistribute
    return { type: 'options', drop, redistribute: null };
  }
  // Compute pool indices for redistribution
  let idx = 0;
  const pools = sizes.map(sz => {
    const group = fencers.slice(idx, idx + sz);
    idx += sz;
    return group;
  });
  return { type: 'options', drop, redistribute: sizes };
}

module.exports = { formPools, calcPoolOptions, serpentineAssign, serpentineAssignWithSeparation, blockAssign, blockSeedingOptions };
