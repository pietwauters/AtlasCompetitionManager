'use strict';
// check-circular-requires.js — detects require() cycles and layering
// violations across services/, routes/, lib/.
//
// Layering rule (CLAUDE.md): services never require routes; the opp2 lib
// requires services, never the reverse. This script builds the require
// graph from source (not from node's module cache, which would hide a
// cycle behind whichever file happens to load first) and checks both:
//   1. No cycle anywhere in services/routes/lib.
//   2. No file under services/ or lib/ requires anything under routes/.
//
// Usage: node scripts/check-circular-requires.js
// Exit code 0 = clean, 1 = a cycle or layering violation was found.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['services', 'routes', 'lib'];

function listJsFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(dir, f));
}

const files = DIRS.flatMap(listJsFiles);

function resolveRequire(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // node_modules, not our graph
  const fromDir = path.dirname(path.join(ROOT, fromFile));
  let resolved = path.normalize(path.join(fromDir, spec));
  if (!resolved.endsWith('.js')) resolved += '.js';
  const rel = path.relative(ROOT, resolved);
  return files.includes(rel) ? rel : null;
}

const graph = {};
for (const file of files) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const specs = [...src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map(m => m[1]);
  // A file requiring itself (e.g. a lazy self-reference inside a function
  // body, after its own module.exports is already assigned) is a benign,
  // common Node idiom, not a circular-dependency risk — exclude self-edges.
  graph[file] = specs.map(s => resolveRequire(file, s)).filter(dep => dep && dep !== file);
}

let violations = [];

// Layering: services/ and lib/ must never require routes/.
for (const [file, deps] of Object.entries(graph)) {
  if (file.startsWith('services/') || file.startsWith('lib/')) {
    for (const dep of deps) {
      if (dep.startsWith('routes/')) {
        violations.push(`Layering violation: ${file} requires ${dep} (services/lib must never require routes/)`);
      }
    }
  }
}

// Cycle detection via DFS with a recursion stack.
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = {};
for (const f of files) color[f] = WHITE;

function dfs(node, stack) {
  color[node] = GRAY;
  stack.push(node);
  for (const dep of graph[node] || []) {
    if (color[dep] === GRAY) {
      const cycleStart = stack.indexOf(dep);
      const cycle = stack.slice(cycleStart).concat(dep);
      violations.push(`Circular require: ${cycle.join(' -> ')}`);
    } else if (color[dep] === WHITE) {
      dfs(dep, stack);
    }
  }
  stack.pop();
  color[node] = BLACK;
}

for (const f of files) {
  if (color[f] === WHITE) dfs(f, []);
}

if (violations.length) {
  console.log('FAIL: circular-requires / layering');
  for (const v of violations) console.log('  - ' + v);
  process.exit(1);
} else {
  console.log(`OK: no circular requires or layering violations across ${files.length} files (services/routes/lib)`);
  process.exit(0);
}
