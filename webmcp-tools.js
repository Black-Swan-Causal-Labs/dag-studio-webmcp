import {
  computeAdjustmentSets,
  detectTypeConflicts,
  dSeparated,
  computeCorrelation,
  computeOLSCoefficients,
  computeTrueEffect,
  generatePythonCode,
  generateRCode,
  hasCycle,
  simulateData,
} from './dag-engine.js';

export const WEBMCP_TOOL_NAMES = [
  'get_current_dag',
  'add_node',
  'remove_node',
  'add_edge',
  'remove_edge',
  'analyze_current_dag',
  'check_adjustment_set',
  'generate_analysis_code',
  'simulate_current_dag',
];

const SIMULATION_SAMPLE_SIZES = [100, 500, 1000, 2500, 5000, 10000];
const DEFAULT_EDGE_COEFFICIENT = 0.5;
const ERROR_STANDARD_DEVIATION = 0.5;
const PREVIEW_ROWS = 10;
const MAX_CORRELATION_MATRIX_NODES = 20;

const schema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

const textResult = value => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

const rounded = value => {
  if (!Number.isFinite(value)) return null;
  const result = Number(value.toFixed(6));
  return Object.is(result, -0) ? 0 : result;
};

function summarizeSimulation(data, order, nodeMap) {
  const values = Object.fromEntries(order.map(id => [id, data.map(row => row[id])]));
  const variableSummaries = order.map(id => {
    const series = values[id];
    const mean = series.reduce((sum, value) => sum + value, 0) / series.length;
    const variance = series.reduce((sum, value) => sum + (value - mean) ** 2, 0) / series.length;
    return {
      id,
      label: nodeMap[id]?.label || id,
      mean: rounded(mean),
      standard_deviation: rounded(Math.sqrt(variance)),
    };
  });

  const correlationMatrix = order.length <= MAX_CORRELATION_MATRIX_NODES
    ? Object.fromEntries(order.map(rowId => [
        rowId,
        Object.fromEntries(order.map(columnId => [
          columnId,
          rounded(computeCorrelation(values[rowId], values[columnId])),
        ])),
      ]))
    : null;

  return {
    variable_summaries: variableSummaries,
    correlation_matrix: correlationMatrix,
    correlation_matrix_note: correlationMatrix
      ? null
      : `Omitted because the DAG has more than ${MAX_CORRELATION_MATRIX_NODES} variables.`,
  };
}

