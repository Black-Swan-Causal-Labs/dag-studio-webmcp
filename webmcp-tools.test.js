import assert from 'node:assert/strict';
import test from 'node:test';
import { createDagStudioTools, registerDagStudioWebMCP, WEBMCP_TOOL_NAMES } from './webmcp-tools.js';

function harness() {
  const nodesRef = { current: [
    { id: 'x', label: 'Treatment', type: 'exposure', x: 100, y: 200 },
    { id: 'y', label: 'Outcome', type: 'outcome', x: 500, y: 200 },
    { id: 'c', label: 'Baseline risk', type: 'confounder', x: 300, y: 80 },
  ] };
  const edgesRef = { current: [
    { id: 'e1', src: 'c', tgt: 'x', bend: 0 },
    { id: 'e2', src: 'c', tgt: 'y', bend: 0 },
    { id: 'e3', src: 'x', tgt: 'y', bend: 0 },
  ] };
  const exposureRef = { current: 'x' };
  const outcomeRef = { current: 'y' };
  const snapshots = [];
  const changes = [];
  const simulations = [];
  let edgeNumber = 3;
  const apply = (ref, update) => { ref.current = typeof update === 'function' ? update(ref.current) : update; };

  const options = {
    nodesRef,
    edgesRef,
    exposureRef,
    outcomeRef,
    snapshot: () => snapshots.push({ nodes: nodesRef.current, edges: edgesRef.current }),
    setNodes: update => apply(nodesRef, update),
    setEdges: update => apply(edgesRef, update),
    setExposure: value => { exposureRef.current = value; },
    setOutcome: value => { outcomeRef.current = value; },
    createEdgeId: () => `e${++edgeNumber}`,
    onAgentChange: (...change) => changes.push(change),
    onSimulation: simulation => simulations.push(simulation),
  };
  return { nodesRef, edgesRef, exposureRef, outcomeRef, snapshots, changes, simulations, options };
}

const parsed = result => JSON.parse(result.content[0].text);
const byName = tools => Object.fromEntries(tools.map(tool => [tool.name, tool]));

test('registers exactly the nine Challenge tools', async () => {
  const registered = [];
  const modelContext = { registerTool: async tool => registered.push(tool) };
  const tools = await registerDagStudioWebMCP(modelContext, harness().options);
  assert.deepEqual(tools.map(tool => tool.name), WEBMCP_TOOL_NAMES);
  assert.deepEqual(registered.map(tool => tool.name), WEBMCP_TOOL_NAMES);
});

test('simulation tool is reproducible, bounded, and updates the visible simulation state', async () => {
  const state = harness();
  const tools = byName(createDagStudioTools(state.options));
  const input = {
    run_label: 'Hypothesis A',
    sample_size: 1000,
    seed: 42,
    edge_coefficients: { 'x->y': 0.75 },
  };

  const first = parsed(await tools.simulate_current_dag.execute(input));
  const second = parsed(await tools.simulate_current_dag.execute(input));

  assert.equal(first.run_label, 'Hypothesis A');
  assert.equal(first.simulation.sample_size, 1000);
  assert.equal(first.simulation.seed, 42);
  assert.equal(first.simulation.edge_coefficients['x->y'], 0.75);
  assert.equal(first.effect_estimates.true_total_effect, 0.75);
  assert.deepEqual(first.effect_estimates.minimally_adjusted_ols.adjustment_set, ['c']);
  assert.equal(first.preview.length, 10);
  assert.deepEqual(first.preview, second.preview);
  assert.deepEqual(first.variable_summaries, second.variable_summaries);
  assert.equal(state.simulations.length, 2);
  assert.equal(state.simulations[0].data.length, 1000);
  assert.equal(state.simulations[0].runLabel, 'Hypothesis A');
  assert.match(state.changes[0][0], /Hypothesis A/);
});

test('simulation tool rejects unsupported inputs and unknown coefficient edges', () => {
  const tools = byName(createDagStudioTools(harness().options));
  assert.throws(
    () => tools.simulate_current_dag.execute({ sample_size: 250 }),
    /Sample size must be one of/,
  );
  assert.throws(
    () => tools.simulate_current_dag.execute({ edge_coefficients: { 'missing->y': 0.5 } }),
    /is not an edge/,
  );
});

