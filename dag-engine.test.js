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
