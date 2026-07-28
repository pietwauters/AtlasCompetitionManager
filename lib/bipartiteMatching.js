'use strict';

// Maximum bipartite matching via Kuhn's algorithm (augmenting paths).
// `adjacency[i]` is the array of right-node indices left-node i may be
// matched to. Returns `matchLeft`, where matchLeft[i] is the matched
// right-node index for left-node i, or -1 if left-node i is unmatched.
// O(numLeft * totalEdges) — more than fast enough at this app's scale
// (dozens of pools, at most a few hundred referees).
function maxBipartiteMatching(numLeft, numRight, adjacency) {
  const matchRight = new Array(numRight).fill(-1); // right -> left
  const matchLeft  = new Array(numLeft).fill(-1);  // left -> right

  function tryAugment(u, visited) {
    for (const v of (adjacency[u] || [])) {
      if (visited[v]) continue;
      visited[v] = true;
      if (matchRight[v] === -1 || tryAugment(matchRight[v], visited)) {
        matchRight[v] = u;
        matchLeft[u] = v;
        return true;
      }
    }
    return false;
  }

  for (let u = 0; u < numLeft; u++) {
    tryAugment(u, new Array(numRight).fill(false));
  }

  return matchLeft;
}

// Hall/König deficiency certificate for a maximum matching that fails to
// cover every left-vertex. Given the same adjacency and the matchLeft
// result from maxBipartiteMatching, finds:
//   S = every left-vertex reachable via an alternating path (edge, then the
//       matching edge back, then an edge, ...) starting from an unmatched
//       left-vertex
//   T = every right-vertex reached along the way (= the neighborhood N(S))
// This is exactly the deficient set from Hall's Marriage Theorem: no
// rearrangement of the matching can cover more of S than the current
// matching already does, because S collectively has access to only T.
// |S| - |T| always equals the number of unmatched left-vertices (a short,
// standard proof: every vertex in T is matched — an unmatched one would
// itself be an augmenting path, contradicting maximality — and each is
// matched to a distinct vertex already counted in S, so S is exactly the
// unmatched left-vertices plus one per vertex of T).
function findDeficientSet(numLeft, numRight, adjacency, matchLeft) {
  const matchRight = new Array(numRight).fill(-1);
  matchLeft.forEach((r, l) => { if (r !== -1) matchRight[r] = l; });

  const leftVisited  = new Array(numLeft).fill(false);
  const rightVisited = new Array(numRight).fill(false);
  const queue = [];
  for (let l = 0; l < numLeft; l++) {
    if (matchLeft[l] === -1) { leftVisited[l] = true; queue.push(l); }
  }

  for (let qi = 0; qi < queue.length; qi++) {
    const l = queue[qi];
    for (const r of (adjacency[l] || [])) {
      if (rightVisited[r]) continue;
      rightVisited[r] = true;
      const nextLeft = matchRight[r];
      if (nextLeft !== -1 && !leftVisited[nextLeft]) {
        leftVisited[nextLeft] = true;
        queue.push(nextLeft);
      }
    }
  }

  const S = [];
  for (let l = 0; l < numLeft; l++) if (leftVisited[l]) S.push(l);
  const T = [];
  for (let r = 0; r < numRight; r++) if (rightVisited[r]) T.push(r);
  return { S, T };
}

module.exports = { maxBipartiteMatching, findDeficientSet };