test('simulation summaries distinguish direct-plus-mediated and mediated-only hypotheses', () => {
  const directAndMediated = harness();
  directAndMediated.nodesRef.current.splice(2, 0, {
    id: 'm', label: 'Mediator', type: 'mediator', x: 300, y: 200,
  });
  directAndMediated.edgesRef.current.push(
    { id: 'e4', src: 'x', tgt: 'm', bend: 0 },
    { id: 'e5', src: 'm', tgt: 'y', bend: 0 },
  );
  const directTools = byName(createDagStudioTools(directAndMediated.options));
  const directResult = parsed(directTools.simulate_current_dag.execute({
    run_label: 'Direct and mediated', sample_size: 1000, seed: 42,
  }));

  const mediatedOnly = harness();
  mediatedOnly.nodesRef.current.splice(2, 0, {
    id: 'm', label: 'Mediator', type: 'mediator', x: 300, y: 200,
  });
  mediatedOnly.edgesRef.current = mediatedOnly.edgesRef.current
    .filter(edge => !(edge.src === 'x' && edge.tgt === 'y'))
    .concat(
      { id: 'e4', src: 'x', tgt: 'm', bend: 0 },
      { id: 'e5', src: 'm', tgt: 'y', bend: 0 },
    );
  const mediatedTools = byName(createDagStudioTools(mediatedOnly.options));
  const mediatedResult = parsed(mediatedTools.simulate_current_dag.execute({
    run_label: 'Mediated only', sample_size: 1000, seed: 42,
  }));

  assert.equal(directResult.effect_estimates.true_total_effect, 0.75);
  assert.equal(mediatedResult.effect_estimates.true_total_effect, 0.25);
  assert.equal(directResult.simulation.seed, mediatedResult.simulation.seed);
  assert.equal(directResult.simulation.sample_size, mediatedResult.simulation.sample_size);
});

test('agent mutations and human canvas mutations share the same state', async () => {
  const state = harness();
  const tools = byName(createDagStudioTools(state.options));

  parsed(await tools.add_node.execute({ id: 'smoking', label: 'Smoking Status', type: 'confounder', x: 220, y: 120 }));
  parsed(await tools.add_edge.execute({ source: 'smoking', target: 'x' }));
  parsed(await tools.add_edge.execute({ source: 'smoking', target: 'y' }));

  assert.equal(state.nodesRef.current.find(node => node.id === 'smoking').label, 'Smoking Status');
  assert.ok(state.edgesRef.current.some(edge => edge.src === 'smoking' && edge.tgt === 'x'));
  assert.ok(state.edgesRef.current.some(edge => edge.src === 'smoking' && edge.tgt === 'y'));
  assert.equal(state.snapshots.length, 3);
  assert.equal(state.changes.length, 3);

  // Simulate a human dragging the same node on the canvas.
  state.options.setNodes(nodes => nodes.map(node => node.id === 'smoking' ? { ...node, x: 777, y: 333 } : node));
  const current = parsed(await tools.get_current_dag.execute({}));
  assert.deepEqual(current.nodes.find(node => node.id === 'smoking'), {
    id: 'smoking', label: 'Smoking Status', type: 'confounder', x: 777, y: 333,
  });
});

test('remove operations update the same graph and reject cycles', async () => {
  const state = harness();
  const tools = byName(createDagStudioTools(state.options));
  assert.throws(() => tools.add_edge.execute({ source: 'y', target: 'c' }), /directed cycle/);
  parsed(await tools.remove_edge.execute({ source: 'c', target: 'x' }));
  assert.ok(!state.edgesRef.current.some(edge => edge.src === 'c' && edge.tgt === 'x'));
  parsed(await tools.remove_node.execute({ id: 'c' }));
  assert.ok(!state.nodesRef.current.some(node => node.id === 'c'));
  assert.ok(!state.edgesRef.current.some(edge => edge.src === 'c' || edge.tgt === 'c'));
});

test('analysis, adjustment checking, and code generation use the existing engine', async () => {
  const tools = byName(createDagStudioTools(harness().options));
  const analysis = parsed(await tools.analyze_current_dag.execute({}));
  assert.ok(analysis.open_backdoor_paths.length > 0);
  assert.ok(analysis.minimal_sufficient_adjustment_sets.some(set => set.includes('c')));
  assert.equal(parsed(await tools.check_adjustment_set.execute({ adjustment_set: ['c'] })).valid, true);
  assert.match(parsed(await tools.generate_analysis_code.execute({ language: 'python' })).code, /networkx/);
  assert.match(parsed(await tools.generate_analysis_code.execute({ language: 'r' })).code, /dagitty/);
});
