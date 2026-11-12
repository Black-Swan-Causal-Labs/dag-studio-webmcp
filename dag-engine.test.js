// Engine validation suite. Run with `node --test dag-engine.test.js`.
//
// Three layers:
//   1. T01–T15 backdoor / adjustment-set parity (runTest)
//   2. EM01–EM20 effect-modification classification parity (runEMTest)
//   3. simulateData byte-equivalence against the captured pre-refactor baseline
//      in dag-engine.simulate-baseline.json. The RNG refactor swapped global
//      Math.random replacement for an injected rng; this layer is what proves
//      the swap was numerically transparent.
//
// Only Node built-ins (node:test, node:assert, node:fs) — no external deps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  TESTS, runTest,
  EM_TESTS, runEMTest,
  simulateData,
  parseDagitty,
  generatePythonCode,
  generateRCode,
  hasCycle,
  computeAdjustmentSets, checkAdjustmentSet, dSeparated,
  structuralRole, detectTypeConflicts,
  ADJUSTMENT_ENUM_CAP,
} from './dag-engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ─── Layer 1: T01–T15 ────────────────────────────────────────────────────────

test('main suite: T01–T15 backdoor + adjustment-set parity', () => {
  const failed = [];
  for (const t of TESTS) {
    const r = runTest(t);
    if (!r.pass) failed.push({ id: t.id, name: t.name, expected: t.expected, got: { backdoor: r.gotBackdoor, sets: r.gotSets } });
  }
  assert.equal(TESTS.length, 15, 'expected 15 main-suite tests');
  assert.deepEqual(failed, [], `failed: ${failed.map(f => f.id).join(', ')}`);
});

// ─── Layer 2: EM01–EM20 ─────────────────────────────────────────────────────

test('effect-modification suite: EM01–EM20 classifier parity', () => {
  const failed = [];
  for (const t of EM_TESTS) {
    const r = runEMTest(t);
    if (!r.pass) failed.push({ id: t.id, name: t.name, expected: r.expected, got: r.got });
  }
  assert.equal(EM_TESTS.length, 20, 'expected 20 EM tests');
  assert.deepEqual(failed, [], `failed: ${failed.map(f => f.id).join(', ')}`);
});

// ─── Layer 3: simulateData numerical equivalence against pre-refactor baseline
//
// The baseline was captured on macOS arm64. Box-Muller calls Math.log, Math.sqrt,
// and Math.cos, none of which ECMA-262 mandates be bit-identical across libm
// implementations — macOS arm64 and Linux x64 can produce last-bit differences.
// Exact byte-equivalence is verified at refactor time on the platform where the
// baseline was captured (run `npm run test:engine` locally on macOS to confirm
// MAX_DELTA == 0). CI is a regression check: the worst-case |delta| must stay
// inside SIM_TOLERANCE — anything larger means the RNG refactor or downstream
// arithmetic actually changed behavior, not just last-bit libm noise.

const SIM_TOLERANCE = 1e-12;

