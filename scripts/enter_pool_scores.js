'use strict';
// Enter pool scores from the real competition data into Atlas.
// Each pool entry: array of fencer last names in FencingTime position order,
// followed by the score matrix. Matrix[i][j] = touches scored by fencer i
// against fencer j (null on diagonal). Winner determined by V/D prefix.
// V = victory (fencer i won), D = defeat (fencer i lost).

const db   = require('../db');
const Bout = require('../services/bouts');

const PHASE_ID = 34; // pool phase for competition 11 (womens sabre)

// Parse "V5" → {score:5, won:true}, "D3" → {score:3, won:false}
function parse(cell) {
  if (!cell) return null;
  return { score: parseInt(cell.slice(1), 10), won: cell[0] === 'V' };
}

// Pool data: each pool is { fencers: [lastNames], rows: [rowStrings] }
// Rows are given in FencingTime display order (position 1..n).
// Each row string has n entries separated by spaces; '-' = self.
const POOLS = [
  // Pool 1 – 7 fencers
  {
    fencers: ['CHART','EGORIAN','APITHY','BUITENHUIS','EIFLER','BONDAR','CORTEYN'],
    matrix: [
      [null,'D1','D1','D4','D4','D3','D4'],
      ['V5',null,'V5','V5','V5','V5','V5'],
      ['V5','D4',null,'V5','V5','D2','V5'],
      ['V5','D3','D4',null,'D1','D2','V5'],
      ['V5','D4','D1','V5',null,'D4','V5'],
      ['V5','D4','V5','V5','V5',null,'V5'],
      ['V5','D1','D3','D1','D3','D3',null],
    ],
  },
  // Pool 2 – 7 fencers
  {
    fencers: ['SZUCS','PEREZ CUENCA','ILIEVA','NIKITINA','KOROTCHENKO','SEZILLE','FUNKE'],
    matrix: [
      [null,'V5','V5','V5','V5','V5','V5'],
      ['D4',null,'D2','V5','V5','V5','V5'],
      ['D3','V5',null,'V5','V5','V5','V5'],
      ['D1','D1','D4',null,'V5','V5','D3'],
      ['D4','D2','D3','D4',null,'V5','D2'],
      ['D0','D0','D3','D1','D3',null,'D4'],
      ['D0','D2','D1','V5','V5','V5',null],
    ],
  },
  // Pool 3 – 7 fencers
  {
    fencers: ['HNIDASHEVA','MIKHAILOVA A','GKOUNTOURA','SPIESZ','DUMITRU','STEMPER','NOUTCHA'],
    matrix: [
      [null,'D3','V5','D1','V5','D1','D2'],
      ['V5',null,'V5','V5','V5','V5','D3'],
      ['D2','D1',null,'D2','D1','D3','D2'],
      ['V5','D4','V5',null,'V5','V5','V5'],
      ['D3','D0','V5','D3',null,'D0','D2'],
      ['V5','D4','V5','D3','V5',null,'D1'],
      ['V5','V5','V5','D4','V5','V5',null],
    ],
  },
  // Pool 4 – 7 fencers
  {
    fencers: ['VASILEVA','BATTAI','LUNDGREEN','MAXWELL','HUSEYNOVA','SPICA','GEORGIADOU'],
    matrix: [
      [null,'D1','V5','D4','V5','D4','D1'],
      ['V5',null,'V5','V5','V5','V5','D2'],
      ['D1','D1',null,'D1','D0','D0','D0'],
      ['V5','D3','V5',null,'V5','D4','D0'],
      ['D4','D4','V5','D4',null,'V5','D1'],
      ['V5','D4','V5','V5','D3',null,'V5'],
      ['V5','V5','V5','V5','V5','D2',null],
    ],
  },
  // Pool 5 – 7 fencers
  {
    fencers: ['LYTINA','KOMASHCHUK','KARIMOVA','FUSEA','ERBIL','ROTILI','D-SALLOWS'],
    matrix: [
      [null,'D2','D0','D2','D1','D4','D1'],
      ['V5',null,'V5','D4','V5','D2','V5'],
      ['V5','D4',null,'V5','D4','D3','V5'],
      ['V5','V5','D2',null,'D1','D2','V5'],
      ['V5','D3','V5','V5',null,'V5','V5'],
      ['V5','V5','V5','V5','D1',null,'V5'],
      ['V5','D0','D1','D4','D2','D2',null],
    ],
  },
  // Pool 6 – 6 fencers
  {
    fencers: ['TORI','SOBAL','KASPIAROVICH','WIECKIEWICZ','BATTISTON','LUPU'],
    matrix: [
      [null,'V5','D4','V5','D4','D2'],
      ['D2',null,'D3','D1','V5','D3'],
      ['V5','V5',null,'V5','V5','D2'],
      ['D0','V5','D2',null,'V5','V5'],
      ['V5','D4','D1','D4',null,'V5'],
      ['V5','V5','V5','D2','D1',null],
    ],
  },
  // Pool 7 – 6 fencers
  {
    fencers: ['BASHTA','HERNANDEZ','VIALE','WATOR','MIKHAILOVA AL','KOUROUSI'],
    matrix: [
      [null,'D4','D1','V5','D3','D1'],
      ['V5',null,'D3','D3','D3','V5'],
      ['V5','V5',null,'V5','D1','V5'],
      ['D3','V5','D2',null,'D4','D3'],
      ['V5','V5','V5','V5',null,'D3'],
      ['V5','D0','D4','V5','V5',null],
    ],
  },
  // Pool 8 – 6 fencers
  {
    fencers: ['BALZER','NAVARRO','NEIKOVA','CIESLAR J','PUSZTAI','TANZMEISTER'],
    matrix: [
      [null,'V5','V5','V5','V5','V5'],
      ['D3',null,'D1','D4','V5','V5'],
      ['D2','V5',null,'D0','D3','V5'],
      ['D4','V5','V5',null,'D4','V5'],
      ['D2','D4','V5','V5',null,'V5'],
      ['D4','D2','D2','D1','D0',null],
    ],
  },
  // Pool 9 – 6 fencers
  {
    fencers: ['KUVAEVA','RAHACHEUSKAYA','GUNGOR','MARTIN-PORTUGUES','HERBON','CIESLAR Z'],
    matrix: [
      [null,'V5','D3','V5','V5','D3'],
      ['D3',null,'D4','D3','V5','D3'],
      ['V5','V5',null,'D3','V5','V5'],
      ['D4','V5','V5',null,'V5','D2'],
      ['D4','D3','D1','D4',null,'D3'],
      ['V5','V5','D3','V5','V5',null],
    ],
  },
];

