import {
  computeAdjustmentSets,
  detectTypeConflicts,
  dSeparated,
  generatePythonCode,
  generateRCode,
  hasCycle,
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
];

const schema = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

const textResult = value => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});

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
  ];
}

export async function registerDagStudioWebMCP(modelContext, options, registrationOptions = {}) {
  const tools = createDagStudioTools(options);
  await Promise.all(tools.map(tool => modelContext.registerTool(tool, registrationOptions)));
  return tools;
}