test('simulateData: numerical equivalence (tolerance ≤ 1e-12) against pre-refactor baseline', () => {
  const baseline = JSON.parse(readFileSync(join(HERE, 'dag-engine.simulate-baseline.json'), 'utf8'));

  // The DAG fixtures and seeds must match capture-baseline.mjs exactly.
  const DAGS = {
    T01_mediation: {
      nodes: [{ id: 'X' }, { id: 'M' }, { id: 'Y' }],
      edges: [{ src: 'X', tgt: 'M' }, { src: 'M', tgt: 'Y' }]
    },
    T02_confounding: {
      nodes: [{ id: 'C' }, { id: 'X' }, { id: 'Y' }],
      edges: [{ src: 'C', tgt: 'X' }, { src: 'C', tgt: 'Y' }, { src: 'X', tgt: 'Y' }]
    },
    T05_mbias: {
      nodes: [{ id: 'U1' }, { id: 'U2' }, { id: 'M' }, { id: 'X' }, { id: 'Y' }],
      edges: [
        { src: 'U1', tgt: 'X' }, { src: 'U1', tgt: 'M' },
        { src: 'U2', tgt: 'M' }, { src: 'U2', tgt: 'Y' },
        { src: 'X', tgt: 'Y' }
      ]
    }
  };
  const SEEDS = baseline._meta.seeds;
  const N = baseline._meta.n;

  let maxDelta = 0;
  let worst = null;

  const compareRow = (got, exp, label) => {
    for (const key of Object.keys(exp)) {
      const a = got[key], b = exp[key];
      if (typeof a !== 'number' || typeof b !== 'number') {
        assert.equal(a, b, `${label}.${key}: non-numeric drift`);
        continue;
      }
      const delta = Math.abs(a - b);
      if (delta > maxDelta) { maxDelta = delta; worst = { label, key, a, b, delta }; }
    }
  };

  const compareResult = (got, exp, name) => {
    assert.deepEqual(got.order, exp.order, `${name}: topological order drifted`);
    assert.equal(got.data.length, exp.data.length, `${name}: row count drifted`);
    for (let i = 0; i < got.data.length; i++) {
      compareRow(got.data[i], exp.data[i], `${name}[row=${i}]`);
    }
  };

  for (const [name, dag] of Object.entries(DAGS)) {
    for (const seed of SEEDS) {
      const got = simulateData(dag.nodes, dag.edges, N, seed);
      compareResult(got, baseline[name][`seed_${seed}`], `${name} seed=${seed}`);
    }
  }

  // Coefficient-override path
  const got = simulateData(
    DAGS.T02_confounding.nodes,
    DAGS.T02_confounding.edges,
    N,
    42,
    { 'C->X': 0.3, 'C->Y': 0.7, 'X->Y': 0.9 }
  );
  compareResult(got, baseline.coefs_override, 'coefs_override seed=42');

  assert.ok(
    maxDelta <= SIM_TOLERANCE,
    `worst-case |delta| = ${maxDelta} exceeds SIM_TOLERANCE = ${SIM_TOLERANCE}` +
    (worst ? ` at ${worst.label}.${worst.key} (got ${worst.a}, expected ${worst.b})` : '')
  );
});

// ─── Smoke checks: parser + code generators ─────────────────────────────────
// Not part of the canonical concordance suites but cheap insurance against
// silly extraction mistakes (e.g., regex literal corruption).

test('parseDagitty: trivial round-trip', () => {
  const dsl = `dagitty('dag { X [exposure]; Y [outcome]; X -> Y; C -> X; C -> Y }')`;
  const dag = parseDagitty(dsl);
  assert.equal(dag.exposure, 'X');
  assert.equal(dag.outcome, 'Y');
  assert.equal(dag.nodes.length, 3);
  assert.equal(dag.edges.length, 3);
});

