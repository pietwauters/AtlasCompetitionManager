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

module.exports = { maxBipartiteMatching };