export function createDagStudioTools({
  nodesRef,
  edgesRef,
  exposureRef,
  outcomeRef,
  snapshot,
  setNodes,
  setEdges,
  setExposure,
  setOutcome,
  getCanvasRect = () => null,
  createEdgeId = () => `webmcp-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  onAgentChange = () => {},
  onSimulation = () => {},
}) {
  const currentDag = () => ({
    nodes: nodesRef.current,
    edges: edgesRef.current,
    exposure: exposureRef.current || null,
    outcome: outcomeRef.current || null,
  });

  const ensureNode = id => {
    if (!nodesRef.current.some(node => node.id === id)) {
      throw new Error(`Node '${id}' does not exist in the current DAG.`);
    }
  };

  return [
    {
      name: 'get_current_dag',
      description: 'Read the exact causal DAG currently visible in DAG Studio, including node roles, canvas positions, edges, exposure, and outcome.',
      inputSchema: schema(),
      annotations: { readOnlyHint: true },
      execute: () => textResult(currentDag()),
    },
    {
      name: 'add_node',
      description: 'Add a researcher-reviewable variable to the live DAG Studio canvas. Use unclassified when the scientific role is uncertain. The change is visibly attributed to the agent and can be undone.',
      inputSchema: schema({
        id: { type: 'string' },
        label: { type: 'string' },
        type: { type: 'string', enum: ['exposure', 'outcome', 'confounder', 'mediator', 'collider', 'latent', 'variable', 'unclassified'] },
        x: { type: 'number' },
        y: { type: 'number' },
      }, ['id', 'label']),
      execute: input => {
        if (!input.id.trim() || !input.label.trim()) throw new Error('Node id and label are required.');
        if (nodesRef.current.some(node => node.id === input.id)) throw new Error(`Node '${input.id}' already exists.`);
        snapshot();
        const rect = getCanvasRect();
        const node = {
          id: input.id,
          label: input.label,
          type: input.type || 'unclassified',
          x: input.x ?? (rect ? rect.width / 2 : 420),
          y: input.y ?? (rect ? rect.height / 2 : 280),
        };
        setNodes(previous => [...previous, node]);
        if (node.type === 'exposure') {
          exposureRef.current = node.id;
          setExposure(node.id);
        }
        if (node.type === 'outcome') {
          outcomeRef.current = node.id;
          setOutcome(node.id);
        }
        onAgentChange(`Agent added variable “${node.label}”`, [node.id], []);
        return textResult({
          ok: true,
          action: 'added_node',
          node,
          dag: currentDag(),
          caveat: 'This encodes an assumption for researcher review; it does not establish scientific truth.',
        });
      },
    },
    {
      name: 'remove_node',
      description: 'Remove a variable and its incident edges from the live canvas. The agent change is visible and undoable.',
      inputSchema: schema({ id: { type: 'string' } }, ['id']),
      execute: ({ id }) => {
        ensureNode(id);
        snapshot();
        const removedEdges = edgesRef.current.filter(edge => edge.src === id || edge.tgt === id).map(edge => edge.id);
        setNodes(previous => previous.filter(node => node.id !== id));
        setEdges(previous => previous.filter(edge => edge.src !== id && edge.tgt !== id));
        if (exposureRef.current === id) {
          exposureRef.current = '';
          setExposure('');
        }
        if (outcomeRef.current === id) {
          outcomeRef.current = '';
          setOutcome('');
        }
        onAgentChange(`Agent removed variable “${id}”`, [id], removedEdges);
        return textResult({ ok: true, action: 'removed_node', id });
      },
    },
    {
      name: 'add_edge',
      description: 'Add a directed causal claim to the live DAG. Duplicate and cyclic edges are rejected. The visible change is undoable.',
      inputSchema: schema({ source: { type: 'string' }, target: { type: 'string' } }, ['source', 'target']),
      execute: ({ source, target }) => {
        ensureNode(source);
        ensureNode(target);
        if (source === target) throw new Error('Self edges are not allowed.');
        if (edgesRef.current.some(edge => edge.src === source && edge.tgt === target)) throw new Error(`Edge '${source}->${target}' already exists.`);
        const edge = { id: createEdgeId(), src: source, tgt: target, bend: 0 };
        if (hasCycle(nodesRef.current, [...edgesRef.current, edge])) throw new Error('That edge would create a directed cycle.');
        snapshot();
        setEdges(previous => [...previous, edge]);
        onAgentChange(`Agent added causal claim ${source} → ${target}`, [], [edge.id]);
        return textResult({ ok: true, action: 'added_edge', edge });
      },
    },
    {
      name: 'remove_edge',
      description: 'Remove one directed edge from the live DAG. The visible change is undoable.',
      inputSchema: schema({ source: { type: 'string' }, target: { type: 'string' } }, ['source', 'target']),
      execute: ({ source, target }) => {
        const edge = edgesRef.current.find(candidate => candidate.src === source && candidate.tgt === target);
        if (!edge) throw new Error(`Edge '${source}->${target}' does not exist.`);
        snapshot();
        setEdges(previous => previous.filter(candidate => candidate.id !== edge.id));
        onAgentChange(`Agent removed causal claim ${source} → ${target}`, [], [edge.id]);
        return textResult({ ok: true, action: 'removed_edge', edge });
      },
    },
    {
      name: 'analyze_current_dag',
      description: 'Verify the current DAG with the existing DAG Studio causal engine. Results are conditional on the researcher-authored structure.',
      inputSchema: schema(),
      annotations: { readOnlyHint: true },
      execute: () => {
        const dag = currentDag();
        if (!dag.exposure || !dag.outcome) throw new Error('Set both exposure and outcome first.');
        const result = computeAdjustmentSets(dag.exposure, dag.outcome, dag.nodes, dag.edges);
        const conflicts = detectTypeConflicts(dag.nodes, dag.edges, dag.exposure, dag.outcome);
        return textResult({
          identifiable: Boolean(result) && result.sets.length > 0,
          open_backdoor_paths: result?.backdoor || [],
          minimal_sufficient_adjustment_sets: result?.sets || [],
          diagnostics: conflicts,
          caveat: 'The engine verifies implications of the encoded assumptions; the researcher decides whether those assumptions are scientifically defensible.',
        });
      },
    },
    {
      name: 'check_adjustment_set',
      description: 'Check whether proposed node ids block every encoded backdoor path without deciding whether adjustment is scientifically appropriate.',
      inputSchema: schema({ adjustment_set: { type: 'array', items: { type: 'string' } } }, ['adjustment_set']),
      annotations: { readOnlyHint: true },
      execute: ({ adjustment_set }) => {
        const dag = currentDag();
        adjustment_set.forEach(ensureNode);
        if (!dag.exposure || !dag.outcome) throw new Error('Set both exposure and outcome first.');
        const backdoorGraph = dag.edges.filter(edge => edge.src !== dag.exposure);
        return textResult({
          valid: dSeparated(dag.exposure, dag.outcome, adjustment_set, backdoorGraph),
          adjustment_set,
          caveat: 'Graphical validity is conditional on the encoded DAG and is not a measurement or feasibility judgment.',
        });
      },
    },
    {
      name: 'generate_analysis_code',
      description: 'Generate R or Python code for the exact current canvas using the existing DAG Studio engine.',
      inputSchema: schema({ language: { type: 'string', enum: ['r', 'python'] } }, ['language']),
      annotations: { readOnlyHint: true },
      execute: ({ language }) => {
        const dag = currentDag();
        const code = language === 'r'
          ? generateRCode(dag.nodes, dag.edges, dag.exposure, dag.outcome)
          : generatePythonCode(dag.nodes, dag.edges, dag.exposure, dag.outcome);
        return textResult({ language, code });
      },
    },
    {
      name: 'simulate_current_dag',
      description: 'Simulate reproducible data from the exact current canvas using DAG Studio\'s existing linear Gaussian SEM, show the result in the visible simulation panel, and return bounded summaries for comparing causal hypotheses. Results describe implications of the encoded model, not evidence that the model is scientifically correct.',
      inputSchema: schema({
        run_label: {
          type: 'string',
          description: 'A short label used to distinguish this result from another hypothesis, for example "Hypothesis A".',
        },
        sample_size: {
          type: 'integer',
          enum: SIMULATION_SAMPLE_SIZES,
          description: 'Number of observations to simulate. Defaults to 1000.',
        },
        seed: {
          type: 'integer',
          minimum: 0,
          maximum: 2147483647,
          description: 'Reproducible random seed. Defaults to 42.',
        },
        edge_coefficients: {
          type: 'object',
          description: 'Optional coefficient overrides keyed by exact node-id edge strings such as "exposure->outcome". Unspecified edges use 0.5.',
          additionalProperties: { type: 'number' },
        },
      }),
      execute: input => {
        const dag = currentDag();
        if (!dag.nodes.length) throw new Error('Add at least one node before simulating data.');
        if (!dag.exposure || !dag.outcome) throw new Error('Set both exposure and outcome before simulating data.');
        if (hasCycle(dag.nodes, dag.edges)) throw new Error('Data simulation requires an acyclic graph.');

        const sampleSize = input.sample_size ?? 1000;
        if (!SIMULATION_SAMPLE_SIZES.includes(sampleSize)) {
          throw new Error(`Sample size must be one of: ${SIMULATION_SAMPLE_SIZES.join(', ')}.`);
        }
        const seed = input.seed ?? 42;
        if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) {
          throw new Error('Seed must be an integer from 0 through 2147483647.');
        }

        const runLabel = input.run_label?.trim() || 'Simulation';
        const coefficientOverrides = input.edge_coefficients || {};
        const edgeKeys = new Set(dag.edges.map(edge => `${edge.src}->${edge.tgt}`));
        for (const [key, value] of Object.entries(coefficientOverrides)) {
          if (!edgeKeys.has(key)) throw new Error(`Coefficient key '${key}' is not an edge in the current DAG.`);
          if (!Number.isFinite(value)) throw new Error(`Coefficient for '${key}' must be a finite number.`);
        }
        const resolvedCoefficients = Object.fromEntries(dag.edges.map(edge => {
          const key = `${edge.src}->${edge.tgt}`;
          return [key, coefficientOverrides[key] ?? DEFAULT_EDGE_COEFFICIENT];
        }));

        const nodeMap = Object.fromEntries(dag.nodes.map(node => [node.id, node]));
        const result = simulateData(dag.nodes, dag.edges, sampleSize, seed, resolvedCoefficients);
        const summaries = summarizeSimulation(result.data, result.order, nodeMap);
        const trueResult = computeTrueEffect(dag.exposure, dag.outcome, dag.edges, resolvedCoefficients);
        const crudeCoefficients = computeOLSCoefficients(result.data, dag.outcome, [dag.exposure]);
        const adjustmentResult = computeAdjustmentSets(dag.exposure, dag.outcome, dag.nodes, dag.edges);
        const adjustmentSet = adjustmentResult?.sets?.[0] || [];
        const adjustedCoefficients = computeOLSCoefficients(
          result.data,
          dag.outcome,
          [dag.exposure, ...adjustmentSet],
        );
        const trueEffect = rounded(trueResult.totalEffect);
        const crudeEstimate = rounded(crudeCoefficients?.[1]);
        const adjustedEstimate = rounded(adjustedCoefficients?.[1]);

        onSimulation({
          ...result,
          nodeMap,
          runLabel,
          sampleSize,
          seed,
          coefficients: resolvedCoefficients,
        });
        onAgentChange(`Agent simulated data for “${runLabel}”`, [], []);

        return textResult({
          ok: true,
          action: 'simulated_current_dag',
          run_label: runLabel,
          dag,
          simulation: {
            model: 'linear_gaussian_sem',
            sample_size: sampleSize,
            seed,
            root_distribution: 'normal_mean_0_variance_1',
            default_edge_coefficient: DEFAULT_EDGE_COEFFICIENT,
            error_standard_deviation: ERROR_STANDARD_DEVIATION,
            error_variance: ERROR_STANDARD_DEVIATION ** 2,
            edge_coefficients: resolvedCoefficients,
          },
          ...summaries,
          effect_estimates: {
            exposure: dag.exposure,
            outcome: dag.outcome,
            true_total_effect: trueEffect,
            directed_causal_paths: trueResult.paths.map(path => ({
              path: path.path,
              effect: rounded(path.coef),
            })),
            paths_truncated: trueResult.truncated,
            crude_ols: {
              beta: crudeEstimate,
              bias_from_true_total_effect: crudeEstimate === null || trueEffect === null
                ? null
                : rounded(crudeEstimate - trueEffect),
            },
            minimally_adjusted_ols: {
              beta: adjustedEstimate,
              adjustment_set: adjustmentSet,
              bias_from_true_total_effect: adjustedEstimate === null || trueEffect === null
                ? null
                : rounded(adjustedEstimate - trueEffect),
            },
          },
          preview: result.data.slice(0, PREVIEW_ROWS).map(row => Object.fromEntries(
            result.order.map(id => [id, rounded(row[id])]),
          )),
          caveat: 'This simulation shows consequences of the encoded DAG and coefficients. It does not determine which causal hypothesis is scientifically correct.',
        });
      },
    },
  ];
}

export async function registerDagStudioWebMCP(modelContext, options, registrationOptions = {}) {
  const tools = createDagStudioTools(options);
  await Promise.all(tools.map(tool => modelContext.registerTool(tool, registrationOptions)));
  return tools;
}