test('hasCycle: distinguishes acyclic and cyclic graphs', () => {
  // Acyclic: T01 mediation, T02 confounding
  assert.equal(hasCycle(TESTS[0].nodes, TESTS[0].edges), false);
  assert.equal(hasCycle(TESTS[1].nodes, TESTS[1].edges), false);
  // Empty graph
  assert.equal(hasCycle([], []), false);
  // 3-node cycle
  assert.equal(
    hasCycle(
      [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      [{ src: 'A', tgt: 'B' }, { src: 'B', tgt: 'C' }, { src: 'C', tgt: 'A' }]
    ),
    true
  );
  // Self-loop
  assert.equal(hasCycle([{ id: 'X' }], [{ src: 'X', tgt: 'X' }]), true);
  // Edge to unknown node: NOT a cycle (different malformation)
  assert.equal(
    hasCycle([{ id: 'A' }], [{ src: 'A', tgt: 'B' }]),
    false
  );
});

test('generatePythonCode + generateRCode: produce non-empty output for a real DAG', () => {
  const dag = TESTS[1]; // T02 classic confounding
  const py = generatePythonCode(dag.nodes, dag.edges, dag.exp, dag.out);
  const r = generateRCode(dag.nodes.map(n => ({ ...n, x: 100, y: 100 })), dag.edges, dag.exp, dag.out);
  assert.match(py, /import networkx as nx/);
  assert.match(py, /dag\.add_edges_from/);
  assert.match(r, /library\(dagitty\)/);
  assert.match(r, /dag <- dagitty/);
});

// ─── Regression: parser must never drop a statement silently ────────────────
// Each of these used to parse "successfully" while discarding the construct,
// which changed the causal claim and therefore the adjustment sets.

const edgeList = dag => dag.edges.map(e => `${e.src}>${e.tgt}`).sort();
const asNodes = dag => dag.nodes.map(n => ({ id: n.id, label: n.label, type: n.role || 'unclassified' }));

test('parseDagitty: <-> becomes an explicit latent common cause', () => {
  const dag = parseDagitty(`dagitty('dag { X [exposure]; Y [outcome]; X -> Y; X <-> Y }')`);
  const latent = dag.nodes.filter(n => n.role === 'latent');
  assert.equal(latent.length, 1);
  assert.deepEqual(edgeList(dag), [`${latent[0].id}>X`, `${latent[0].id}>Y`, 'X>Y'].sort());
  assert.equal(dag.warnings.length, 1);
  // The whole point: unmeasured confounding must make the effect unidentifiable
  // by adjustment, not "identifiable with the empty set".
  const res = computeAdjustmentSets(dag.exposure, dag.outcome, asNodes(dag), dag.edges);
  assert.deepEqual(res.sets, []);
});

test('parseDagitty: {A B} groups expand to every pairwise edge', () => {
  const dag = parseDagitty('dag { X [exposure]; Y [outcome]; A -> {X Y}; {B C} -> X; X -> Y }');
  assert.deepEqual(edgeList(dag), ['A>X', 'A>Y', 'B>X', 'C>X', 'X>Y']);
  const res = computeAdjustmentSets('X', 'Y', asNodes(dag), dag.edges);
  assert.deepEqual(res.sets, [['A']]);
});

test('parseDagitty: quoted names, bare dag { }, one-line and dagitty.net layouts', () => {
  const quoted = parseDagitty('dag { "Body Mass Index" -> Y [outcome]; X [exposure] -> Y }');
  assert.ok(quoted.nodes.some(n => n.id === 'Body Mass Index'));
  assert.deepEqual(edgeList(quoted), ['Body Mass Index>Y', 'X>Y']);
  assert.equal(quoted.exposure, 'X');
  assert.equal(quoted.outcome, 'Y');

  const escaped = parseDagitty('dagitty("dag { \\"Body Mass\\" -> Y }")');
  assert.deepEqual(edgeList(escaped), ['Body Mass>Y']);

  const oneLine = parseDagitty('dag { X [exposure] Y [outcome] C -> X; C -> Y; X -> Y }');
  assert.deepEqual(edgeList(oneLine), ['C>X', 'C>Y', 'X>Y']);

  const exported = parseDagitty(
    'dag {\nbb="0,0,1,1"\nC [pos="0.5,0.1"]\nU [latent,pos="0.2,0.2"]\nX [exposure,pos="0.1,0.5"]\n' +
    'Y [outcome,pos="0.9,0.5"]\nC -> X\nC -> Y [beta=0.3]\nU -> X # unmeasured\nX -> Y\n}'
  );
  assert.deepEqual(edgeList(exported), ['C>X', 'C>Y', 'U>X', 'X>Y']);
  assert.equal(exported.nodes.find(n => n.id === 'U').role, 'latent');
  assert.equal(exported.nodes.length, 4);
});

test('parseDagitty: unrepresentable or malformed input throws instead of being skipped', () => {
  assert.throws(() => parseDagitty('dag { X -- Y }'), /Undirected edge/);
  assert.throws(() => parseDagitty('dag { X @-> Y }'), /not supported/);
  assert.throws(() => parseDagitty('dag { X -> }'), /no target node/);
  assert.throws(() => parseDagitty('dag { X -> Y'), /closing/);
  assert.throws(() => parseDagitty('dag { X -> X }'), /Self-loop/);
  assert.throws(() => parseDagitty('dag { X -> Y ; $ }'), /Unexpected character/);
  assert.throws(() => parseDagitty('just some text'), /Could not find a dagitty graph/);
  // Unquoted multi-word name: must not be read as an isolated "Lung" plus "Cancer -> Death".
  assert.throws(() => parseDagitty('dag { Lung Cancer -> Death }'), /containing a space/);
  assert.throws(() => parseDagitty('dag { Smoking -> Lung Cancer }'), /containing a space/);
});

test('parseDagitty: [adjusted] is reported, not silently ignored', () => {
  const dag = parseDagitty('dag { X [exposure]; Y [outcome]; S [adjusted]; X -> S <- Y }');
  assert.ok(dag.warnings.some(w => /adjusted/.test(w)));
});

// ─── Regression: adjustment sets beyond the enumeration cap ─────────────────

test('computeAdjustmentSets: many irrelevant covariates never hide the valid set', () => {
  // 20 causes of Y that are not on any backdoor path, declared BEFORE the one
  // real confounder. The old first-12-candidates cap returned "no valid set".
  const nodes = [{ id: 'X', type: 'exposure' }, { id: 'Y', type: 'outcome' }];
  const edges = [{ src: 'X', tgt: 'Y' }];
  for (let i = 0; i < 20; i++) { nodes.push({ id: `n${i}`, type: 'variable' }); edges.push({ src: `n${i}`, tgt: 'Y' }); }
  nodes.push({ id: 'C', type: 'variable' });
  edges.push({ src: 'C', tgt: 'X' }, { src: 'C', tgt: 'Y' });
  const res = computeAdjustmentSets('X', 'Y', nodes, edges);
  assert.ok(res.truncated.candidates, 'expected the listing to be flagged incomplete');
  assert.deepEqual(res.sets, [['C']]);
});

test('computeAdjustmentSets: above the cap, existence is exact and every set is valid and irreducible', () => {
  // k independent confounders, k > cap: the only valid set is all of them.
  const k = ADJUSTMENT_ENUM_CAP + 5;
  const nodes = [{ id: 'X', type: 'exposure' }, { id: 'Y', type: 'outcome' }];
  const edges = [{ src: 'X', tgt: 'Y' }];
  for (let i = 0; i < k; i++) {
    nodes.push({ id: `c${i}`, type: 'variable' });
    edges.push({ src: `c${i}`, tgt: 'X' }, { src: `c${i}`, tgt: 'Y' });
  }
  const res = computeAdjustmentSets('X', 'Y', nodes, edges);
  assert.equal(res.sets.length, 1);
  assert.equal(res.sets[0].length, k);

  // Make one of them latent: now no valid set exists, and that must be exact.
  nodes[2] = { id: 'c0', type: 'latent' };
  assert.deepEqual(computeAdjustmentSets('X', 'Y', nodes, edges).sets, []);

  // Two interchangeable blockers per backdoor path (c_i -> m_i -> X): several
  // minimal sets exist; each returned one must block and be irreducible.
  const n2 = [{ id: 'X' }, { id: 'Y' }];
  const e2 = [{ src: 'X', tgt: 'Y' }];
  for (let i = 0; i < 10; i++) {
    n2.push({ id: `c${i}` }, { id: `m${i}` });
    e2.push({ src: `c${i}`, tgt: `m${i}` }, { src: `m${i}`, tgt: 'X' }, { src: `c${i}`, tgt: 'Y' });
  }
  const r2 = computeAdjustmentSets('X', 'Y', n2, e2);
  assert.ok(r2.truncated.candidates);
  assert.ok(r2.sets.length >= 2);
  const bd = e2.filter(e => e.src !== 'X');
  for (const Z of r2.sets) {
    assert.equal(Z.length, 10);
    assert.ok(dSeparated('X', 'Y', Z, bd));
    for (const z of Z) assert.ok(!dSeparated('X', 'Y', Z.filter(v => v !== z), bd), `${z} is removable`);
  }
});

test('computeAdjustmentSets: matches brute force over all subsets on random DAGs', () => {
  // Independent oracle: enumerate every subset of eligible nodes and test the
  // backdoor criterion directly, then keep the inclusion-minimal ones.
  let seed = 20261112;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let it = 0; it < 300; it++) {
    const V = 4 + Math.floor(rnd() * 5);
    const ids = Array.from({ length: V }, (_, i) => `v${i}`);
    const order = [...ids].sort(() => rnd() - 0.5);
    const edges = [];
    for (let i = 0; i < V; i++) for (let j = i + 1; j < V; j++) if (rnd() < 0.35) edges.push({ src: order[i], tgt: order[j] });
    const exp = ids[0], out = ids[1];
    const nodes = ids.map(id => ({ id, type: id !== exp && id !== out && rnd() < 0.15 ? 'latent' : 'variable' }));
    const desc = new Set(); { const q = [exp]; while (q.length) { const c = q.pop(); for (const e of edges) if (e.src === c && !desc.has(e.tgt)) { desc.add(e.tgt); q.push(e.tgt); } } }
    const elig = nodes.filter(n => n.id !== exp && n.id !== out && n.type !== 'latent' && !desc.has(n.id)).map(n => n.id);
    const bd = edges.filter(e => e.src !== exp);
    const valid = [];
    for (let mask = 0; mask < 1 << elig.length; mask++) {
      const Z = elig.filter((_, i) => mask & 1 << i);
      if (dSeparated(exp, out, Z, bd)) valid.push(Z);
    }
    const minimal = valid.filter(s => !valid.some(o => o.length < s.length && o.every(x => s.includes(x))));
    const key = sets => sets.map(z => [...z].sort().join(',')).sort().join(' | ');
    const got = computeAdjustmentSets(exp, out, nodes, edges);
    assert.equal(key(got.sets), key(minimal), `iteration ${it}`);
  }
});

