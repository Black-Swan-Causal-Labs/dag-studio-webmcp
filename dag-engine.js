// Copyright 2026 John D. Diaz-Decaro, Black Swan Causal Labs, LLC
// SPDX-License-Identifier: Apache-2.0
//
// DAG Studio analytical engine.
//
// Pure ESM module. No runtime dependencies. Lifted verbatim from index.html
// with one exception: simulateData and boxMullerRandom take an injected RNG
// instead of swapping Math.random globally. The LCG formula, call ordering,
// and edge-coefficient handling are unchanged, so seeded outputs are
// bit-identical to the pre-refactor implementation (verified by
// dag-engine.test.js against dag-engine.simulate-baseline.json).
//
// Imported by:
//   - index.html (browser canvas)
//   - dag-engine.test.js (Node validation suite)

export const ENGINE_SEMVER = '0.3.0';

// ─── Graph traversal ────────────────────────────────────────────────────────

export function descendants(nodeId, edges) {
  const desc = new Set();
  const q = [nodeId];
  while (q.length) {
    const cur = q.shift();
    for (const e of edges) if (e.src === cur && !desc.has(e.tgt)) {
      desc.add(e.tgt);
      q.push(e.tgt);
    }
  }
  return desc;
}

// Bounded simple-path enumeration over the undirected skeleton. Enumeration
// is inherently exponential in dense graphs, so the walk carries explicit
// budgets and reports truncation instead of hanging or silently dropping
// paths (the old bare length cap). Correctness-critical checks no longer
// depend on this list — computeAdjustmentSets validates sets with
// dSeparated() — so these budgets only bound what is displayed.
export function enumeratePaths(start, end, edges, opts = {}) {
  const maxLen = opts.maxLen ?? 12;
  const maxPaths = opts.maxPaths ?? 2000;
  const maxSteps = opts.maxSteps ?? 200000;
  const paths = [];
  let steps = 0;
  let truncated = false;
  const adj = {};
  for (const e of edges) {
    (adj[e.src] = adj[e.src] || []).push(e.tgt);
    (adj[e.tgt] = adj[e.tgt] || []).push(e.src);
  }
  function dfs(cur, path, visited) {
    if (paths.length >= maxPaths || ++steps > maxSteps) { truncated = true; return; }
    if (cur === end) {
      paths.push([...path]);
      return;
    }
    if (path.length > maxLen) { truncated = true; return; }
    for (const nb of adj[cur] || []) if (!visited.has(nb)) {
      visited.add(nb);
      path.push(nb);
      dfs(nb, path, visited);
      path.pop();
      visited.delete(nb);
    }
  }
  dfs(start, [start], new Set([start]));
  return { paths, truncated };
}

export function allPaths(start, end, edges) {
  return enumeratePaths(start, end, edges).paths;
}

export function isCollider(node, prev, next, edges) {
  return edges.some(e => e.src === prev && e.tgt === node) && edges.some(e => e.src === next && e.tgt === node);
}

export function isDirectedCausalPath(path, edges) {
  for (let i = 0; i < path.length - 1; i++) {
    if (!edges.some(e => e.src === path[i] && e.tgt === path[i + 1])) return false;
  }
  return true;
}

export function pathBlocked(path, Z, edges) {
  const Zset = new Set(Z);
  for (let i = 1; i < path.length - 1; i++) {
    const [p, c, n] = [path[i - 1], path[i], path[i + 1]];
    if (isCollider(c, p, n, edges)) {
      const desc = descendants(c, edges);
      if (!Zset.has(c) && ![...desc].some(d => Zset.has(d))) return true;
    } else if (Zset.has(c)) return true;
  }
  return false;
}

// d-separation test via the "reachable" procedure (Koller & Friedman
// Algorithm 3.1, a.k.a. Bayes-ball): x and y are d-separated given Z iff no
// active trail connects them. O(V+E) per query — no path enumeration, so it
// stays exact on graphs where enumeratePaths() would truncate.
export function dSeparated(x, y, Z, edges) {
  return makeDSeparator(edges)(x, y, Z);
}

// Builds the adjacency once and returns a (x, y, Z) => boolean tester, for
// callers that run many queries against the same graph.
export function makeDSeparator(edges) {
  const parents = {};
  const children = {};
  for (const e of edges) {
    (children[e.src] = children[e.src] || []).push(e.tgt);
    (parents[e.tgt] = parents[e.tgt] || []).push(e.src);
  }
  const NONE = [];
  return (x, y, Z) => {
    const Zset = new Set(Z);
    // Ancestors of Z (including Z itself): the set that activates colliders.
    const anc = new Set(Zset);
    const aq = [...Zset];
    while (aq.length) {
      const cur = aq.pop();
      for (const p of parents[cur] || NONE) if (!anc.has(p)) { anc.add(p); aq.push(p); }
    }
    // Walk (node, direction) states. 'up' = arrived from a child (against an
    // edge); 'down' = arrived from a parent (along an edge). x starts as if
    // reached from a virtual child so both directions are explored.
    const seenUp = new Set();
    const seenDown = new Set();
    const stack = [x, true];
    while (stack.length) {
      const up = stack.pop();
      const node = stack.pop();
      const seen = up ? seenUp : seenDown;
      if (seen.has(node)) continue;
      seen.add(node);
      if (up) {
        if (Zset.has(node)) continue;            // chain/fork blocked at Z
        if (node === y) return false;            // active trail reaches y
        for (const p of parents[node] || NONE) stack.push(p, true);
        for (const c of children[node] || NONE) stack.push(c, false);
      } else {
        if (!Zset.has(node)) {
          if (node === y) return false;
          for (const c of children[node] || NONE) stack.push(c, false);
        }
        // v-structure: parent → node ← parent passes iff node ∈ ancestors(Z)∪Z
        if (anc.has(node)) {
          for (const p of parents[node] || NONE) stack.push(p, true);
        }
      }
    }
    return true;
  };
}

export function backdoorPaths(exp, out, edges) {
  return allPaths(exp, out, edges).filter(path => path.length >= 2 && edges.some(e => e.src === path[1] && e.tgt === exp) && !pathBlocked(path, [], edges));
}

// Largest candidate pool for which every subset is enumerated (2^n exact
// d-separation tests). Above this, existence is still decided exactly and at
// least one minimal set is returned; only the *listing* may be incomplete.
export const ADJUSTMENT_ENUM_CAP = 15;

export function computeAdjustmentSets(exp, out, nodes, edges) {
  if (!exp || !out) return null;
  const desc = descendants(exp, edges);
  const { paths: aPaths, truncated: pathsTruncated } = enumeratePaths(exp, out, edges);
  const bkPaths = aPaths.filter(p =>
    p.length >= 2 && edges.some(e => e.src === p[1] && e.tgt === exp) && !pathBlocked(p, [], edges));
  // Backdoor criterion via d-separation on the graph with the exposure's
  // outgoing edges removed (Pearl 2009 §3.3): Z is valid iff X ⊥ Y | Z there.
  // Candidates exclude descendants of the exposure. This is exact and
  // polynomial per set — independent of the (bounded) path lists above — and
  // it also rejects sets that OPEN a collider path while closing another.
  const backdoorEdges = edges.filter(e => e.src !== exp);
  const separated = makeDSeparator(backdoorEdges);
  const isValid = Z => separated(exp, out, Z);
  const done = (sets, candidates) => ({
    sets,
    backdoor: bkPaths,
    all: aPaths,
    truncated: { candidates, paths: pathsTruncated }
  });
  if (isValid([])) return done([[]], false);

  // Every minimal d-separator of X and Y lies inside An(X ∪ Y), and if any
  // separator drawn from a permitted set R exists then An(X ∪ Y) ∩ R is one
  // (Tian, Paz & Pearl 1998; van der Zander, Liśkiewicz & Textor 2014). So
  // restricting candidates to backdoor-graph ancestors of the exposure or
  // outcome loses no minimal set, and testing that one "canonical" set decides
  // existence exactly — however many covariates the DAG has.
  const parents = {};
  for (const e of backdoorEdges) (parents[e.tgt] = parents[e.tgt] || []).push(e.src);
  const anc = new Set();
  const stack = [exp, out];
  while (stack.length) {
    const cur = stack.pop();
    for (const p of parents[cur] || []) if (!anc.has(p)) { anc.add(p); stack.push(p); }
  }
  const cands = nodes
    .filter(n => n.id !== exp && n.id !== out && !desc.has(n.id) && n.type !== 'latent' && anc.has(n.id))
    .map(n => n.id);
  if (!isValid(cands)) return done([], false);

  if (cands.length <= ADJUSTMENT_ENUM_CAP) {
    // covered[mask] = some valid set is a subset of mask. A valid set is
    // minimal iff none of its one-smaller subsets is covered. Masks are
    // visited in increasing numeric order, so every subset precedes its
    // supersets and one pass suffices.
    const k = cands.length;
    const covered = new Uint8Array(1 << k);
    const minimal = [];
    for (let mask = 0; mask < 1 << k; mask++) {
      let sub = false;
      for (let i = 0; i < k && !sub; i++) if (mask & 1 << i && covered[mask ^ 1 << i]) sub = true;
      if (sub) { covered[mask] = 1; continue; }
      const Z = cands.filter((_, i) => mask & 1 << i);
      if (isValid(Z)) { covered[mask] = 1; minimal.push(Z); }
    }
    return done(minimal, false);
  }

  // Too many candidates to enumerate every subset. Shrink the canonical set
  // greedily under several removal orders; each result is a valid set from
  // which no single variable can be dropped. The list is flagged incomplete.
  const shrink = order => {
    const keep = new Set(cands);
    for (const c of order) {
      keep.delete(c);
      if (!isValid(cands.filter(x => keep.has(x)))) keep.add(c);
    }
    return cands.filter(x => keep.has(x));
  };
  const found = new Map();
  const orders = [cands, [...cands].reverse()];
  for (let i = 1; i < cands.length; i++) orders.push([...cands.slice(i), ...cands.slice(0, i)]);
  for (const order of orders) {
    const Z = shrink(order);
    found.set(Z.join('\u0000'), Z);
  }
  return done([...found.values()], true);
}