// Build a lookup: last_name (upper) → competitor_id for competition 11
const competitorsByName = {};
db.prepare(`
  SELECT id, last_name FROM competitors WHERE competition_id = 11
`).all().forEach(c => {
  competitorsByName[c.last_name.trim().toUpperCase()] = c.id;
});

// Resolve a FencingTime name to a competitor_id (partial match on last_name)
function resolve(name) {
  const key = name.trim().toUpperCase();
  if (competitorsByName[key]) return competitorsByName[key];
  // Try prefix match (handles "MIKHAILOVA A" vs "MIKHAILOVA" etc.)
  const match = Object.keys(competitorsByName).find(k => k.startsWith(key) || key.startsWith(k));
  if (match) return competitorsByName[match];
  throw new Error(`Cannot find competitor: "${name}"`);
}

// For a pool_id, build a map: (left_id, right_id) → bout_id
function buildBoutMap(poolId) {
  const bouts = db.prepare(`
    SELECT id, left_id, right_id FROM bouts WHERE pool_id = ?
  `).all(poolId);
  const map = {};
  bouts.forEach(b => {
    map[`${b.left_id}:${b.right_id}`] = b.id;
    map[`${b.right_id}:${b.left_id}`] = b.id; // reverse lookup
  });
  return { map, bouts };
}

// Find pool_id for a given phase where the pool's fencers match the given set of competitor IDs
function findAtlasPool(phaseId, competitorIdSet) {
  const pools = db.prepare(`SELECT DISTINCT pool_id FROM bouts WHERE pool_id IN (SELECT id FROM pools WHERE phase_id = ?)`).all(phaseId);
  for (const { pool_id } of pools) {
    const members = new Set(
      db.prepare('SELECT left_id AS id FROM bouts WHERE pool_id = ? UNION SELECT right_id FROM bouts WHERE pool_id = ?')
        .all(pool_id, pool_id).map(r => r.id)
    );
    if ([...competitorIdSet].every(id => members.has(id)) && members.size === competitorIdSet.size) {
      return pool_id;
    }
  }
  return null;
}

let totalUpdated = 0, errors = [];

for (let pi = 0; pi < POOLS.length; pi++) {
  const pool = POOLS[pi];
  const n = pool.fencers.length;

  // Resolve fencer names to competitor IDs
  let ids;
  try {
    ids = pool.fencers.map(resolve);
  } catch (e) {
    errors.push(`Pool ${pi+1}: ${e.message}`);
    continue;
  }

  // Find the Atlas pool that contains exactly these competitors
  const idSet = new Set(ids);
  const poolId = findAtlasPool(PHASE_ID, idSet);
  if (!poolId) {
    errors.push(`Pool ${pi+1}: no matching Atlas pool found`);
    continue;
  }

  const { map } = buildBoutMap(poolId);

  // Enter scores for each pair (i < j)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const cellI = pool.matrix[i][j]; // fencer i vs fencer j
      const cellJ = pool.matrix[j][i]; // fencer j vs fencer i
      if (!cellI || !cellJ) continue;

      const rI = parse(cellI);
      const rJ = parse(cellJ);

      const boutId = map[`${ids[i]}:${ids[j]}`];
      if (!boutId) {
        errors.push(`Pool ${pi+1}: no bout found for ${pool.fencers[i]} vs ${pool.fencers[j]}`);
        continue;
      }

      // Determine left/right scores based on how Atlas stored the bout
      const bout = db.prepare('SELECT left_id, right_id FROM bouts WHERE id = ?').get(boutId);
      let leftScore, rightScore;
      if (bout.left_id === ids[i]) {
        leftScore = rI.score; rightScore = rJ.score;
      } else {
        leftScore = rJ.score; rightScore = rI.score;
      }

      Bout.updateScore(boutId, leftScore, rightScore);
      totalUpdated++;
    }
  }

  console.log(`Pool ${pi+1} (id=${poolId}): ${n*(n-1)/2} bouts entered`);
}

console.log(`\nTotal bouts updated: ${totalUpdated}`);
if (errors.length) {
  console.error('\nErrors:');
  errors.forEach(e => console.error(' ', e));
} else {
  console.log('No errors.');
}
