// Type declarations for dag-engine.js. Hand-authored — kept manually in sync
// with the engine's exported surface. The engine itself stays plain JS so the
// browser canvas can load it without a build step.

export type NodeType =
  | 'exposure' | 'outcome' | 'confounder' | 'mediator'
  | 'latent' | 'modifier' | 'unclassified';

export interface EngineNode {
  id: string;
  label: string;
  type?: NodeType;
  x?: number;
  y?: number;
}

export interface EngineEdge {
  src: string;
  tgt: string;
  id?: string;
  bend?: number;
}

export type EMType =
  | 'direct' | 'indirect' | 'common-cause'
  | 'proxy' | 'pure-interaction' | 'invalid';

export interface EngineModifier {
  id?: string;
  src: string;
  tgtEdge?: string;
  emType?: EMType | null;
}

export interface AdjustmentSetsResult {
  sets: string[][];
  backdoor: string[][];
  all: string[][];
  truncated: { candidates: boolean; paths: boolean };
}

export interface EnumeratePathsResult {
  paths: string[][];
  truncated: boolean;
}

export interface SimulateDataResult {
  data: Array<Record<string, number>>;
  order: string[];
}

export interface TrueEffectResult {
  totalEffect: number;
  paths: Array<{ path: string[]; coef: number }>;
  truncated: boolean;
}

export interface TestCase {
  id: string;
  name: string;
  category: string;
  refs: Array<{ cite: string; url?: string }>;
  description: string;
  nodes: EngineNode[];
  edges: EngineEdge[];
  exp: string;
  out: string;
  expected: { backdoorCount: number; adjSets: string[][]; noAdjPossible?: boolean };
}

export interface TestResult {
  pass: boolean;
  gotBackdoor: number;
  gotSets: string[][];
  backdoorOk: boolean;
  setsOk: boolean;
}

export interface EMTestCase {
  id: string;
  name: string;
  source: string;
  description: string;
  nodes: EngineNode[];
  edges: Array<{ src: string; tgt: string }>;
  modifiers: Array<{ src: string; tgtEdgeIdx: number }>;
  exp: string;
  out: string;
  expected: EMType[];
}

export interface EMTestResult {
  pass: boolean;
  expected: EMType[];
  got: EMType[];
}

export interface EMClassification {
  modifierId: string | undefined;
  emType: EMType;
}

export type StructuralRole =
  | 'exposure' | 'outcome' | 'mediator' | 'confounder'
  | 'instrument' | 'descendant-of-exposure' | 'ancestor-of-outcome'
  | 'unrelated' | 'unknown';

export interface TypeConflict {
  nodeId: string;
  label: string;
  userType: NodeType;
  structural: StructuralRole;
  message: string;
}

export interface ParsedDagitty {
  nodes: Array<{ id: string; label: string; role: 'exposure' | 'outcome' | 'latent' | null }>;
  edges: Array<{ src: string; tgt: string }>;
  exposure: string | null;
  outcome: string | null;
}

export const ENGINE_SEMVER: string;

// ─── Graph traversal ────────────────────────────────────────────────────────

export function descendants(nodeId: string, edges: EngineEdge[]): Set<string>;
export function allPaths(start: string, end: string, edges: EngineEdge[]): string[][];
export function enumeratePaths(
  start: string,
  end: string,
  edges: EngineEdge[],
  opts?: { maxLen?: number; maxPaths?: number; maxSteps?: number }
): EnumeratePathsResult;
export function dSeparated(x: string, y: string, Z: string[], edges: EngineEdge[]): boolean;
export function isCollider(node: string, prev: string, next: string, edges: EngineEdge[]): boolean;
export function isDirectedCausalPath(path: string[], edges: EngineEdge[]): boolean;
export function pathBlocked(path: string[], Z: string[], edges: EngineEdge[]): boolean;
export function backdoorPaths(exposure: string, outcome: string, edges: EngineEdge[]): string[][];
export function computeAdjustmentSets(
  exposure: string | undefined | null,
  outcome: string | undefined | null,
  nodes: EngineNode[],
  edges: EngineEdge[]
): AdjustmentSetsResult | null;

// ─── Effect modification & structural roles ─────────────────────────────────

export function classifyEffectModification(
  nodes: EngineNode[],
  edges: EngineEdge[],
  modifiers: EngineModifier[],
  exposure: string | undefined | null,
  outcome: string | undefined | null
): EMClassification[];

export function structuralRole(
  nodeId: string,
  exposure: string | undefined | null,
  outcome: string | undefined | null,
  edges: EngineEdge[]
): StructuralRole;

export const STRUCTURAL_ROLE_LABELS: Record<StructuralRole, string>;

export function detectTypeConflicts(
  nodes: EngineNode[], edges: EngineEdge[],
  exposure: string | undefined | null, outcome: string | undefined | null
): TypeConflict[];

export const EM_TYPE_LABELS: Record<EMType, string>;
export const EM_TYPE_DESCRIPTIONS: Record<EMType, string>;

// ─── Simulation ─────────────────────────────────────────────────────────────

export function topoSort(nodes: EngineNode[], edges: EngineEdge[]): string[];
export function hasCycle(nodes: EngineNode[], edges: EngineEdge[]): boolean;
export function makeSeededRandom(seed: number): () => number;
export function boxMullerRandom(rng?: () => number): number;
export function simulateData(
  nodes: EngineNode[],
  edges: EngineEdge[],
  n?: number,
  seed?: number | null,
  coefficients?: Record<string, number>
): SimulateDataResult;

// ─── Estimation ─────────────────────────────────────────────────────────────

export function computeCorrelation(x: number[], y: number[]): number;
export function computePartialCorrelation(
  data: Array<Record<string, number>>, x: string, y: string, Z: string[]
): number;
export function residualize(y: number[], X: number[][]): number[];
export function solveLinear(A: number[][], b: number[]): number[] | null;
export function dataToCSV(
  data: Array<Record<string, number>>, order: string[],
  nodeMap: Record<string, EngineNode>
): string;
export function computeOLSCoefficients(
  data: Array<Record<string, number>>, yVar: string, xVars: string[]
): number[] | null;
export function computeTrueEffect(
  exposure: string, outcome: string,
  edges: EngineEdge[], coefficients?: Record<string, number>
): TrueEffectResult;

// ─── Code generation ────────────────────────────────────────────────────────

export function _codeIdent(s: string): string;
export function _identMap(nodes: EngineNode[]): Record<string, string>;
export function _plotCoords(nodes: EngineNode[]): Record<string, { x: number; y: number }>;
export function generatePythonCode(
  nodes: EngineNode[], edges: EngineEdge[],
  exposure?: string | null, outcome?: string | null
): string;
export function generateRCode(
  nodes: EngineNode[], edges: EngineEdge[],
  exposure?: string | null, outcome?: string | null
): string;

// ─── Parser ─────────────────────────────────────────────────────────────────

export function parseDagitty(rCode: string): ParsedDagitty;

// ─── Validation suites ──────────────────────────────────────────────────────

export const TESTS: TestCase[];
export function runTest(t: TestCase): TestResult;
export const EM_TESTS: EMTestCase[];
export function runEMTest(t: EMTestCase): EMTestResult;
