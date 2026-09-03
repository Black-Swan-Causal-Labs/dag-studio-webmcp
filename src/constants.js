/**
 * DAG Studio — shared constants and initial state
 */

export const NODE_RADIUS = 30;

export const NODE_COLORS = {
  exposure:   { fill: '#3b7cf4', stroke: '#2260d0' },
  outcome:    { fill: '#0da271', stroke: '#0a7a55' },
  confounder: { fill: '#e8972a', stroke: '#c07318' },
  latent:     { fill: '#9aaac4', stroke: '#7a8fb0' },
  variable:   { fill: '#8b5cf6', stroke: '#6d3fd6' },
};

export const INIT_NODES = [
  { id: 'age', label: 'Age',       x: 140, y: 190, type: 'confounder' },
  { id: 'sex', label: 'Sex',       x: 140, y: 340, type: 'confounder' },
  { id: 'trt', label: 'Treatment', x: 390, y: 265, type: 'exposure'   },
  { id: 'out', label: 'Outcome',   x: 640, y: 265, type: 'outcome'    },
  { id: 'sev', label: 'Severity',  x: 390, y: 120, type: 'variable'   },
];

export const INIT_EDGES = [
  { id: 'e1', src: 'age', tgt: 'trt' },
  { id: 'e2', src: 'age', tgt: 'out' },
  { id: 'e3', src: 'sex', tgt: 'trt' },
  { id: 'e4', src: 'sex', tgt: 'out' },
  { id: 'e5', src: 'trt', tgt: 'out' },
  { id: 'e6', src: 'sev', tgt: 'trt' },
  { id: 'e7', src: 'sev', tgt: 'out' },
];

let _nid = 50, _eid = 50;
export const nuid = () => `n${++_nid}_${Date.now()}`;
export const euid = () => `e${++_eid}_${Date.now()}`;
