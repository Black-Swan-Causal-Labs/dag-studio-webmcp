/**
 * DAG Studio — Causal Inference Engine
 *
 * Implements d-separation, backdoor path detection, and adjustment set
 * computation based on Pearl (2009) and Shrier & Platt (2008).
 *
 * Validated against 15 canonical test cases drawn from the dagitty paper
 * (Textor et al., 2016). See /tests/engine.test.js for the full suite.
 */

/**
 * Compute the set of descendants of a node following directed edges.
 */
export function descendants(nodeId, edges) {
  const desc = new Set();
  const q = [nodeId];
  while (q.length) {
    const cur = q.shift();
    for (const e of edges) {
      if (e.src === cur && !desc.has(e.tgt)) {
        desc.add(e.tgt);
        q.push(e.tgt);
      }
    }
  }
  return desc;
}

/**
 * Enumerate all undirected paths between two nodes (ignoring edge direction).
 * Used to find all potential d-connecting paths.
 */
export function allPaths(start, end, edges) {
  const paths = [];
  const adj = {};
  for (const e of edges) {
    (adj[e.src] = adj[e.src] || []).push(e.tgt);
    (adj[e.tgt] = adj[e.tgt] || []).push(e.src);
  }
  function dfs(cur, path, visited) {
    if (cur === end) { paths.push([...path]); return; }
    if (path.length > 12) return; // guard against exponential blowup in large DAGs
    for (const nb of (adj[cur] || [])) {
      if (!visited.has(nb)) {
        visited.add(nb);
        path.push(nb);
        dfs(nb, path, visited);
        path.pop();
        visited.delete(nb);
      }
    }
  }
  dfs(start, [start], new Set([start]));
  return paths;
}

/**
 * Test whether a node is a collider on a path segment prev → node ← next.
 */
export function isCollider(node, prev, next, edges) {
  return edges.some(e => e.src === prev && e.tgt === node) &&
         edges.some(e => e.src === next  && e.tgt === node);
}

/**
 * Test whether a path is blocked by conditioning set Z.
 * Applies Pearl's d-separation rules:
 *   - Non-colliders on the path are blocked if they are in Z
 *   - Colliders are blocked if neither they nor any descendant is in Z
 */
export function pathBlocked(path, Z, edges) {
  const Zset = new Set(Z);
  for (let i = 1; i < path.length - 1; i++) {
    const [p, c, n] = [path[i - 1], path[i], path[i + 1]];
    if (isCollider(c, p, n, edges)) {
      const desc = descendants(c, edges);
      if (!Zset.has(c) && ![...desc].some(d => Zset.has(d))) return true;
    } else {
      if (Zset.has(c)) return true;
    }
  }
  return false;
}

/**
 * Find all open backdoor paths from exposure to outcome.
 * A backdoor path starts with an arrow INTO the exposure node and is
 * d-connected (open) in the empty conditioning set.
 */
export function backdoorPaths(exp, out, edges) {
  return allPaths(exp, out, edges).filter(path =>
    path.length >= 2 &&
    edges.some(e => e.src === path[1] && e.tgt === exp) &&
    !pathBlocked(path, [], edges)
  );
}

/**
 * Compute all minimal sufficient adjustment sets for the effect of exp on out.
 * Returns null if exposure or outcome are not set.
 */
export function computeAdjustmentSets(exp, out, nodes, edges) {
  if (!exp || !out) return null;
  const desc = descendants(exp, edges);
  const cands = nodes
    .filter(n => n.id !== exp && n.id !== out && !desc.has(n.id) && n.type !== 'latent')
    .map(n => n.id)
    .slice(0, 10); // limit to keep enumeration tractable
  const bkPaths = backdoorPaths(exp, out, edges);
  const aPaths  = allPaths(exp, out, edges);
  if (!bkPaths.length) return { sets: [[]], backdoor: [], all: aPaths };
  const valid = [];
  for (let mask = 0; mask < (1 << cands.length); mask++) {
    const Z = cands.filter((_, i) => mask & (1 << i));
    if (bkPaths.every(p => pathBlocked(p, Z, edges))) valid.push(Z);
  }
  const minimal = valid.filter(s =>
    !valid.some(o => o.length < s.length && o.every(x => s.includes(x)))
  );
  return { sets: minimal, backdoor: bkPaths, all: aPaths };
}