test('checkAdjustmentSet: sufficiency and descendant-of-exposure are both required', () => {
  const nodes = [{ id: 'X' }, { id: 'Y' }, { id: 'C' }, { id: 'M' }, { id: 'U', type: 'latent' }];
  const edges = [
    { src: 'C', tgt: 'X' }, { src: 'C', tgt: 'Y' },
    { src: 'X', tgt: 'M' }, { src: 'M', tgt: 'Y' },
  ];
  assert.equal(checkAdjustmentSet('X', 'Y', [], nodes, edges).valid, false);            // open backdoor
  assert.equal(checkAdjustmentSet('X', 'Y', ['C'], nodes, edges).valid, true);
  const med = checkAdjustmentSet('X', 'Y', ['C', 'M'], nodes, edges);                   // mediator
  assert.equal(med.blocksBackdoor, true);
  assert.deepEqual(med.descendantsOfExposure, ['M']);
  assert.equal(med.valid, false);
});

// ─── Regression: instrument vs confounder ───────────────────────────────────

test('structuralRole: an ancestor of the exposure that reaches the outcome only through it is an instrument', () => {
  const edges = [
    { src: 'Z', tgt: 'X' }, { src: 'X', tgt: 'Y' },
    { src: 'C', tgt: 'X' }, { src: 'C', tgt: 'Y' },
    { src: 'A', tgt: 'C' },                       // confounder via C, not via X
    { src: 'X', tgt: 'M' }, { src: 'M', tgt: 'Y' },
  ];
  assert.equal(structuralRole('Z', 'X', 'Y', edges), 'instrument');
  assert.equal(structuralRole('C', 'X', 'Y', edges), 'confounder');
  assert.equal(structuralRole('A', 'X', 'Y', edges), 'confounder');
  assert.equal(structuralRole('M', 'X', 'Y', edges), 'mediator');
  const conflicts = detectTypeConflicts(
    [{ id: 'Z', label: 'Z', type: 'confounder' }, { id: 'C', label: 'C', type: 'confounder' }],
    edges, 'X', 'Y'
  );
  assert.deepEqual(conflicts.map(c => c.nodeId), ['Z']);
});