// Validate a proposed adjustment set for the total effect of exp on out.
// `blocksBackdoor` is the exact d-separation test on the backdoor graph;
// `descendantsOfExposure` lists members that violate the backdoor criterion's
// first condition (mediators, colliders downstream of the exposure, …).
// `valid` requires both conditions. Latent members are reported because they
// cannot be adjusted for in practice.
export function checkAdjustmentSet(exp, out, Z, nodes, edges) {
  const desc = descendants(exp, edges);
  const latent = new Set(nodes.filter(n => n.type === 'latent').map(n => n.id));
  const members = [...new Set(Z)];
  const backdoorEdges = edges.filter(e => e.src !== exp);
  const blocksBackdoor = dSeparated(exp, out, members.filter(z => z !== exp && z !== out), backdoorEdges);
  const descendantsOfExposure = members.filter(z => desc.has(z));
  const latentMembers = members.filter(z => latent.has(z));
  const containsEndpoint = members.includes(exp) || members.includes(out);
  return {
    valid: blocksBackdoor && descendantsOfExposure.length === 0 && !containsEndpoint,
    blocksBackdoor,
    descendantsOfExposure,
    latentMembers
  };
}

// ─── Effect Modification Classifier ─────────────────────────────────────────
// Returns per-modifier classification per VanderWeele & Robins (2007) Fig 1
// and Weinberg (2007). Priority: pure-interaction > indirect > common-cause >
// proxy > direct.
export function classifyEffectModification(nodes, edges, modifiers, exposure, outcome) {
  if (!modifiers || !modifiers.length) return [];
  const fwd = {}, rev = {};
  for (const e of edges) {
    (fwd[e.src] = fwd[e.src] || []).push(e.tgt);
    (rev[e.tgt] = rev[e.tgt] || []).push(e.src);
  }
  const reach = (id, adj) => {
    const r = new Set(); const q = [id];
    while (q.length) { const c = q.shift();
      for (const nb of (adj[c] || [])) if (!r.has(nb)) { r.add(nb); q.push(nb); }
    }
    return r;
  };
  const ancE = exposure ? reach(exposure, rev) : new Set();
  const mediators = new Set();
  if (exposure && outcome) {
    const descE = reach(exposure, fwd);
    const ancO = reach(outcome, rev);
    for (const n of descE) if (n !== outcome && ancO.has(n)) mediators.add(n);
  }
  return modifiers.map(mod => {
    const M = mod.src;
    if (!nodes.find(n => n.id === M)) return { modifierId: mod.id, emType: 'invalid' };
    const descM = reach(M, fwd);
    const ancM = reach(M, rev);
    if (outcome && (fwd[M] || []).includes(outcome)) return { modifierId: mod.id, emType: 'pure-interaction' };
    for (const m of mediators) if (descM.has(m)) return { modifierId: mod.id, emType: 'indirect' };
    for (const a of ancM) if (ancE.has(a)) return { modifierId: mod.id, emType: 'common-cause' };
    for (const ch of (fwd[M] || [])) if (ch !== exposure && ch !== outcome) return { modifierId: mod.id, emType: 'proxy' };
    return { modifierId: mod.id, emType: 'direct' };
  });
}

// ─── Structural Role Inference (for label-vs-structure diagnostics) ─────────
// Classifies a node's structural role relative to a given exposure/outcome,
// independent of its user-assigned type. Used to surface label-structure
// conflicts (e.g., a mediator mis-labeled as "confounder").
export function structuralRole(nodeId, exposure, outcome, edges) {
  if (nodeId === exposure) return 'exposure';
  if (nodeId === outcome) return 'outcome';
  if (!exposure || !outcome) return 'unknown';
  const fwd = {}, rev = {};
  for (const e of edges) {
    (fwd[e.src] = fwd[e.src] || []).push(e.tgt);
    (rev[e.tgt] = rev[e.tgt] || []).push(e.src);
  }
  const reach = (start, adj) => {
    const r = new Set(); const q = [start];
    while (q.length) { const c = q.shift(); for (const nb of (adj[c] || [])) if (!r.has(nb)) { r.add(nb); q.push(nb); } }
    return r;
  };
  const descN = reach(nodeId, fwd);
  const descE = reach(exposure, fwd);
  const isDescOfExp = descE.has(nodeId);
  const isAncOfOut = descN.has(outcome);
  const isAncOfExp = descN.has(exposure);
  // A common cause must reach the outcome by a route that does not pass
  // through the exposure. An ancestor of the exposure whose only route to the
  // outcome is via the exposure (Z → X → Y) is instrument-like, not a
  // confounder — every ancestor of X is trivially an ancestor of Y once X → Y.
  const fwdNoExp = {};
  for (const e of edges) if (e.src !== exposure && e.tgt !== exposure) {
    (fwdNoExp[e.src] = fwdNoExp[e.src] || []).push(e.tgt);
  }
  const reachesOutAvoidingExp = reach(nodeId, fwdNoExp).has(outcome);
  if (isDescOfExp && isAncOfOut) return 'mediator';
  if (isAncOfExp && reachesOutAvoidingExp) return 'confounder';
  if (isAncOfExp) return 'instrument';
  if (isDescOfExp && !isAncOfOut) return 'descendant-of-exposure';
  if (isAncOfOut && !isAncOfExp && !isDescOfExp) return 'ancestor-of-outcome';
  return 'unrelated';
}

export const STRUCTURAL_ROLE_LABELS = {
  'exposure': 'the exposure',
  'outcome': 'the outcome',
  'mediator': 'a mediator on the exposure→outcome path',
  'confounder': 'a confounder (common ancestor of exposure and outcome)',
  'instrument': 'an instrument-like ancestor of the exposure',
  'descendant-of-exposure': 'a descendant of the exposure',
  'ancestor-of-outcome': 'an ancestor of the outcome only',
  'unrelated': 'unrelated to the current exposure→outcome query',
  'unknown': 'unknown (exposure or outcome not set)'
};

export function detectTypeConflicts(nodes, edges, exposure, outcome) {
  if (!exposure || !outcome) return [];
  const out = [];
  for (const node of nodes) {
    if (node.type === 'unclassified' || node.type === 'latent' || node.type === 'modifier') continue;
    const structural = structuralRole(node.id, exposure, outcome, edges);
    let conflict = null;
    if (node.type === 'exposure' && node.id !== exposure) conflict = `labeled "Exposure" but the current effect is from a different node`;
    else if (node.type === 'outcome' && node.id !== outcome) conflict = `labeled "Outcome" but the current outcome is a different node`;
    else if (node.type === 'confounder' && structural !== 'confounder' && structural !== 'unknown') conflict = `labeled "Confounder" but structurally ${STRUCTURAL_ROLE_LABELS[structural] || structural}`;
    if (conflict) out.push({ nodeId: node.id, label: node.label, userType: node.type, structural, message: conflict });
  }
  return out;
}

export const EM_TYPE_LABELS = {
  'direct': 'Direct',
  'indirect': 'Indirect',
  'proxy': 'By Proxy',
  'common-cause': 'By Common Cause',
  'pure-interaction': 'Pure Interaction',
  'invalid': 'Invalid'
};

export const EM_TYPE_DESCRIPTIONS = {
  'direct': 'Modifier is structurally independent of the exposure and outcome system.',
  'indirect': 'Modifier acts through a mediator on the exposure→outcome path.',
  'proxy': 'Modifier has a downstream proxy variable.',
  'common-cause': 'Modifier shares an unmeasured or measured ancestor with the exposure.',
  'pure-interaction': 'Modifier has a direct edge to the outcome; effect is purely joint (Weinberg 2007).',
  'invalid': 'Modifier source node no longer exists.'
};

// ─── Data Simulation Engine ─────────────────────────────────────────────────

export function topoSort(nodes, edges) {
  // Kahn's algorithm for topological sort
  const inDegree = {};
  const adj = {};
  nodes.forEach(n => { inDegree[n.id] = 0; adj[n.id] = []; });
  edges.forEach(e => {
    if (adj[e.src]) adj[e.src].push(e.tgt);
    if (inDegree[e.tgt] !== undefined) inDegree[e.tgt]++;
  });
  const queue = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id);
  const sorted = [];
  while (queue.length) {
    const cur = queue.shift();
    sorted.push(cur);
    for (const nb of (adj[cur] || [])) {
      inDegree[nb]--;
      if (inDegree[nb] === 0) queue.push(nb);
    }
  }
  // If not all nodes sorted, there's a cycle – just return original order
  return sorted.length === nodes.length ? sorted : nodes.map(n => n.id);
}

// Cycle detection. topoSort succeeds when acyclic and falls back to original
// input order on cycle, but always returns nodes.length items, so length alone
// can't distinguish. We instead verify the edge-ordering invariant: in any
// valid topological order, every edge's src must precede its tgt. Any
// violation means the graph is cyclic (or has a self-loop). Edges referencing
// unknown node ids are skipped — they're a different kind of malformation,
// not a cycle.
export function hasCycle(nodes, edges) {
  const order = topoSort(nodes, edges);
  const idx = {};
  order.forEach((id, i) => { idx[id] = i; });
  return edges.some(e => {
    const si = idx[e.src], ti = idx[e.tgt];
    if (si === undefined || ti === undefined) return false;
    return si >= ti;
  });
}

// Linear congruential generator matching the previous in-place Math.random
// override (multiplier 1103515245, increment 12345, modulus 2^31). Pulled out
// so simulateData can build a per-call rng instead of swapping Math.random
// globally. The constants and call order are unchanged from the previous
// implementation, so byte-equivalence with the captured baseline holds.
export function makeSeededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function boxMullerRandom(rng = Math.random) {
  // Standard normal via Box-Muller. rng defaults to Math.random for any caller
  // that doesn't need determinism (ad hoc canvas use), but simulateData always
  // injects its own seeded rng.
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function simulateData(nodes, edges, n = 1000, seed = null, coefficients = {}) {
  const rng = seed !== null ? makeSeededRandom(seed) : Math.random;

  const order = topoSort(nodes, edges);
  const parents = {};
  nodes.forEach(nd => parents[nd.id] = []);
  edges.forEach(e => {
    if (parents[e.tgt]) parents[e.tgt].push(e.src);
  });

  const data = [];
  for (let i = 0; i < n; i++) {
    const row = {};
    for (const nodeId of order) {
      const pars = parents[nodeId];
      if (pars.length === 0) {
        // Root node: sample from N(0,1)
        row[nodeId] = boxMullerRandom(rng);
      } else {
        // Non-root: linear combination of parents + noise
        let val = 0;
        for (const p of pars) {
          const edgeKey = `${p}->${nodeId}`;
          const coef = coefficients[edgeKey] !== undefined ? coefficients[edgeKey] : 0.5;
          val += coef * row[p];
        }
        val += boxMullerRandom(rng) * 0.5;
        row[nodeId] = val;
      }
    }
    data.push(row);
  }

  return { data, order };
}

export function computeCorrelation(x, y) {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  return num / Math.sqrt(denX * denY);
}

export function computePartialCorrelation(data, x, y, Z) {
  // Partial correlation of X and Y controlling for Z using residuals
  if (Z.length === 0) {
    const xVals = data.map(r => r[x]);
    const yVals = data.map(r => r[y]);
    return computeCorrelation(xVals, yVals);
  }

  // Simple linear regression residuals approach
  const xVals = data.map(r => r[x]);
  const yVals = data.map(r => r[y]);
  const zMatrix = data.map(r => Z.map(z => r[z]));

  // Residualize X on Z
  const xResid = residualize(xVals, zMatrix);
  // Residualize Y on Z
  const yResid = residualize(yVals, zMatrix);

  return computeCorrelation(xResid, yResid);
}

export function residualize(y, X) {
  // Simple OLS residuals: y - X * (X'X)^-1 * X'y
  const n = y.length;
  if (X[0].length === 0) return y;

  const k = X[0].length;

  // Add intercept
  const Xaug = X.map(row => [1, ...row]);
  const ka = k + 1;

  // X'X
  const XtX = Array(ka).fill(null).map(() => Array(ka).fill(0));
  for (let i = 0; i < ka; i++) {
    for (let j = 0; j < ka; j++) {
      for (let r = 0; r < n; r++) {
        XtX[i][j] += Xaug[r][i] * Xaug[r][j];
      }
    }
  }

  // X'y
  const Xty = Array(ka).fill(0);
  for (let i = 0; i < ka; i++) {
    for (let r = 0; r < n; r++) {
      Xty[i] += Xaug[r][i] * y[r];
    }
  }

  // Solve using simple Gaussian elimination (for small k)
  const beta = solveLinear(XtX, Xty);
  if (!beta) return y; // fallback

  // Compute residuals
  const resid = [];
  for (let r = 0; r < n; r++) {
    let pred = 0;
    for (let i = 0; i < ka; i++) pred += beta[i] * Xaug[r][i];
    resid.push(y[r] - pred);
  }
  return resid;
}

export function solveLinear(A, b) {
  // Gaussian elimination with partial pivoting
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    if (Math.abs(M[col][col]) < 1e-10) return null;

    // Eliminate
    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / M[col][col];
      for (let j = col; j <= n; j++) M[row][j] -= f * M[col][j];
    }
  }

  // Back substitution
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
    x[i] /= M[i][i];
  }
  return x;
}

export function dataToCSV(data, order, nodeMap) {
  const headers = order.map(id => nodeMap[id]?.label || id);
  const rows = data.map(row => order.map(id => row[id].toFixed(4)));
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

export function computeOLSCoefficients(data, yVar, xVars) {
  // Returns coefficients for regression Y ~ X1 + X2 + ... + Xk
  // Returns array: [intercept, beta_X1, beta_X2, ...]
  const n = data.length;
  const k = xVars.length;

  // Build design matrix with intercept
  const X = data.map(row => [1, ...xVars.map(v => row[v])]);
  const y = data.map(row => row[yVar]);
  const ka = k + 1;

  // X'X
  const XtX = Array(ka).fill(null).map(() => Array(ka).fill(0));
  for (let i = 0; i < ka; i++) {
    for (let j = 0; j < ka; j++) {
      for (let r = 0; r < n; r++) {
        XtX[i][j] += X[r][i] * X[r][j];
      }
    }
  }

  // X'y
  const Xty = Array(ka).fill(0);
  for (let i = 0; i < ka; i++) {
    for (let r = 0; r < n; r++) {
      Xty[i] += X[r][i] * y[r];
    }
  }

  // Solve for beta
  const beta = solveLinear(XtX, Xty);
  return beta;
}

export function computeTrueEffect(exposure, outcome, edges, coefficients = {}) {
  // For a linear SEM, total effect = sum of products of edge coefficients
  // along all directed exposure→outcome paths. The total is computed exactly
  // with a topological-order pass (O(V+E)) — the old implementation summed
  // enumerated paths, so paths past its length cap silently biased the total.
  // The path list is still enumerated (bounded) for display, with a
  // `truncated` flag when the budgets cut it short.

  // Build adjacency list
  const adj = {};
  const edgeCoefs = {};
  const ids = new Set([exposure, outcome]);
  edges.forEach(e => {
    if (!adj[e.src]) adj[e.src] = [];
    adj[e.src].push(e.tgt);
    const key = `${e.src}->${e.tgt}`;
    edgeCoefs[key] = coefficients[key] !== undefined ? coefficients[key] : 0.5;
    ids.add(e.src);
    ids.add(e.tgt);
  });

  // Exact total effect: propagate path-weight sums in topological order.
  const inDeg = {};
  ids.forEach(id => { inDeg[id] = 0; });
  edges.forEach(e => { inDeg[e.tgt]++; });
  const order = [...ids].filter(id => inDeg[id] === 0);
  for (let i = 0; i < order.length; i++) {
    for (const nb of adj[order[i]] || []) if (--inDeg[nb] === 0) order.push(nb);
  }
  let totalEffect = null;
  if (order.length === ids.size) { // acyclic
    const eff = { [exposure]: 1 };
    for (const id of order) {
      const w = eff[id];
      if (!w) continue;
      for (const child of adj[id] || []) {
        eff[child] = (eff[child] || 0) + w * edgeCoefs[`${id}->${child}`];
      }
    }
    totalEffect = eff[outcome] || 0;
  }

  // Bounded directed-path enumeration for display.
  const allDirectedPaths = [];
  let steps = 0;
  let truncated = false;
  const dfs = (cur, path, coefProduct) => {
    if (allDirectedPaths.length >= 2000 || ++steps > 200000) { truncated = true; return; }
    if (cur === outcome) {
      allDirectedPaths.push({ path: [...path], coef: coefProduct });
      return;
    }
    if (path.length > 20) { truncated = true; return; }
    for (const next of (adj[cur] || [])) {
      if (!path.includes(next)) {
        const edgeKey = `${cur}->${next}`;
        const edgeCoef = edgeCoefs[edgeKey];
        path.push(next);
        dfs(next, path, coefProduct * edgeCoef);
        path.pop();
      }
    }
  };
  dfs(exposure, [exposure], 1);

  // Cyclic graphs can't be topo-ordered; fall back to the path sum, matching
  // the old behavior (upstream hasCycle guards normally prevent this).
  if (totalEffect === null) {
    totalEffect = allDirectedPaths.reduce((sum, p) => sum + p.coef, 0);
  }
  return { totalEffect, paths: allDirectedPaths, truncated };
}

// ─── Code generation helpers ────────────────────────────────────────────────

export function _codeIdent(s) {
  let id = String(s || '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!id) id = 'node';
  if (/^[0-9]/.test(id)) id = '_' + id;
  return id;
}

// Build a stable id → safe identifier map and detect collisions. Prefers the
// sanitized label (what the user sees on the canvas) over the internal node id
// (which for user-placed nodes is an auto-generated token like `n51_1776…`).
export function _identMap(nodes) {
  const map = {};
  const used = new Set();
  for (const n of nodes) {
    const base = _codeIdent(n.label || n.id);
    let ident = base, k = 2;
    while (used.has(ident)) { ident = `${base}_${k++}`; }
    used.add(ident);
    map[n.id] = ident;
  }
  return map;
}

// Map canvas pixel coords (y-down) to a small centered data-coord system
// (y-up) suitable for matplotlib / dagitty's coordinates().
export function _plotCoords(nodes) {
  if (!nodes.length) return {};
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const out = {};
  for (const n of nodes) {
    out[n.id] = {
      x: +((n.x - cx) / 100).toFixed(2),
      y: +((cy - n.y) / 100).toFixed(2)
    };
  }
  return out;
}

export function generatePythonCode(nodes, edges, exposure, outcome) {
  if (!nodes || nodes.length === 0) {
    return "# Empty DAG. Build one on the canvas or write Python below.\n" +
           "import networkx as nx\n" +
           "dag = nx.DiGraph()\n";
  }
  const idm = _identMap(nodes);
  const lines = [];
  lines.push("# DAG Studio — generated from canvas");
  lines.push("# Edit this code and click Run → Canvas to push changes back to the canvas.");
  lines.push("import networkx as nx");
  lines.push("");
  lines.push("dag = nx.DiGraph()");
  // Nodes with label + role metadata
  lines.push("dag.add_nodes_from([");
  for (const n of nodes) {
    const ident = idm[n.id];
    const label = String(n.label || n.id).replace(/'/g, "\\'");
    const role = n.type || 'variable';
    lines.push(`    ('${ident}', {'label': '${label}', 'role': '${role}'}),`);
  }
  lines.push("])");
  // Edges
  if (edges && edges.length) {
    lines.push("dag.add_edges_from([");
    for (const e of edges) {
      const s = idm[e.src], t = idm[e.tgt];
      if (s && t) lines.push(`    ('${s}', '${t}'),`);
    }
    lines.push("])");
  }
  // Exposure / outcome
  if (exposure && idm[exposure]) lines.push(`dag.graph['exposure'] = '${idm[exposure]}'`);
  if (outcome && idm[outcome])   lines.push(`dag.graph['outcome'] = '${idm[outcome]}'`);

  // Commented-out matplotlib viz block. Stays commented so Run → Canvas works
  // (matplotlib isn't in Pyodide by default); uncomment locally in Jupyter/VS
  // Code to render a layout that mirrors the canvas.
  const coords = _plotCoords(nodes);
  lines.push("");
  lines.push("# ─── Optional: render locally with matplotlib ───────────────────────────");
  lines.push("# import matplotlib.pyplot as plt");
  lines.push("# pos = {");
  for (const n of nodes) {
    const ident = idm[n.id];
    const c = coords[n.id];
    lines.push(`#     '${ident}': (${c.x}, ${c.y}),`);
  }
  lines.push("# }");
  lines.push("# nx.draw(dag, pos, with_labels=True, node_size=2600, node_color='#eaf2f2',");
  lines.push("#         edgecolors='#3d7a7a', linewidths=1.8, font_size=10,");
  lines.push("#         arrows=True, arrowstyle='-|>', arrowsize=22, width=1.6,");
  lines.push("#         edge_color='#555861')");
  lines.push("# plt.axis('off'); plt.tight_layout(); plt.show()");

  return lines.join("\n") + "\n";
}

export function generateRCode(nodes, edges, exposure, outcome) {
  if (!nodes || nodes.length === 0) {
    return "# Empty DAG. Build one on the canvas or write R below.\n" +
           "library(dagitty)\n" +
           "dag <- dagitty('dag { }')\n";
  }
  const idm = _identMap(nodes);
  const declLines = [];
  for (const n of nodes) {
    const ident = idm[n.id];
    const roles = [];
    if (n.id === exposure) roles.push('exposure');
    if (n.id === outcome)  roles.push('outcome');
    if (n.type === 'latent') roles.push('latent');
    declLines.push(roles.length ? `    ${ident} [${roles.join(',')}]` : `    ${ident}`);
  }
  const edgeLines = (edges || []).map(e => {
    const s = idm[e.src], t = idm[e.tgt];
    return (s && t) ? `    ${s} -> ${t}` : null;
  }).filter(Boolean);
  const body = [...declLines, ...edgeLines].join("\n");

  // Build coordinates() block mirroring canvas layout (kept commented so it
  // doesn't execute during Run → Canvas, where plotting is a no-op).
  const coords = _plotCoords(nodes);
  const xPairs = nodes.map(n => `${idm[n.id]} = ${coords[n.id].x}`).join(", ");
  const yPairs = nodes.map(n => `${idm[n.id]} = ${coords[n.id].y}`).join(", ");

  return (
    "# DAG Studio — generated from canvas\n" +
    "# Edit this code and click Run → Canvas to push changes back to the canvas.\n" +
    "library(dagitty)\n" +
    "dag <- dagitty('\n" +
    "  dag {\n" +
    body + "\n" +
    "  }\n" +
    "')\n" +
    "\n" +
    "# ─── Optional: render locally ───────────────────────────────────────────\n" +
    "# Layout coordinates mirroring the DAG Studio canvas:\n" +
    "# coordinates(dag) <- list(\n" +
    "#   x = c(" + xPairs + "),\n" +
    "#   y = c(" + yPairs + ")\n" +
    "# )\n" +
    "#\n" +
    "# # Recommended — ggdag gives readable, publication-quality defaults:\n" +
    "# # install.packages(c('ggdag', 'ggplot2'))  # first time only\n" +
    "# # library(ggdag); library(ggplot2)\n" +
    "# # ggdag(dag, node_size = 20) + theme_dag()\n" +
    "#\n" +
    "# # Alternate — dagitty's base plot, forced to be readable (white fill,\n" +
    "# # black labels) since some dagitty versions default to unreadable styling:\n" +
    "# # op <- par(mar = c(1, 1, 1, 1), bg = 'white')\n" +
    "# # plot(dag, show.coefficients = FALSE)\n" +
    "# # # If nodes still render as dark filled circles, overlay readable labels:\n" +
    "# # co <- coordinates(dag)\n" +
    "# # points(co$x, co$y, pch = 21, bg = 'white', col = 'black', cex = 4)\n" +
    "# # text(co$x, co$y, labels = names(co$x), col = 'black', cex = 0.9)\n" +
    "# # par(op)\n"
  );
}

// ─── dagitty DSL parser ─────────────────────────────────────────────────────
// Pure-JS parser for the dagitty DSL. Accepts the R-wrapped form
// (`dagitty('dag { … }')`, `dagitty::dagitty("…")`) and the bare graph
// (`dag { … }`, as exported by dagitty.net or `cat(dag)`).
//
// Supported: node declarations with [exposure] / [outcome] / [latent]
// attributes, quoted names ("Body Mass Index"), directed edges in either
// direction, chains (A -> B -> C), node groups ({A B} -> {C D}), and
// bidirected edges. `A <-> B` is dagitty shorthand for an unmeasured common
// cause, so it becomes an explicit latent node with arrows into A and B.
//
// Anything the engine cannot represent faithfully — undirected edges, PAG
// edge marks, unbalanced braces, stray tokens — throws. A statement is never
// skipped silently: dropping an edge changes the causal claim and therefore
// the adjustment sets. Constructs that parse but are not analyzed (e.g.
// [adjusted]) are reported in `warnings`.
export function parseDagitty(rCode) {
  if (!rCode || !rCode.trim()) throw new Error('No R code provided.');
  const m = rCode.match(/(?:^|\W)(?:dagitty\s*::\s*)?dagitty\s*\(\s*(['"])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*\)/);
  let dsl;
  if (m) {
    dsl = m[2].replace(/\\(['"\\])/g, '$1');
  } else if (/^\s*(?:dag|mag|pdag|pag|digraph)\s*\{/.test(rCode)) {
    dsl = rCode;
  } else {
    throw new Error(
      "Could not find a dagitty graph. Provide either the bare DSL " +
      "(`dag { X [exposure]; Y [outcome]; X -> Y }`) or the R call " +
      "(`dagitty('dag { X [exposure]; Y [outcome]; X -> Y }')`)."
    );
  }

  // ── Tokenize ──
  const tokens = [];
  const ID_CHAR = /[\p{L}\p{N}_.]/u;
  // `glued` marks a bare name that follows another bare name on the same line
  // with only blanks between them — almost always an unquoted multi-word name
  // (`Lung Cancer -> Death`), which would otherwise read as two nodes.
  let blanksOnly = false;
  for (let i = 0; i < dsl.length;) {
    const ch = dsl[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (/\s/.test(ch) || ch === ';' || ch === ',') { blanksOnly = false; i++; continue; }
    if (!ID_CHAR.test(ch)) blanksOnly = false;
    if (ch === '#' || (ch === '/' && dsl[i + 1] === '/')) {
      while (i < dsl.length && dsl[i] !== '\n') i++;
      continue;
    }
    if (ch === '{' || ch === '}') { tokens.push({ t: ch }); i++; continue; }
    if (ch === '=' && tokens[tokens.length - 1]?.t === 'id') {
      // Graph-level attribute such as `bb="0,0,1,1"` (dagitty.net exports
      // one). It carries layout only, so drop the key and skip the value.
      tokens.pop();
      i++;
      while (i < dsl.length && /[ \t]/.test(dsl[i])) i++;
      if (dsl[i] === '"') {
        const j = dsl.indexOf('"', i + 1);
        if (j < 0) throw new Error('Unclosed quoted attribute value in the dagitty DSL.');
        i = j + 1;
      } else {
        while (i < dsl.length && !/[\s;{}\[\]]/.test(dsl[i])) i++;
      }
      continue;
    }
    if (ch === '[') {
      let j = i + 1, quote = null;
      for (; j < dsl.length; j++) {
        if (quote) { if (dsl[j] === quote) quote = null; }
        else if (dsl[j] === '"') quote = '"';
        else if (dsl[j] === ']') break;
      }
      if (j >= dsl.length) throw new Error('Unclosed "[" in the dagitty DSL.');
      tokens.push({ t: 'attr', v: dsl.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      const j = dsl.indexOf('"', i + 1);
      if (j < 0) throw new Error('Unclosed quoted node name in the dagitty DSL.');
      const name = dsl.slice(i + 1, j).trim();
      if (!name) throw new Error('Empty quoted node name in the dagitty DSL.');
      tokens.push({ t: 'id', v: name });
      i = j + 1;
      continue;
    }
    const op = /^(<->|->|<-|--|@->|<-@|@-@|@--|--@)/.exec(dsl.slice(i, i + 3));
    if (op) { tokens.push({ t: 'op', v: op[1] }); i += op[1].length; continue; }
    if (ID_CHAR.test(ch)) {
      let j = i;
      while (j < dsl.length && ID_CHAR.test(dsl[j])) j++;
      tokens.push({ t: 'id', v: dsl.slice(i, j), glued: blanksOnly });
      blanksOnly = true;
      i = j;
      continue;
    }
    throw new Error(
      `Unexpected character "${ch}" in the dagitty DSL near "${dsl.slice(Math.max(0, i - 15), i + 15).trim()}".`
    );
  }

  // ── Header: `dag {` … `}` ──
  let pos = 0;
  if (tokens[pos]?.t === 'id' && tokens[pos + 1]?.t === '{') {
    const kind = tokens[pos].v.toLowerCase();
    if (!['dag', 'digraph', 'mag', 'pdag', 'pag'].includes(kind)) {
      throw new Error(`Unsupported graph type "${tokens[pos].v}"; expected dag { … }.`);
    }
    if (tokens[tokens.length - 1]?.t !== '}') throw new Error('The dagitty DSL is missing its closing "}".');
    tokens.pop();
    pos = 2;
  }

  const nodeMap = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const warnings = [];
  // role is null for bare declarations so reconcileDagFromCode falls back to
  // the existing canvas type (confounder, unclassified, etc.) — the dagitty
  // DSL only encodes exposure/outcome/latent, so a bare `Age` shouldn't
  // overwrite a previously-set confounder type with a generic 'variable'.
  const getNode = (id) => {
    if (!nodeMap.has(id)) nodeMap.set(id, { id, label: id, role: null });
    return nodeMap.get(id);
  };
  const addEdge = (src, tgt) => {
    if (src === tgt) throw new Error(`Self-loop "${src} -> ${src}" is not allowed in a DAG.`);
    const key = src + '\u0000' + tgt;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ src, tgt });
  };
  const exposures = [], outcomes = [], adjusted = [];
  const applyAttrs = (id, text) => {
    const n = getNode(id);
    const keys = text.split(',').map(r => r.trim().split('=')[0].trim().toLowerCase());
    if (keys.includes('exposure')) { n.role = 'exposure'; if (!exposures.includes(id)) exposures.push(id); }
    else if (keys.includes('outcome')) { n.role = 'outcome'; if (!outcomes.includes(id)) outcomes.push(id); }
    else if (keys.includes('latent') || keys.includes('unobserved')) n.role = 'latent';
    if ((keys.includes('adjusted') || keys.includes('selected')) && !adjusted.includes(id)) adjusted.push(id);
  };

  // An operand is one node or a `{A B C}` group of nodes.
  const readOperand = () => {
    const tok = tokens[pos];
    if (tok?.t === 'id') { pos++; getNode(tok.v); return [tok.v]; }
    if (tok?.t === '{') {
      pos++;
      const ids = [];
      while (tokens[pos] && tokens[pos].t !== '}') {
        const inner = tokens[pos];
        if (inner.t === 'id') { getNode(inner.v); ids.push(inner.v); pos++; }
        else if (inner.t === 'attr' && ids.length) { applyAttrs(ids[ids.length - 1], inner.v); pos++; }
        else throw new Error('Only node names may appear inside a { … } group in the dagitty DSL.');
      }
      if (!tokens[pos]) throw new Error('Unclosed "{" group in the dagitty DSL.');
      pos++;
      if (!ids.length) throw new Error('Empty { } group in the dagitty DSL.');
      return ids;
    }
    return null;
  };

  // Attribute lists directly after a node are applied to it wherever they
  // appear (`X [exposure] -> Y [outcome]` is common in hand-written DSL).
  // applyAttrs only acts on node keywords, so edge attributes such as
  // `X -> Y [beta=0.5]` fall through untouched.
  const readOperandWithAttrs = () => {
    const ids = readOperand();
    if (!ids) return null;
    while (tokens[pos]?.t === 'attr') {
      if (ids.length === 1) applyAttrs(ids[0], tokens[pos].v);
      pos++;
    }
    return ids;
  };

  let latentCount = 0;
  while (pos < tokens.length) {
    const start = tokens[pos];
    if (start.t === 'id' && start.glued) {
      const prev = tokens[pos - 1].v;
      throw new Error(
        `"${prev} ${start.v}" looks like a node name containing a space. Quote it ("${prev} ${start.v}") ` +
        `or join it (${prev}_${start.v}); to declare two separate nodes, put them on separate lines or separate them with ";".`
      );
    }
    let left = readOperandWithAttrs();
    if (!left) {
      const shown = start.t === 'op' ? start.v : start.t === 'attr' ? `[${start.v}]` : start.t;
      throw new Error(`Unexpected "${shown}" in the dagitty DSL; expected a node name.`);
    }
    while (tokens[pos]?.t === 'op') {
      const op = tokens[pos++].v;
      const right = readOperandWithAttrs();
      if (!right) throw new Error(`Edge "${left.join(' ')} ${op}" in the dagitty DSL has no target node.`);
      for (const a of left) for (const b of right) {
        if (op === '->') addEdge(a, b);
        else if (op === '<-') addEdge(b, a);
        else if (op === '<->') {
          // Bidirected edge = unmeasured common cause. Make it explicit.
          let id;
          do { id = `U_${++latentCount}`; } while (nodeMap.has(id));
          const u = getNode(id);
          u.role = 'latent';
          u.label = `U (${a}, ${b})`;
          addEdge(id, a);
          addEdge(id, b);
          warnings.push(
            `Bidirected edge "${a} <-> ${b}" was converted to an explicit latent common cause "${id}" (${id} -> ${a}, ${id} -> ${b}).`
          );
        } else if (op === '--') {
          throw new Error(
            `Undirected edge "${a} -- ${b}" cannot be represented in a DAG. Give it a direction, or use <-> for an unmeasured common cause.`
          );
        } else {
          throw new Error(`Edge type "${op}" (PAG/MAG edge mark) is not supported; DAG Studio analyzes DAGs only.`);
        }
      }
      left = right;
    }
  }

  const nodeList = [...nodeMap.values()];
  if (!nodeList.length) throw new Error('The dagitty DSL defined no nodes.');
  if (exposures.length > 1) warnings.push(`Multiple exposures declared (${exposures.join(', ')}); only "${exposures[0]}" is used.`);
  if (outcomes.length > 1) warnings.push(`Multiple outcomes declared (${outcomes.join(', ')}); only "${outcomes[0]}" is used.`);
  if (adjusted.length) warnings.push(`[adjusted]/[selected] on ${adjusted.join(', ')} is not applied: the analysis does not condition on these nodes.`);
  return {
    nodes: nodeList,
    edges,
    exposure: exposures[0] || null,
    outcome: outcomes[0] || null,
    warnings
  };
}

// ─── Validation Suite (T01–T15) ─────────────────────────────────────────────

export const TESTS = [{
  id: 'T01',
  name: 'Full Mediation (X → M → Y)',
  category: 'Mediation',
  refs: [{
    cite: 'Textor et al. · IJE 2016',
    url: 'https://doi.org/10.1093/ije/dyw341'
  }],
  description: 'Pure mediation chain. No backdoor paths. Do NOT adjust for M.',
  nodes: [{
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'M',
    label: 'M',
    type: 'unclassified'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'X',
    tgt: 'M'
  }, {
    id: 'e2',
    src: 'M',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 0,
    adjSets: [[]]
  }
}, {
  id: 'T02',
  name: 'Classic Confounding',
  category: 'Confounding',
  refs: [{
    cite: 'Greenland et al. · Epidemiology 1999',
    url: 'https://doi.org/10.1097/00001648-199901000-00008'
  }, {
    cite: 'Textor et al. · IJE 2016',
    url: 'https://doi.org/10.1093/ije/dyw341'
  }],
  description: 'C is a common cause of X and Y. Adjust for C.',
  nodes: [{
    id: 'C',
    label: 'C',
    type: 'confounder'
  }, {
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'C',
    tgt: 'X'
  }, {
    id: 'e2',
    src: 'C',
    tgt: 'Y'
  }, {
    id: 'e3',
    src: 'X',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 1,
    adjSets: [['C']]
  }
}, {
  id: 'T03',
  name: 'Pure Fork / Spurious Association',
  category: 'Confounding',
  refs: [{
    cite: 'Pearl · Cambridge 2009',
    url: 'http://bayes.cs.ucla.edu/BOOK-2K/'
  }],
  description: 'C causes both X and Y. No direct X→Y. Entire association is spurious.',
  nodes: [{
    id: 'C',
    label: 'C',
    type: 'confounder'
  }, {
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'C',
    tgt: 'X'
  }, {
    id: 'e2',
    src: 'C',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 1,
    adjSets: [['C']]
  }
}, {
  id: 'T04',
  name: 'Simple Collider',
  category: 'Collider',
  refs: [{
    cite: 'Pearl · Cambridge 2009',
    url: 'http://bayes.cs.ucla.edu/BOOK-2K/'
  }],
  description: 'C is a collider. Do NOT condition on C.',
  nodes: [{
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }, {
    id: 'C',
    label: 'C',
    type: 'unclassified'
  }],
  edges: [{
    id: 'e1',
    src: 'X',
    tgt: 'Y'
  }, {
    id: 'e2',
    src: 'X',
    tgt: 'C'
  }, {
    id: 'e3',
    src: 'Y',
    tgt: 'C'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 0,
    adjSets: [[]]
  }
}, {
  id: 'T05',
  name: 'M-Bias',
  category: 'M-Bias',
  refs: [{
    cite: 'Greenland · Epidemiology 2003',
    url: 'https://doi.org/10.1097/01.EDE.0000042804.12056.6C'
  }, {
    cite: 'Textor et al. · IJE 2016',
    url: 'https://doi.org/10.1093/ije/dyw341'
  }],
  description: 'M is a collider blocking X←U1→M←U2→Y. Do NOT adjust for M.',
  nodes: [{
    id: 'U1',
    label: 'U1',
    type: 'latent'
  }, {
    id: 'U2',
    label: 'U2',
    type: 'latent'
  }, {
    id: 'M',
    label: 'M',
    type: 'confounder'
  }, {
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'U1',
    tgt: 'X'
  }, {
    id: 'e2',
    src: 'U1',
    tgt: 'M'
  }, {
    id: 'e3',
    src: 'U2',
    tgt: 'M'
  }, {
    id: 'e4',
    src: 'U2',
    tgt: 'Y'
  }, {
    id: 'e5',
    src: 'X',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 0,
    adjSets: [[]]
  }
}, {
  id: 'T06',
  name: 'Instrumental Variable',
  category: 'Instruments',
  refs: [{
    cite: 'Pearl · Cambridge 2009 §5.4',
    url: 'http://bayes.cs.ucla.edu/BOOK-2K/'
  }],
  description: 'U is unmeasured. No valid observed-variable adjustment set; IV estimator required.',
  nodes: [{
    id: 'IV',
    label: 'IV',
    type: 'unclassified'
  }, {
    id: 'U',
    label: 'U',
    type: 'latent'
  }, {
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'IV',
    tgt: 'X'
  }, {
    id: 'e2',
    src: 'U',
    tgt: 'X'
  }, {
    id: 'e3',
    src: 'U',
    tgt: 'Y'
  }, {
    id: 'e4',
    src: 'X',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 1,
    adjSets: [],
    noAdjPossible: true
  }
}, {
  id: 'T07',
  name: 'Two Confounders',
  category: 'Confounding',
  refs: [{
    cite: 'Pearl · Cambridge 2009 §3.3',
    url: 'http://bayes.cs.ucla.edu/BOOK-2K/'
  }],
  description: 'C1 and C2 each create separate backdoor paths. Adjust for both.',
  nodes: [{
    id: 'C1',
    label: 'C1',
    type: 'confounder'
  }, {
    id: 'C2',
    label: 'C2',
    type: 'confounder'
  }, {
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'C1',
    tgt: 'X'
  }, {
    id: 'e2',
    src: 'C1',
    tgt: 'Y'
  }, {
    id: 'e3',
    src: 'C2',
    tgt: 'X'
  }, {
    id: 'e4',
    src: 'C2',
    tgt: 'Y'
  }, {
    id: 'e5',
    src: 'X',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 2,
    adjSets: [['C1', 'C2']]
  }
}, {
  id: 'T08',
  name: 'Mediation with Confounder of Mediator',
  category: 'Mediation',
  refs: [{
    cite: 'VanderWeele · OUP 2015',
    url: 'https://global.oup.com/academic/product/explanation-in-causal-inference-9780199325870'
  }],
  description: 'C confounds M→Y but not X. No adjustment needed for total effect of X on Y.',
  nodes: [{
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'M',
    label: 'M',
    type: 'unclassified'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }, {
    id: 'C',
    label: 'C',
    type: 'confounder'
  }],
  edges: [{
    id: 'e1',
    src: 'X',
    tgt: 'M'
  }, {
    id: 'e2',
    src: 'M',
    tgt: 'Y'
  }, {
    id: 'e3',
    src: 'X',
    tgt: 'Y'
  }, {
    id: 'e4',
    src: 'C',
    tgt: 'M'
  }, {
    id: 'e5',
    src: 'C',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 0,
    adjSets: [[]]
  }
}, {
  id: 'T09',
  name: 'Selection Bias Structure',
  category: 'Selection Bias',
  refs: [{
    cite: 'Hernán et al. · Epidemiology 2004',
    url: 'https://doi.org/10.1097/01.ede.0000135174.63482.43'
  }],
  description: 'S is a selection collider. Do NOT condition on S.',
  nodes: [{
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }, {
    id: 'S',
    label: 'Selected',
    type: 'unclassified'
  }],
  edges: [{
    id: 'e1',
    src: 'X',
    tgt: 'Y'
  }, {
    id: 'e2',
    src: 'X',
    tgt: 'S'
  }, {
    id: 'e3',
    src: 'Y',
    tgt: 'S'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 0,
    adjSets: [[]]
  }
}, {
  id: 'T10',
  name: 'Frontdoor Criterion',
  category: 'Frontdoor',
  refs: [{
    cite: 'Pearl · Cambridge 2009 §3.4',
    url: 'http://bayes.cs.ucla.edu/BOOK-2K/'
  }],
  description: 'U is unmeasured. No backdoor-criterion set. Frontdoor criterion applies through M.',
  nodes: [{
    id: 'U',
    label: 'U',
    type: 'latent'
  }, {
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'M',
    label: 'M',
    type: 'unclassified'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'U',
    tgt: 'X'
  }, {
    id: 'e2',
    src: 'U',
    tgt: 'Y'
  }, {
    id: 'e3',
    src: 'X',
    tgt: 'M'
  }, {
    id: 'e4',
    src: 'M',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 1,
    adjSets: [],
    noAdjPossible: true
  }
}, {
  id: 'T11',
  name: 'Descendant of Exposure (Over-adjustment)',
  category: 'Over-adjustment',
  refs: [{
    cite: 'Schisterman et al. · Epidemiology 2009',
    url: 'https://doi.org/10.1097/EDE.0b013e3181a819a1'
  }],
  description: 'B is caused by X. Adjusting for B blocks the causal path. Adjust for C only.',
  nodes: [{
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'B',
    label: 'Biomarker',
    type: 'unclassified'
  }, {
    id: 'C',
    label: 'C',
    type: 'confounder'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'X',
    tgt: 'B'
  }, {
    id: 'e2',
    src: 'B',
    tgt: 'Y'
  }, {
    id: 'e3',
    src: 'X',
    tgt: 'Y'
  }, {
    id: 'e4',
    src: 'C',
    tgt: 'X'
  }, {
    id: 'e5',
    src: 'C',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 1,
    adjSets: [['C']]
  }
}, {
  id: 'T12',
  name: 'Competing Adjustment Sets',
  category: 'Confounding',
  refs: [{
    cite: 'Textor et al. · IJE 2016',
    url: 'https://doi.org/10.1093/ije/dyw341'
  }],
  description: 'Three open backdoor paths. Only {C1,C2} is minimal and valid.',
  nodes: [{
    id: 'C1',
    label: 'C1',
    type: 'confounder'
  }, {
    id: 'C2',
    label: 'C2',
    type: 'confounder'
  }, {
    id: 'C3',
    label: 'C3',
    type: 'confounder'
  }, {
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'C1',
    tgt: 'X'
  }, {
    id: 'e2',
    src: 'C1',
    tgt: 'Y'
  }, {
    id: 'e3',
    src: 'C2',
    tgt: 'X'
  }, {
    id: 'e4',
    src: 'C2',
    tgt: 'Y'
  }, {
    id: 'e5',
    src: 'C3',
    tgt: 'C1'
  }, {
    id: 'e6',
    src: 'C3',
    tgt: 'Y'
  }, {
    id: 'e7',
    src: 'X',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 3,
    adjSets: [['C1', 'C2']]
  }
}, {
  id: 'T13',
  name: 'Collider Descendant Opens Path',
  category: 'Collider',
  refs: [{
    cite: 'Pearl · Cambridge 2009 §1.2.3',
    url: 'http://bayes.cs.ucla.edu/BOOK-2K/'
  }],
  description: 'Conditioning on D (descendant of collider C) partially opens the collider path.',
  nodes: [{
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }, {
    id: 'C',
    label: 'C',
    type: 'unclassified'
  }, {
    id: 'D',
    label: 'D (desc)',
    type: 'unclassified'
  }],
  edges: [{
    id: 'e1',
    src: 'X',
    tgt: 'Y'
  }, {
    id: 'e2',
    src: 'X',
    tgt: 'C'
  }, {
    id: 'e3',
    src: 'Y',
    tgt: 'C'
  }, {
    id: 'e4',
    src: 'C',
    tgt: 'D'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 0,
    adjSets: [[]]
  }
}, {
  id: 'T14',
  name: 'Time-Varying Confounding',
  category: 'Time-Varying',
  refs: [{
    cite: 'Robins · Math Modelling 1986',
    url: 'https://doi.org/10.1016/0270-0255(86)90088-6'
  }, {
    cite: 'Textor et al. · IJE 2016',
    url: 'https://doi.org/10.1093/ije/dyw341'
  }],
  description: 'L is time-varying confounder affected by E1. Two open backdoor paths. Adjust for L.',
  nodes: [{
    id: 'E1',
    label: 'E1 (t1)',
    type: 'exposure'
  }, {
    id: 'L',
    label: 'L (t2)',
    type: 'confounder'
  }, {
    id: 'E2',
    label: 'E2 (t2)',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'E1',
    tgt: 'L'
  }, {
    id: 'e2',
    src: 'E1',
    tgt: 'E2'
  }, {
    id: 'e3',
    src: 'L',
    tgt: 'E2'
  }, {
    id: 'e4',
    src: 'L',
    tgt: 'Y'
  }, {
    id: 'e5',
    src: 'E2',
    tgt: 'Y'
  }],
  exp: 'E2',
  out: 'Y',
  expected: {
    backdoorCount: 2,
    adjSets: [['L']]
  }
}, {
  id: 'T15',
  name: 'Proxy / Surrogate Confounder',
  category: 'Confounding',
  refs: [{
    cite: 'Pearl · Cambridge 2009 §3.3.1',
    url: 'http://bayes.cs.ucla.edu/BOOK-2K/'
  }],
  description: 'U is unmeasured; P is a proxy caused by U. P does not block X←U→Y.',
  nodes: [{
    id: 'U',
    label: 'U',
    type: 'latent'
  }, {
    id: 'P',
    label: 'Proxy',
    type: 'confounder'
  }, {
    id: 'X',
    label: 'X',
    type: 'exposure'
  }, {
    id: 'Y',
    label: 'Y',
    type: 'outcome'
  }],
  edges: [{
    id: 'e1',
    src: 'U',
    tgt: 'X'
  }, {
    id: 'e2',
    src: 'U',
    tgt: 'Y'
  }, {
    id: 'e3',
    src: 'U',
    tgt: 'P'
  }, {
    id: 'e4',
    src: 'X',
    tgt: 'Y'
  }],
  exp: 'X',
  out: 'Y',
  expected: {
    backdoorCount: 1,
    adjSets: [],
    noAdjPossible: true
  }
}];

export function runTest(t) {
  const result = computeAdjustmentSets(t.exp, t.out, t.nodes, t.edges);
  const gotBackdoor = result?.backdoor?.length ?? 0;
  const gotSets = result?.sets ?? [];
  const sort = arr => [...arr].sort();
  const setsMatch = () => {
    const exp = t.expected.adjSets.map(s => sort(s).join(','));
    const got = gotSets.map(s => sort(s).join(','));
    return exp.length === got.length && exp.every(e => got.includes(e));
  };
  const backdoorOk = gotBackdoor === t.expected.backdoorCount;
  const setsOk = t.expected.noAdjPossible ? gotSets.length === 0 : setsMatch();
  return {
    pass: backdoorOk && setsOk,
    gotBackdoor,
    gotSets,
    backdoorOk,
    setsOk
  };
}

// ─── Effect Modification Test Suite (EM01–EM20) ─────────────────────────────
// Canonical structures from VanderWeele & Robins (2007) and Weinberg (2007).
// Priority: pure-interaction > indirect > common-cause > proxy > direct.

const _em = (id, name, src, desc, ns, es, ms, exp, out, expected) => ({
  id, name, source: src, description: desc,
  nodes: ns.map(([nid, label, type], i) => ({
    id: nid, label, type,
    x: 150 + 110 * (i % 4),
    y: 110 + 90 * Math.floor(i / 4)
  })),
  edges: es.map(([s, t]) => ({ src: s, tgt: t })),
  modifiers: ms.map(([s, idx]) => ({ src: s, tgtEdgeIdx: idx })),
  exp, out, expected
});

export const EM_TESTS = [
  _em('EM01', 'Direct (Baseline)', 'VanderWeele-Robins 2007 Fig 1a',
    'M is a pure effect modifier with no other graph relation to E or D.',
    [['e','E','exposure'],['d','D','outcome'],['m','M','modifier']],
    [['e','d']], [['m',0]], 'e', 'd', ['direct']),
  _em('EM02', 'Direct with Confounder', 'VanderWeele-Robins 2007 (variant)',
    'C confounds E→D. M is a direct modifier independent of C.',
    [['e','E','exposure'],['d','D','outcome'],['c','C','confounder'],['m','M','modifier']],
    [['e','d'],['c','e'],['c','d']], [['m',0]], 'e', 'd', ['direct']),
  _em('EM03', 'Direct with Mediator Chain', 'VanderWeele-Robins 2007 (variant)',
    'E→X→D mediation path. M is isolated from the E-D system.',
    [['e','E','exposure'],['d','D','outcome'],['x','X','unclassified'],['m','M','modifier']],
    [['e','d'],['e','x'],['x','d']], [['m',0]], 'e', 'd', ['direct']),
  _em('EM04', 'Direct with IV Structure', 'VanderWeele-Robins 2007 (variant)',
    'Z is an instrument for E; M is an isolated direct modifier.',
    [['e','E','exposure'],['d','D','outcome'],['z','Z','unclassified'],['m','M','modifier']],
    [['z','e'],['e','d']], [['m',1]], 'e', 'd', ['direct']),
  _em('EM05', 'Direct with Multiple Confounders', 'VanderWeele-Robins 2007 (variant)',
    'C1 and C2 both confound E→D; M is a direct modifier.',
    [['e','E','exposure'],['d','D','outcome'],['c1','C1','confounder'],['c2','C2','confounder'],['m','M','modifier']],
    [['e','d'],['c1','e'],['c1','d'],['c2','e'],['c2','d']], [['m',0]], 'e', 'd', ['direct']),
  _em('EM06', 'Indirect via Mediator', 'VanderWeele-Robins 2007 Fig 1b',
    'M causes a mediator X of the E→D effect.',
    [['e','E','exposure'],['d','D','outcome'],['x','X','unclassified'],['m','M','modifier']],
    [['e','x'],['x','d'],['m','x']], [['m',0]], 'e', 'd', ['indirect']),
  _em('EM07', 'Indirect Two-Step to Mediator', 'VanderWeele-Robins 2007 (variant)',
    'M causes Y, Y causes mediator X. Two-step indirect modification.',
    [['e','E','exposure'],['d','D','outcome'],['x','X','unclassified'],['y','Y','unclassified'],['m','M','modifier']],
    [['e','x'],['x','d'],['m','y'],['y','x']], [['m',0]], 'e', 'd', ['indirect']),
  _em('EM08', 'Indirect with Multiple Mediators', 'VanderWeele-Robins 2007 (variant)',
    'Two mediators X1 and X2; M causes X2.',
    [['e','E','exposure'],['d','D','outcome'],['x1','X1','unclassified'],['x2','X2','unclassified'],['m','M','modifier']],
    [['e','x1'],['x1','d'],['e','x2'],['x2','d'],['m','x2']], [['m',2]], 'e', 'd', ['indirect']),
  _em('EM09', 'Indirect via Long Mediation Path', 'VanderWeele-Robins 2007 (variant)',
    'E→X→Y→D sequential mediation; M causes X.',
    [['e','E','exposure'],['d','D','outcome'],['x','X','unclassified'],['y','Y','unclassified'],['m','M','modifier']],
    [['e','x'],['x','y'],['y','d'],['m','x']], [['m',0]], 'e', 'd', ['indirect']),
  _em('EM10', 'Indirect via Intermediate', 'VanderWeele-Robins 2007 (variant)',
    'M→Z→X; X is a mediator of E→D.',
    [['e','E','exposure'],['d','D','outcome'],['x','X','unclassified'],['z','Z','unclassified'],['m','M','modifier']],
    [['e','x'],['x','d'],['m','z'],['z','x']], [['m',0]], 'e', 'd', ['indirect']),
  _em('EM11', 'Proxy (Simple)', 'VanderWeele-Robins 2007 Fig 1c',
    'M has a proxy variable Mp that is observed.',
    [['e','E','exposure'],['d','D','outcome'],['m','M','modifier'],['mp','Mp','unclassified']],
    [['e','d'],['m','mp']], [['m',0]], 'e', 'd', ['proxy']),
  _em('EM12', 'Proxy with Multiple Descendants', 'VanderWeele-Robins 2007 (variant)',
    'M has two proxy variables, Mp1 and Mp2.',
    [['e','E','exposure'],['d','D','outcome'],['m','M','modifier'],['mp1','Mp1','unclassified'],['mp2','Mp2','unclassified']],
    [['e','d'],['m','mp1'],['m','mp2']], [['m',0]], 'e', 'd', ['proxy']),
  _em('EM13', 'Proxy with Confounding', 'VanderWeele-Robins 2007 (variant)',
    'C confounds E→D; M has a proxy Mp unrelated to the E-D system.',
    [['e','E','exposure'],['d','D','outcome'],['c','C','confounder'],['m','M','modifier'],['mp','Mp','unclassified']],
    [['e','d'],['c','e'],['c','d'],['m','mp']], [['m',0]], 'e', 'd', ['proxy']),
  _em('EM14', 'Proxy with IV Structure', 'VanderWeele-Robins 2007 (variant)',
    'Z is an instrument for E; M has a proxy Mp.',
    [['e','E','exposure'],['d','D','outcome'],['z','Z','unclassified'],['m','M','modifier'],['mp','Mp','unclassified']],
    [['z','e'],['e','d'],['m','mp']], [['m',1]], 'e', 'd', ['proxy']),
  _em('EM15', 'Common Cause (Simple)', 'VanderWeele-Robins 2007 Fig 1d',
    'C is a common cause of E and M; M modifies E→D.',
    [['e','E','exposure'],['d','D','outcome'],['c','C','confounder'],['m','M','modifier']],
    [['e','d'],['c','e'],['c','m']], [['m',0]], 'e', 'd', ['common-cause']),
  _em('EM16', 'Common Cause with Mediator', 'VanderWeele-Robins 2007 (variant)',
    'E→X→D mediation with C as common cause of E and M.',
    [['e','E','exposure'],['d','D','outcome'],['c','C','confounder'],['x','X','unclassified'],['m','M','modifier']],
    [['e','x'],['x','d'],['c','e'],['c','m']], [['m',0]], 'e', 'd', ['common-cause']),
  _em('EM17', 'Common Cause (Two-Step)', 'VanderWeele-Robins 2007 (variant)',
    'C causes Cp; Cp is a common ancestor of E and M.',
    [['e','E','exposure'],['d','D','outcome'],['c','C','confounder'],['cp','Cp','unclassified'],['m','M','modifier']],
    [['e','d'],['c','cp'],['cp','e'],['cp','m']], [['m',0]], 'e', 'd', ['common-cause']),
  _em('EM18', 'Pure Interaction (Weinberg)', 'Weinberg 2007 Fig 3',
    'M has a direct effect on D and also modifies E→D (pure joint effect).',
    [['e','E','exposure'],['d','D','outcome'],['m','M','modifier']],
    [['e','d'],['m','d']], [['m',0]], 'e', 'd', ['pure-interaction']),
  _em('EM19', 'Pure Interaction with Mediator', 'Weinberg 2007 (variant)',
    'M→D directly, alongside an E→X→D mediation path.',
    [['e','E','exposure'],['d','D','outcome'],['x','X','unclassified'],['m','M','modifier']],
    [['e','d'],['e','x'],['x','d'],['m','d']], [['m',0]], 'e', 'd', ['pure-interaction']),
  _em('EM20', 'Pure Interaction with Confounder', 'Weinberg 2007 (variant)',
    'M→D directly; C confounds the E→D relation.',
    [['e','E','exposure'],['d','D','outcome'],['c','C','confounder'],['m','M','modifier']],
    [['e','d'],['c','e'],['c','d'],['m','d']], [['m',0]], 'e', 'd', ['pure-interaction']),
];

export function runEMTest(t) {
  const edgesWithIds = t.edges.map((e, i) => ({ ...e, id: `_e${i}`, bend: 0 }));
  const modsWithIds = t.modifiers.map((m, i) => ({
    id: `_m${i}`,
    src: m.src,
    tgtEdge: `_e${m.tgtEdgeIdx}`,
    emType: null
  }));
  const result = classifyEffectModification(t.nodes, edgesWithIds, modsWithIds, t.exp, t.out);
  const got = result.map(r => r.emType);
  const pass = t.expected.every((exp, i) => got[i] === exp);
  return { pass, expected: t.expected, got };
}
