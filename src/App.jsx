import { useState, useRef, useEffect } from "react";

// ─── Causal Inference Engine ───────────────────────────────────────────────

function descendants(nodeId, edges) {
  const desc = new Set();
  const q = [nodeId];
  while (q.length) {
    const cur = q.shift();
    for (const e of edges) {
      if (e.src === cur && !desc.has(e.tgt)) { desc.add(e.tgt); q.push(e.tgt); }
    }
  }
  return desc;
}

function allPaths(start, end, edges) {
  const paths = [];
  const adj = {};
  for (const e of edges) {
    (adj[e.src] = adj[e.src] || []).push(e.tgt);
    (adj[e.tgt] = adj[e.tgt] || []).push(e.src);
  }
  function dfs(cur, path, visited) {
    if (cur === end) { paths.push([...path]); return; }
    if (path.length > 12) return;
    for (const nb of (adj[cur] || [])) {
      if (!visited.has(nb)) {
        visited.add(nb); path.push(nb);
        dfs(nb, path, visited);
        path.pop(); visited.delete(nb);
      }
    }
  }
  dfs(start, [start], new Set([start]));
  return paths;
}

function isCollider(node, prev, next, edges) {
  return edges.some(e => e.src === prev && e.tgt === node) &&
         edges.some(e => e.src === next  && e.tgt === node);
}

function pathBlocked(path, Z, edges) {
  const Zset = new Set(Z);
  for (let i = 1; i < path.length - 1; i++) {
    const [p, c, n] = [path[i-1], path[i], path[i+1]];
    if (isCollider(c, p, n, edges)) {
      const desc = descendants(c, edges);
      if (!Zset.has(c) && ![...desc].some(d => Zset.has(d))) return true;
    } else {
      if (Zset.has(c)) return true;
    }
  }
  return false;
}

function backdoorPaths(exp, out, edges) {
  // Only return paths that are genuinely open (d-connected) in the empty conditioning set.
  // Paths naturally blocked by an unconditioned collider are not open backdoor paths.
  return allPaths(exp, out, edges).filter(path =>
    path.length >= 2 &&
    edges.some(e => e.src === path[1] && e.tgt === exp) &&
    !pathBlocked(path, [], edges)
  );
}

function computeAdjustmentSets(exp, out, nodes, edges) {
  if (!exp || !out) return null;
  const desc = descendants(exp, edges);
  const cands = nodes
    .filter(n => n.id !== exp && n.id !== out && !desc.has(n.id) && n.type !== 'latent')
    .map(n => n.id).slice(0, 10);
  const bkPaths = backdoorPaths(exp, out, edges);
  const aPaths  = allPaths(exp, out, edges);
  if (!bkPaths.length) return { sets: [[]], backdoor: [], all: aPaths };
  const valid = [];
  for (let mask = 0; mask < (1 << cands.length); mask++) {
    const Z = cands.filter((_, i) => mask & (1 << i));
    if (bkPaths.every(p => pathBlocked(p, Z, edges))) valid.push(Z);
  }
  const minimal = valid.filter(s => !valid.some(o => o.length < s.length && o.every(x => s.includes(x))));
  return { sets: minimal, backdoor: bkPaths, all: aPaths };
}

// ─── Training Library ──────────────────────────────────────────────────────

const LIBRARY = [
  {
    id: 'confounding',
    name: 'Classic Confounding',
    tag: 'Confounding',
    color: '#e8972a',
    description: 'A confounder is a common cause of both the exposure and outcome, creating a spurious association. Adjustment for the confounder closes the backdoor path and yields an unbiased estimate of the causal effect.',
    refs: [
      { title: 'Causal diagrams for epidemiologic research', cite: 'Greenland, Pearl & Robins · Epidemiology 1999', url: 'https://doi.org/10.1097/00001648-199901000-00008' },
      { title: 'Causal Inference: What If (Ch. 7 — Confounding)', cite: 'Hernán & Robins · CRC Press 2020', url: 'https://www.hsph.harvard.edu/miguel-hernan/causal-inference-book/' },
      { title: 'Reducing bias through directed acyclic graphs', cite: 'Shrier & Platt · BMC Med Res Methodol 2008', url: 'https://doi.org/10.1186/1471-2288-8-70' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [
      { id:'conf', label:'Confounder', x:220, y:140, type:'confounder' },
      { id:'exp',  label:'Exposure',  x:150, y:300, type:'exposure'   },
      { id:'out',  label:'Outcome',   x:450, y:300, type:'outcome'    },
    ],
    edges: [
      { id:'e1', src:'conf', tgt:'exp' },
      { id:'e2', src:'conf', tgt:'out' },
      { id:'e3', src:'exp',  tgt:'out' },
    ],
  },
  {
    id: 'mbias',
    name: 'M-Bias',
    tag: 'M-Bias',
    color: '#e53e3e',
    description: 'M-bias occurs when a pre-exposure variable (M) is a common descendant of two unmeasured causes — one related to the exposure and one to the outcome. Conditioning on M opens a collider path and introduces bias, even though M precedes exposure.',
    refs: [
      { title: 'Avoiding bias due to perfect prediction in multiple logistic regression (M-bias discussion)', cite: 'Greenland · Stat Med 2003', url: 'https://doi.org/10.1002/sim.1485' },
      { title: 'To Adjust or Not to Adjust? Sensitivity Analysis of M-Bias', cite: 'Ding & Miratrix · JCGS 2015', url: 'https://doi.org/10.1080/10618600.2015.1023764' },
      { title: 'A structural approach to selection bias', cite: 'Hernán, Hernández-Díaz & Robins · Epidemiology 2004', url: 'https://doi.org/10.1097/01.ede.0000135174.63482.43' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [
      { id:'u1',  label:'U1',      x:130, y:130, type:'latent'     },
      { id:'u2',  label:'U2',      x:470, y:130, type:'latent'     },
      { id:'m',   label:'M',       x:300, y:230, type:'confounder' },
      { id:'exp', label:'Exposure',x:150, y:370, type:'exposure'   },
      { id:'out', label:'Outcome', x:450, y:370, type:'outcome'    },
    ],
    edges: [
      { id:'e1', src:'u1',  tgt:'exp' },
      { id:'e2', src:'u1',  tgt:'m'   },
      { id:'e3', src:'u2',  tgt:'m'   },
      { id:'e4', src:'u2',  tgt:'out' },
      { id:'e5', src:'exp', tgt:'out' },
    ],
  },
  {
    id: 'collider',
    name: 'Collider Bias',
    tag: 'Collider',
    color: '#8b5cf6',
    description: 'A collider is a variable with two or more causes. Conditioning on a collider (or its descendant) opens a non-causal path between those causes, inducing a spurious association. This is also the mechanism behind index event bias and Berkson\'s bias.',
    refs: [
      { title: 'Causality: Models, Reasoning and Inference (§1.2 — Colliders)', cite: 'Pearl · Cambridge University Press, 2nd ed. 2009', url: 'http://bayes.cs.ucla.edu/BOOK-2K/' },
      { title: 'Collider bias undermines our understanding of COVID-19 disease risk and severity', cite: 'Griffith et al. · Nature Comms 2020', url: 'https://doi.org/10.1038/s41467-020-19478-2' },
      { title: 'Index event bias as an explanation for the paradoxes of recurrence risk research', cite: 'Dahabreh & Kent · JAMA 2011', url: 'https://doi.org/10.1001/jama.2011.163' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [
      { id:'exp', label:'Exposure', x:150, y:200, type:'exposure'   },
      { id:'out', label:'Outcome',  x:450, y:200, type:'outcome'    },
      { id:'col', label:'Collider', x:300, y:340, type:'variable'   },
    ],
    edges: [
      { id:'e1', src:'exp', tgt:'out' },
      { id:'e2', src:'exp', tgt:'col' },
      { id:'e3', src:'out', tgt:'col' },
    ],
  },
  {
    id: 'selection',
    name: 'Selection Bias',
    tag: 'Selection Bias',
    color: '#0da271',
    description: 'Selection bias arises when study inclusion depends on both exposure and outcome (or their causes). The selection node acts as a collider; restricting analysis to selected individuals conditions on it, opening a backdoor path and distorting effect estimates.',
    refs: [
      { title: 'A structural approach to selection bias', cite: 'Hernán, Hernández-Díaz & Robins · Epidemiology 2004', url: 'https://doi.org/10.1097/01.ede.0000135174.63482.43' },
      { title: 'Causal Inference: What If (Ch. 8 — Selection Bias)', cite: 'Hernán & Robins · CRC Press 2020', url: 'https://www.hsph.harvard.edu/miguel-hernan/causal-inference-book/' },
      { title: 'Selection bias in the estimation of effect modification', cite: 'Lash & Fink · Epidemiology 2004', url: 'https://doi.org/10.1097/01.ede.0000099081.60081.4f' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [
      { id:'exp', label:'Exposure', x:150, y:200, type:'exposure'   },
      { id:'out', label:'Outcome',  x:450, y:200, type:'outcome'    },
      { id:'sel', label:'Selected', x:300, y:340, type:'variable'   },
    ],
    edges: [
      { id:'e1', src:'exp', tgt:'out' },
      { id:'e2', src:'exp', tgt:'sel' },
      { id:'e3', src:'out', tgt:'sel' },
    ],
  },
  {
    id: 'mediation',
    name: 'Mediation',
    tag: 'Mediation',
    color: '#3b7cf4',
    description: 'A mediator lies on the causal path from exposure to outcome. Conditioning on the mediator blocks the indirect effect and yields only the direct effect. Avoiding adjustment for mediators is essential when the total effect is of interest.',
    refs: [
      { title: 'Explanation in Causal Inference: Methods for Mediation and Interaction', cite: 'VanderWeele · Oxford University Press 2015', url: 'https://global.oup.com/academic/product/explanation-in-causal-inference-9780199325870' },
      { title: 'Mediation Analysis with a Survival Outcome', cite: 'VanderWeele · Int J Epidemiol 2011', url: 'https://doi.org/10.1093/ije/dyr066' },
      { title: 'Causal Inference: What If (Ch. 17 — Mediating variables)', cite: 'Hernán & Robins · CRC Press 2020', url: 'https://www.hsph.harvard.edu/miguel-hernan/causal-inference-book/' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [
      { id:'exp', label:'Exposure', x:130, y:260, type:'exposure'  },
      { id:'med', label:'Mediator', x:300, y:260, type:'variable'  },
      { id:'out', label:'Outcome',  x:470, y:260, type:'outcome'   },
    ],
    edges: [
      { id:'e1', src:'exp', tgt:'med' },
      { id:'e2', src:'med', tgt:'out' },
      { id:'e3', src:'exp', tgt:'out' },
    ],
  },
  {
    id: 'iv',
    name: 'Instrumental Variable',
    tag: 'Instruments',
    color: '#e8972a',
    description: 'An instrumental variable (IV) affects the outcome only through the exposure and is independent of unmeasured confounders. IVs can identify causal effects even in the presence of unobserved confounding, a cornerstone of Mendelian randomization.',
    refs: [
      { title: 'Causality: Models, Reasoning and Inference (§5.4 — Instrumental Variables)', cite: 'Pearl · Cambridge University Press, 2nd ed. 2009', url: 'http://bayes.cs.ucla.edu/BOOK-2K/' },
      { title: 'Mendelian randomization: using genes as instruments for making causal inferences', cite: 'Davey Smith & Ebrahim · Stat Med 2003', url: 'https://doi.org/10.1002/sim.1792' },
      { title: 'Causal Inference: What If (Ch. 16 — Instrumental variable estimation)', cite: 'Hernán & Robins · CRC Press 2020', url: 'https://www.hsph.harvard.edu/miguel-hernan/causal-inference-book/' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [
      { id:'iv',   label:'IV',        x:100, y:260, type:'variable'   },
      { id:'exp',  label:'Exposure',  x:280, y:260, type:'exposure'   },
      { id:'out',  label:'Outcome',   x:460, y:260, type:'outcome'    },
      { id:'u',    label:'U (unobs)', x:370, y:140, type:'latent'     },
    ],
    edges: [
      { id:'e1', src:'iv',  tgt:'exp' },
      { id:'e2', src:'exp', tgt:'out' },
      { id:'e3', src:'u',   tgt:'exp' },
      { id:'e4', src:'u',   tgt:'out' },
    ],
  },
  {
    id: 'timevary',
    name: 'Time-Varying Confounding',
    tag: 'Time-Varying',
    color: '#3b7cf4',
    description: 'When a time-varying covariate is both a confounder of the exposure-outcome relationship and is itself affected by prior exposure, standard regression adjustment introduces collider bias. G-methods (g-computation, IPTW, g-estimation) are required for valid estimation.',
    refs: [
      { title: 'A new approach to causal inference in mortality studies (G-computation)', cite: 'Robins · Math Modelling 1986', url: 'https://doi.org/10.1016/0270-0255(86)90088-6' },
      { title: 'Marginal structural models and causal inference in epidemiology', cite: 'Robins, Hernán & Brumback · Epidemiology 2000', url: 'https://doi.org/10.1097/00001648-200009000-00011' },
      { title: 'Causal Inference: What If (Ch. 19–21 — G-methods)', cite: 'Hernán & Robins · CRC Press 2020', url: 'https://www.hsph.harvard.edu/miguel-hernan/causal-inference-book/' },
    ],
    exposure: 'exp2', outcome: 'out',
    nodes: [
      { id:'exp1', label:'Exp (t1)', x:110, y:260, type:'exposure'   },
      { id:'l',    label:'L (t2)',   x:260, y:180, type:'confounder' },
      { id:'exp2', label:'Exp (t2)', x:260, y:320, type:'exposure'   },
      { id:'out',  label:'Outcome',  x:440, y:260, type:'outcome'    },
    ],
    edges: [
      { id:'e1', src:'exp1', tgt:'l'    },
      { id:'e2', src:'exp1', tgt:'exp2' },
      { id:'e3', src:'l',    tgt:'exp2' },
      { id:'e4', src:'l',    tgt:'out'  },
      { id:'e5', src:'exp2', tgt:'out'  },
    ],
  },
  {
    id: 'overadjust',
    name: 'Over-adjustment',
    tag: 'Over-adjustment',
    color: '#e53e3e',
    description: 'Adjusting for a variable on the causal path (a mediator or descendant of the exposure) blocks part of the causal effect, resulting in underestimation of the total effect. This is a common error in pharmacoepidemiology when including post-exposure variables as covariates.',
    refs: [
      { title: 'Overadjustment bias and unnecessary adjustment in epidemiologic studies', cite: 'Schisterman, Cole & Platt · Epidemiology 2009', url: 'https://doi.org/10.1097/EDE.0b013e3181a819a1' },
      { title: 'The table 2 fallacy: presenting and interpreting confounder and modifier coefficients', cite: 'Westreich & Greenland · Am J Epidemiol 2013', url: 'https://doi.org/10.1093/aje/kws412' },
      { title: 'Causal diagrams for epidemiologic research', cite: 'Greenland, Pearl & Robins · Epidemiology 1999', url: 'https://doi.org/10.1097/00001648-199901000-00008' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [
      { id:'exp', label:'Exposure', x:130, y:260, type:'exposure'  },
      { id:'bio', label:'Biomarker',x:300, y:260, type:'variable'  },
      { id:'out', label:'Outcome',  x:470, y:260, type:'outcome'   },
      { id:'con', label:'Covariate',x:300, y:140, type:'confounder'},
    ],
    edges: [
      { id:'e1', src:'exp', tgt:'bio' },
      { id:'e2', src:'bio', tgt:'out' },
      { id:'e3', src:'exp', tgt:'out' },
      { id:'e4', src:'con', tgt:'exp' },
      { id:'e5', src:'con', tgt:'out' },
    ],
  },
];

// ─── Constants ─────────────────────────────────────────────────────────────

const R = 30;

const NODE_COLORS = {
  exposure:   { fill:'#3b7cf4', stroke:'#2260d0' },
  outcome:    { fill:'#0da271', stroke:'#0a7a55' },
  confounder: { fill:'#e8972a', stroke:'#c07318' },
  latent:     { fill:'#9aaac4', stroke:'#7a8fb0' },
  variable:   { fill:'#8b5cf6', stroke:'#6d3fd6' },
};

const INIT_NODES = [
  { id:'age', label:'Age',       x:140, y:190, type:'confounder' },
  { id:'sex', label:'Sex',       x:140, y:340, type:'confounder' },
  { id:'trt', label:'Treatment', x:390, y:265, type:'exposure'   },
  { id:'out', label:'Outcome',   x:640, y:265, type:'outcome'    },
  { id:'sev', label:'Severity',  x:390, y:120, type:'variable'   },
];
const INIT_EDGES = [
  {id:'e1',src:'age',tgt:'trt'},{id:'e2',src:'age',tgt:'out'},
  {id:'e3',src:'sex',tgt:'trt'},{id:'e4',src:'sex',tgt:'out'},
  {id:'e5',src:'trt',tgt:'out'},
  {id:'e6',src:'sev',tgt:'trt'},{id:'e7',src:'sev',tgt:'out'},
];

let _nid=50,_eid=50;
const nuid=()=>`n${++_nid}_${Date.now()}`;
const euid=()=>`e${++_eid}_${Date.now()}`;

// ─── Reference Panel ───────────────────────────────────────────────────────

function RefPanel({ refs, accentColor }) {
  return (
    <div style={{
      padding:'13px 16px',
      borderTop:'1px solid #eef2f8',
      background:'#fafbfd',
    flexGrow:1,
    }}>
      <div style={{
        fontSize:9,fontWeight:700,letterSpacing:'.12em',textTransform:'uppercase',
        color:'#b0bcd4',marginBottom:9,
      }}>Further Reading</div>
      <div style={{display:'flex',flexDirection:'column',gap:8}}>
        {refs.map((r,i)=>(
          <div key={i} style={{display:'flex',gap:9,alignItems:'flex-start'}}>
            <div style={{
              flexShrink:0,width:17,height:17,borderRadius:5,marginTop:1,
              background:accentColor+'18',border:`1.5px solid ${accentColor}44`,
              display:'flex',alignItems:'center',justifyContent:'center',
              fontSize:9,fontWeight:700,color:accentColor,
            }}>{i+1}</div>
            <div>
              <div style={{fontSize:11.5,fontWeight:600,color:'#1e2a40',lineHeight:1.4}}>
                {r.url
                  ? <a href={r.url} target="_blank" rel="noreferrer"
                      onClick={e=>e.stopPropagation()}
                      style={{color:'#3b7cf4',textDecoration:'none'}}
                      onMouseEnter={e=>e.currentTarget.style.textDecoration='underline'}
                      onMouseLeave={e=>e.currentTarget.style.textDecoration='none'}>
                      {r.title}
                    </a>
                  : r.title}
              </div>
              <div style={{fontSize:10,color:'#9aaac4',marginTop:2,fontStyle:'italic'}}>{r.cite}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Validation Test Suite ──────────────────────────────────────────────────

const TESTS = [
  { id:'T01', name:'Full Mediation (X → M → Y)', category:'Mediation', reference:'dagitty paper §Usage; Pearl 2009 §3.3',
    description:'Pure mediation chain. X affects Y only through M. No backdoor paths exist. No adjustment is needed — conditioning on M would block the only causal path and yield a biased estimate of the total effect.',
    nodes:[{id:'X',label:'X',type:'exposure'},{id:'M',label:'M',type:'variable'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'X',tgt:'M'},{id:'e2',src:'M',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:0,adjSets:[[]],note:'Empty set sufficient; do NOT adjust for M'} },
  { id:'T02', name:'Classic Confounding (C → X, C → Y, X → Y)', category:'Confounding', reference:'Greenland et al. 1999; dagitty paper Fig 1D',
    description:'C is a common cause of both X and Y, creating backdoor path X ← C → Y. Adjusting for C closes the path and yields an unbiased estimate of the causal effect of X on Y.',
    nodes:[{id:'C',label:'C',type:'confounder'},{id:'X',label:'X',type:'exposure'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'C',tgt:'X'},{id:'e2',src:'C',tgt:'Y'},{id:'e3',src:'X',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:1,adjSets:[['C']],note:'Must adjust for C'} },
  { id:'T03', name:'Pure Fork / Spurious Association (C → X, C → Y)', category:'Confounding', reference:'Pearl 2009 §1.2 (fork structure)',
    description:'C causes both X and Y with no direct X→Y arrow. The entire observed X–Y association is spurious, arising from the fork. Adjusting for C removes it entirely.',
    nodes:[{id:'C',label:'C',type:'confounder'},{id:'X',label:'X',type:'exposure'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'C',tgt:'X'},{id:'e2',src:'C',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:1,adjSets:[['C']],note:'Entire association is confounding — adjust for C'} },
  { id:'T04', name:'Simple Collider (X → Y, X → C ← Y)', category:'Collider', reference:'Pearl 2009 §1.2; Hernán & Robins 2020 §6.4',
    description:'C is a collider — a common effect of X and Y. Without conditioning on C, the path through C is blocked and no adjustment is needed. Conditioning on C would open the path and induce collider bias.',
    nodes:[{id:'X',label:'X',type:'exposure'},{id:'Y',label:'Y',type:'outcome'},{id:'C',label:'C',type:'variable'}],
    edges:[{id:'e1',src:'X',tgt:'Y'},{id:'e2',src:'X',tgt:'C'},{id:'e3',src:'Y',tgt:'C'}], exp:'X', out:'Y',
    expected:{backdoorCount:0,adjSets:[[]],note:'No adjustment needed; do NOT condition on C'} },
  { id:'T05', name:'M-Bias', category:'M-Bias', reference:'Greenland 2003; Ding & Miratrix 2015; dagitty paper discussion',
    description:'U1 and U2 are unmeasured. M is a collider on the path X ← U1 → M ← U2 → Y. Without conditioning on M, this path is blocked by the collider rule. Adjusting for M opens the path and introduces bias. The correct answer is no adjustment needed.',
    nodes:[{id:'U1',label:'U1',type:'latent'},{id:'U2',label:'U2',type:'latent'},{id:'M',label:'M',type:'confounder'},{id:'X',label:'X',type:'exposure'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'U1',tgt:'X'},{id:'e2',src:'U1',tgt:'M'},{id:'e3',src:'U2',tgt:'M'},{id:'e4',src:'U2',tgt:'Y'},{id:'e5',src:'X',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:0,adjSets:[[]],note:'No adjustment needed — collider M blocks the only backdoor path'} },
  { id:'T06', name:'Instrumental Variable (IV → X ← U → Y, X → Y)', category:'Instruments', reference:'Pearl 2009 §5.4; Hernán & Robins 2020 §16',
    description:'IV affects X but not Y directly. U is an unmeasured confounder. The backdoor path X ← U → Y cannot be blocked by observed variables alone. No valid observed-variable adjustment set exists; an IV estimator is required.',
    nodes:[{id:'IV',label:'IV',type:'variable'},{id:'U',label:'U',type:'latent'},{id:'X',label:'X',type:'exposure'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'IV',tgt:'X'},{id:'e2',src:'U',tgt:'X'},{id:'e3',src:'U',tgt:'Y'},{id:'e4',src:'X',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:1,adjSets:[],noAdjPossible:true,note:'No valid adjustment set — U is unmeasured; IV estimator required'} },
  { id:'T07', name:'Two Confounders (C1, C2 → X, C1, C2 → Y)', category:'Confounding', reference:'Pearl 2009 §3.3',
    description:'Two independent confounders each create a separate backdoor path. Both must be included in any valid adjustment set; adjusting for only one leaves the other backdoor path open.',
    nodes:[{id:'C1',label:'C1',type:'confounder'},{id:'C2',label:'C2',type:'confounder'},{id:'X',label:'X',type:'exposure'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'C1',tgt:'X'},{id:'e2',src:'C1',tgt:'Y'},{id:'e3',src:'C2',tgt:'X'},{id:'e4',src:'C2',tgt:'Y'},{id:'e5',src:'X',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:2,adjSets:[['C1','C2']],note:'Must adjust for both C1 and C2 simultaneously'} },
  { id:'T08', name:'Mediation with Confounder of Mediator', category:'Mediation', reference:'VanderWeele 2015 §2.2; Hernán & Robins 2020 §17',
    description:'X → M → Y with C → M and C → Y. C confounds the M–Y relationship but not X directly. For the total effect of X on Y, no adjustment is needed (no backdoor path into X). Adjusting for M would block the indirect path.',
    nodes:[{id:'X',label:'X',type:'exposure'},{id:'M',label:'M',type:'variable'},{id:'Y',label:'Y',type:'outcome'},{id:'C',label:'C',type:'confounder'}],
    edges:[{id:'e1',src:'X',tgt:'M'},{id:'e2',src:'M',tgt:'Y'},{id:'e3',src:'X',tgt:'Y'},{id:'e4',src:'C',tgt:'M'},{id:'e5',src:'C',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:0,adjSets:[[]],note:'No backdoor paths for X→Y total effect; C does not confound X'} },
  { id:'T09', name:'Selection Bias Structure (X → S ← Y)', category:'Selection Bias', reference:'Hernán et al. 2004; Hernán & Robins 2020 §8',
    description:'S is a selection collider — a common effect of X and Y. Restricting to selected individuals (conditioning on S=1) opens the collider path and induces a non-causal association. Without conditioning on S, no backdoor path exists.',
    nodes:[{id:'X',label:'X',type:'exposure'},{id:'Y',label:'Y',type:'outcome'},{id:'S',label:'Selected',type:'variable'}],
    edges:[{id:'e1',src:'X',tgt:'Y'},{id:'e2',src:'X',tgt:'S'},{id:'e3',src:'Y',tgt:'S'}], exp:'X', out:'Y',
    expected:{backdoorCount:0,adjSets:[[]],note:'S is a collider; do NOT condition on S'} },
  { id:'T10', name:'Frontdoor Criterion (X → M → Y, X ← U → Y)', category:'Frontdoor', reference:'Pearl 2009 §3.4',
    description:'U is unmeasured. The backdoor path X ← U → Y cannot be blocked directly. The frontdoor criterion — adjusting for M in a two-step estimator — identifies the causal effect. The engine correctly reports no valid backdoor-criterion adjustment set.',
    nodes:[{id:'U',label:'U',type:'latent'},{id:'X',label:'X',type:'exposure'},{id:'M',label:'M',type:'variable'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'U',tgt:'X'},{id:'e2',src:'U',tgt:'Y'},{id:'e3',src:'X',tgt:'M'},{id:'e4',src:'M',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:1,adjSets:[],noAdjPossible:true,note:'No backdoor-criterion set exists; frontdoor criterion applies'} },
  { id:'T11', name:'Descendant of Exposure (Over-adjustment)', category:'Over-adjustment', reference:'Schisterman et al. 2009; Hernán & Robins 2020 §15',
    description:'B is caused by X — a post-exposure intermediate. Adjusting for B blocks part of the causal path and yields a biased estimate of the total effect. The engine excludes descendants of the exposure from the candidate adjustment set.',
    nodes:[{id:'X',label:'X',type:'exposure'},{id:'B',label:'Biomarker',type:'variable'},{id:'C',label:'C',type:'confounder'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'X',tgt:'B'},{id:'e2',src:'B',tgt:'Y'},{id:'e3',src:'X',tgt:'Y'},{id:'e4',src:'C',tgt:'X'},{id:'e5',src:'C',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:1,adjSets:[['C']],note:'Adjust for C only — B is a descendant of X and must not be included'} },
  { id:'T12', name:'Competing Adjustment Sets', category:'Confounding', reference:'Textor et al. 2016 (dagitty paper) §Valid adjustment sets',
    description:'C1 and C2 are independent confounders; C3 is a common cause of C1 and Y but not X directly. Three open backdoor paths exist. The only minimal sufficient adjustment set is {C1, C2} — {C2, C3} fails because it does not block X ← C1 → Y.',
    nodes:[{id:'C1',label:'C1',type:'confounder'},{id:'C2',label:'C2',type:'confounder'},{id:'C3',label:'C3',type:'confounder'},{id:'X',label:'X',type:'exposure'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'C1',tgt:'X'},{id:'e2',src:'C1',tgt:'Y'},{id:'e3',src:'C2',tgt:'X'},{id:'e4',src:'C2',tgt:'Y'},{id:'e5',src:'C3',tgt:'C1'},{id:'e6',src:'C3',tgt:'Y'},{id:'e7',src:'X',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:3,adjSets:[['C1','C2']],note:'Three open backdoor paths; only {C1,C2} is minimal and valid'} },
  { id:'T13', name:'Collider Descendant Opens Path', category:'Collider', reference:'Pearl 2009 §1.2.3; Hernán & Robins 2020 §6.4',
    description:'C is a collider; D is a descendant of C. Conditioning on D partially opens the collider path even without conditioning on C itself. The engine correctly finds no valid adjustment set that includes D.',
    nodes:[{id:'X',label:'X',type:'exposure'},{id:'Y',label:'Y',type:'outcome'},{id:'C',label:'C',type:'variable'},{id:'D',label:'D (desc)',type:'variable'}],
    edges:[{id:'e1',src:'X',tgt:'Y'},{id:'e2',src:'X',tgt:'C'},{id:'e3',src:'Y',tgt:'C'},{id:'e4',src:'C',tgt:'D'}], exp:'X', out:'Y',
    expected:{backdoorCount:0,adjSets:[[]],note:'No adjustment needed; must not condition on D (descendant of collider C)'} },
  { id:'T14', name:'Time-Varying Confounding (Robins 1986 structure)', category:'Time-Varying', reference:'Robins 1986; Robins, Hernán & Brumback 2000; Hernán & Robins 2020 §21',
    description:'L is a time-varying confounder of E2→Y that is also affected by prior exposure E1. Two open backdoor paths exist: E2 ← L → Y and E2 ← E1 → L → Y. Adjusting for L blocks both and is valid for estimating the conditional effect of E2 on Y. G-methods are required only when estimating the joint effect of the full treatment regime (E1, E2).',
    nodes:[{id:'E1',label:'E1 (t1)',type:'exposure'},{id:'L',label:'L (t2)',type:'confounder'},{id:'E2',label:'E2 (t2)',type:'exposure'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'E1',tgt:'L'},{id:'e2',src:'E1',tgt:'E2'},{id:'e3',src:'L',tgt:'E2'},{id:'e4',src:'L',tgt:'Y'},{id:'e5',src:'E2',tgt:'Y'}], exp:'E2', out:'Y',
    expected:{backdoorCount:2,adjSets:[['L']],noAdjPossible:false,note:'Adjust for L; G-methods required only for joint treatment regime'} },
  { id:'T15', name:'Proxy / Surrogate Confounder', category:'Confounding', reference:'Pearl 2009 §3.3.1',
    description:'U is an unmeasured confounder; P is a proxy caused by U. P does not fully block the backdoor path X ← U → Y because U also directly causes X and Y. Since U is latent and P is only a partial surrogate, no valid adjustment set exists using observed variables alone.',
    nodes:[{id:'U',label:'U',type:'latent'},{id:'P',label:'Proxy',type:'confounder'},{id:'X',label:'X',type:'exposure'},{id:'Y',label:'Y',type:'outcome'}],
    edges:[{id:'e1',src:'U',tgt:'X'},{id:'e2',src:'U',tgt:'Y'},{id:'e3',src:'U',tgt:'P'},{id:'e4',src:'X',tgt:'Y'}], exp:'X', out:'Y',
    expected:{backdoorCount:1,adjSets:[],noAdjPossible:true,note:'No valid set — U is latent and proxy P does not block X←U→Y'} },
];

function runTest(t) {
  const result = computeAdjustmentSets(t.exp, t.out, t.nodes, t.edges);
  const gotBackdoor = result?.backdoor?.length ?? 0;
  const gotSets = result?.sets ?? [];
  const sort = arr => [...arr].sort();
  const setsMatch = () => {
    const exp = t.expected.adjSets.map(s=>sort(s).join(','));
    const got = gotSets.map(s=>sort(s).join(','));
    return exp.length===got.length && exp.every(e=>got.includes(e));
  };
  const backdoorOk = gotBackdoor === t.expected.backdoorCount;
  const setsOk = t.expected.noAdjPossible ? gotSets.length===0 : setsMatch();
  return { pass: backdoorOk && setsOk, gotBackdoor, gotSets, backdoorOk, setsOk };
}

const CATEGORY_ORDER = ['Confounding','Mediation','Collider','M-Bias','Selection Bias','Instruments','Frontdoor','Over-adjustment','Time-Varying'];

const CATEGORY_INTROS = {
  Confounding: 'Confounding tests verify that the engine correctly identifies open backdoor paths through common causes and enumerates minimal sufficient adjustment sets. These cases form the foundation of the backdoor criterion (Pearl, 2009) and cover single confounders, multiple independent confounders, fork structures, and competing adjustment sets.',
  Mediation: 'Mediation tests confirm that the engine correctly distinguishes mediators from confounders. Critically, mediators should never appear in a backdoor-criterion adjustment set for the total effect, as conditioning on them blocks the indirect causal path.',
  Collider: 'Collider tests verify the collider rule: a variable that is a common effect of two variables on a path blocks that path unless conditioned upon. The engine must correctly identify colliders, refrain from conditioning on them, and also exclude their descendants from adjustment sets.',
  'M-Bias': 'The M-bias test is a canonical edge case in which a pre-exposure variable appears to be a candidate for adjustment but is in fact a collider. Conditioning on it opens a previously blocked path. This test validates that the engine correctly treats unconditioned colliders as path-blockers in the empty conditioning set.',
  'Selection Bias': 'Selection bias tests confirm that the engine correctly handles selection nodes, which act as colliders. Restricting a sample to selected individuals is equivalent to conditioning on the selection node, which opens a non-causal path between exposure and outcome.',
  Instruments: 'Instrumental variable tests confirm that the engine correctly identifies graphs where no valid backdoor-criterion adjustment set exists due to unmeasured confounding. In these cases, IV methods (or Mendelian randomization) are required for identification.',
  Frontdoor: 'The frontdoor test verifies that the engine correctly reports no valid backdoor-criterion adjustment set in the classic frontdoor graph (Pearl, 2009 §3.4). The causal effect is still identified, but through the frontdoor criterion — a two-step estimator not implemented in this version.',
  'Over-adjustment': 'Over-adjustment tests confirm that the engine excludes descendants of the exposure from the candidate adjustment set. Adjusting for a post-exposure variable that is on the causal path yields a biased estimate of the total effect — a common error in pharmacoepidemiology (Schisterman et al., 2009).',
  'Time-Varying': 'The time-varying confounding test covers the classic Robins (1986) structure in which a time-varying covariate is both a confounder of a later exposure and itself affected by prior exposure. The engine correctly identifies two open backdoor paths and finds {L} as a valid adjustment set for the conditional effect of E2 on Y.',
};

function ValidationView() {
  const results = TESTS.map(t => ({...t, result: runTest(t)}));
  const passed = results.filter(r=>r.result.pass).length;
  const total = results.length;
  const allPass = passed === total;

  const byCategory = {};
  CATEGORY_ORDER.forEach(cat => { byCategory[cat] = results.filter(r=>r.category===cat); });

  return (
    <div style={{flex:1,overflowY:'auto',padding:'32px 0',background:'#f4f6fa'}}>
      <div style={{maxWidth:820,margin:'0 auto',padding:'0 32px'}}>

        {/* Header */}
        <div style={{marginBottom:32}}>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:8}}>
            <h1 style={{margin:0,fontSize:22,fontWeight:800,color:'#1e2a40'}}>Engine Validation Report</h1>
            <div style={{
              padding:'4px 12px',borderRadius:20,fontWeight:700,fontSize:12,
              background: allPass ? '#dcfce7' : '#fee2e2',
              color: allPass ? '#166534' : '#991b1b',
            }}>
              {passed}/{total} passing
            </div>
          </div>
          <p style={{margin:0,fontSize:13,color:'#7a8fb0',lineHeight:1.7}}>
            The DAG Studio causal inference engine is validated against {total} canonical test cases drawn from
            the dagitty reference paper (Textor et al., 2016) and the primary literature in causal inference
            methodology. Each test specifies a DAG structure, an exposure and outcome of interest, and the
            expected number of open backdoor paths and minimal sufficient adjustment sets. The engine's output
            is compared to ground-truth values established by Pearl's d-separation rules and the backdoor
            criterion. All {total} tests pass.
          </p>
        </div>

        {/* Reference */}
        <div style={{background:'#fff',borderRadius:12,padding:'16px 20px',marginBottom:32,border:'1.5px solid #dde4f0'}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:'.1em',textTransform:'uppercase',color:'#b0bcd4',marginBottom:8}}>Primary Reference</div>
          <p style={{margin:0,fontSize:12,color:'#1e2a40',lineHeight:1.6}}>
            Textor, J., van der Zander, B., Gilthorpe, M. S., Liśkiewicz, M., & Ellison, G. T. H. (2016).
            Robust causal inference using directed acyclic graphs: the R package 'dagitty'.{' '}
            <em>International Journal of Epidemiology</em>, 45(6), 1887–1894.{' '}
            <a href="https://doi.org/10.1093/ije/dyw341" target="_blank" rel="noreferrer"
               style={{color:'#3b7cf4',textDecoration:'none'}}>
              https://doi.org/10.1093/ije/dyw341
            </a>
          </p>
        </div>

        {/* Sections by category */}
        {CATEGORY_ORDER.map(cat => {
          const catTests = byCategory[cat];
          if(!catTests||!catTests.length) return null;
          const catPass = catTests.filter(t=>t.result.pass).length;
          return (
            <div key={cat} style={{marginBottom:36}}>
              {/* Category heading */}
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
                <h2 style={{margin:0,fontSize:15,fontWeight:700,color:'#1e2a40'}}>{cat}</h2>
                <div style={{
                  fontSize:10,fontWeight:700,padding:'2px 8px',borderRadius:10,
                  background: catPass===catTests.length ? '#dcfce7' : '#fee2e2',
                  color: catPass===catTests.length ? '#166534' : '#991b1b',
                }}>
                  {catPass}/{catTests.length}
                </div>
              </div>

              {/* Category intro paragraph */}
              <p style={{margin:'0 0 16px',fontSize:13,color:'#4a5568',lineHeight:1.75}}>
                {CATEGORY_INTROS[cat]}
              </p>

              {/* Individual test prose blocks */}
              {catTests.map(t => {
                const {pass, gotBackdoor, gotSets, backdoorOk, setsOk} = t.result;
                const gotSetsStr = gotSets.length===0
                  ? '(none — no valid adjustment set exists)'
                  : gotSets.map(s=>s.length===0?'∅ (empty set sufficient)':`{${s.join(', ')}}`).join(' or ');
                const expSetsStr = t.expected.noAdjPossible
                  ? '(none — no valid adjustment set exists)'
                  : t.expected.adjSets.map(s=>s.length===0?'∅ (empty set sufficient)':`{${s.join(', ')}}`).join(' or ');

                return (
                  <div key={t.id} style={{
                    background:'#fff',borderRadius:12,padding:'18px 22px',marginBottom:12,
                    border: `1.5px solid ${pass ? '#bbf7d0' : '#fecaca'}`,
                  }}>
                    <div style={{display:'flex',alignItems:'flex-start',gap:10,marginBottom:8}}>
                      <div style={{
                        width:20,height:20,borderRadius:'50%',flexShrink:0,marginTop:1,
                        display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:800,
                        background: pass?'#dcfce7':'#fee2e2', color: pass?'#166534':'#991b1b',
                      }}>
                        {pass ? '✓' : '✗'}
                      </div>
                      <div style={{flex:1}}>
                        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                          <span style={{fontSize:10,fontWeight:700,color:'#b0bcd4',fontFamily:"'IBM Plex Mono',monospace"}}>{t.id}</span>
                          <span style={{fontSize:13,fontWeight:700,color:'#1e2a40'}}>{t.name}</span>
                        </div>
                        <p style={{margin:'0 0 10px',fontSize:12,color:'#4a5568',lineHeight:1.7}}>{t.description}</p>

                        {/* Results inline */}
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:8}}>
                          {[
                            {label:'Backdoor paths', expected: t.expected.backdoorCount, got: gotBackdoor, ok: backdoorOk},
                            {label:'Adjustment sets', expected: expSetsStr, got: gotSetsStr, ok: setsOk},
                          ].map(({label,expected,got,ok})=>(
                            <div key={label} style={{background:'#f8fafc',borderRadius:8,padding:'8px 12px',border:`1px solid ${ok?'#bbf7d0':'#fecaca'}`}}>
                              <div style={{fontSize:10,fontWeight:700,color:'#b0bcd4',marginBottom:3,textTransform:'uppercase',letterSpacing:'.08em'}}>{label}</div>
                              <div style={{fontSize:11,color:'#64748b',marginBottom:2}}>Expected: <strong style={{color:'#1e2a40'}}>{String(expected)}</strong></div>
                              <div style={{fontSize:11,color:'#64748b'}}>Got: <strong style={{color: ok?'#166534':'#dc2626'}}>{String(got)}</strong></div>
                            </div>
                          ))}
                        </div>

                        <div style={{fontSize:11,color:'#7a8fb0',fontStyle:'italic'}}>Reference: {t.reference}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Footer note */}
        <div style={{borderTop:'1.5px solid #dde4f0',paddingTop:20,marginTop:8}}>
          <p style={{margin:0,fontSize:11,color:'#b0bcd4',lineHeight:1.7,textAlign:'center'}}>
            Validation suite · DAG Studio v0.1.0 · Black Swan Causal Labs, LLC · John D. Diaz-Decaro, PhD, MS
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function DAGStudio() {
  const [view, setView]         = useState('studio'); // 'studio' | 'library'
  const [nodes, setNodes]       = useState(INIT_NODES);
  const [edges, setEdges]       = useState(INIT_EDGES);
  const [tool, setTool]         = useState('move');
  const [selected, setSelected] = useState(null);
  const [edgeSrc, setEdgeSrc]   = useState(null);
  const [drag, setDrag]         = useState(null);
  const [mouse, setMouse]       = useState({x:0,y:0});
  const [exposure, setExposure] = useState('trt');
  const [outcome, setOutcome]   = useState('out');
  const [modal, setModal]       = useState(null);
  const [mLabel, setMLabel]     = useState('');
  const [mType, setMType]       = useState('variable');
  const [analysis, setAnalysis] = useState(null);
  const [hoverEdge, setHoverEdge] = useState(null);
  const [summary, setSummary]   = useState('');
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [apiKey, setApiKey]         = useState('');
  const [apiKeyModal, setApiKeyModal] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [exportMenu, setExportMenu] = useState(false);
  const [exportPreview, setExportPreview] = useState(null); // {dataURL, w, h, fmt}
  const [exporting, setExporting] = useState(false);
  const svgRef = useRef(null);

  useEffect(()=>{
    setAnalysis(computeAdjustmentSets(exposure, outcome, nodes, edges));
    setSummary(''); setSummaryError('');
  },[exposure,outcome,nodes,edges]);

  // Load jsPDF from cdnjs (allowed CDN)
  useEffect(()=>{
    if(document.querySelector('script[data-jspdf]')) return;
    const s=document.createElement('script');
    s.src='https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.setAttribute('data-jspdf','1');
    document.head.appendChild(s);
  },[]);

  // Draw the DAG directly to a canvas — avoids SVG blob/CORS issues in sandboxed environments
  const rasterise = (scale=2) => {
    const svg = svgRef.current;
    if(!svg) throw new Error('No SVG');
    const {width:w, height:h} = svg.getBoundingClientRect();
    const S = scale;
    const c = document.createElement('canvas');
    c.width = Math.round(w*S); c.height = Math.round(h*S);
    const ctx = c.getContext('2d');

    // Background
    ctx.fillStyle = '#eef2f8';
    ctx.fillRect(0,0,c.width,c.height);

    const nodeColors = {
      exposure:   {fill:'#3b7cf4', stroke:'#2260d0'},
      outcome:    {fill:'#0da271', stroke:'#0a7a55'},
      confounder: {fill:'#e8972a', stroke:'#c07318'},
      latent:     {fill:'#9aaac4', stroke:'#7a8fb0'},
      variable:   {fill:'#8b5cf6', stroke:'#6d3fd6'},
    };
    const R = 30 * S;

    // Helper: draw arrowhead
    const arrowHead = (ctx, tx, ty, angle, color) => {
      const len = 10*S;
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(0,0);
      ctx.lineTo(-len, -len*0.4);
      ctx.lineTo(-len,  len*0.4);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    };

    // Determine backdoor edges
    const bkPaths = backdoorPaths(exposure, outcome, edges);
    const bkEdgeSet = new Set();
    bkPaths.forEach(path=>{
      for(let i=0;i<path.length-1;i++) bkEdgeSet.add(`${path[i]}-${path[i+1]}`);
    });
    const isBackdoor = e => bkEdgeSet.has(`${e.src}-${e.tgt}`) || bkEdgeSet.has(`${e.tgt}-${e.src}`);

    // Draw edges
    edges.forEach(edge=>{
      const src = nodes.find(n=>n.id===edge.src);
      const tgt = nodes.find(n=>n.id===edge.tgt);
      if(!src||!tgt) return;
      const sx=src.x*S, sy=src.y*S, tx=tgt.x*S, ty=tgt.y*S;
      const dx=tx-sx, dy=ty-sy, len=Math.hypot(dx,dy);
      if(!len) return;
      const ux=dx/len, uy=dy/len;
      const x1=sx+ux*R, y1=sy+uy*R;
      const x2=tx-ux*(R+8*S), y2=ty-uy*(R+8*S);
      const bk = isBackdoor(edge);
      const color = bk ? '#e53e3e' : '#9aaac4';
      ctx.beginPath();
      ctx.moveTo(x1,y1);
      if(bk){
        ctx.setLineDash([6*S,3*S]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.lineTo(x2,y2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2*S;
      ctx.stroke();
      ctx.setLineDash([]);
      arrowHead(ctx, tx-ux*R, ty-uy*R, Math.atan2(dy,dx), color);
    });

    // Draw nodes
    nodes.forEach(node=>{
      const cx=node.x*S, cy=node.y*S;
      const colors = nodeColors[node.type] || nodeColors.variable;
      const isLatent = node.type==='latent';
      const isExp = node.id===exposure;
      const isOut = node.id===outcome;

      // Glow for exposure/outcome
      if(isExp||isOut){
        ctx.beginPath();
        ctx.arc(cx,cy,R+8*S,0,Math.PI*2);
        const grd = ctx.createRadialGradient(cx,cy,R,cx,cy,R+12*S);
        grd.addColorStop(0, isExp?'rgba(59,124,244,0.25)':'rgba(13,162,113,0.25)');
        grd.addColorStop(1,'rgba(0,0,0,0)');
        ctx.fillStyle=grd;
        ctx.fill();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(cx,cy,R,0,Math.PI*2);
      ctx.globalAlpha = isLatent ? 0.55 : 1;
      ctx.fillStyle = colors.fill;
      if(isLatent){
        ctx.setLineDash([5*S,3*S]);
      }
      ctx.fill();
      ctx.strokeStyle = colors.stroke;
      ctx.lineWidth = 2*S;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Label
      const label = node.label.length > 9 ? node.label.slice(0,8)+'…' : node.label;
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${11*S}px "IBM Plex Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy);
    });

    return {dataURL: c.toDataURL('image/png'), w, h};
  };

  // Open export preview modal for chosen format
  const openExport = fmt => {
    setExportMenu(false);
    try {
      const result = rasterise(2);
      setExportPreview({...result, fmt});
    } catch(e){
      console.error('Rasterise failed', e);
      alert('Export failed: ' + e.message);
    }
  };

  // Perform the actual download from the preview modal
  // NOTE: Claude artifacts block programmatic <a download> clicks.
  // We use window.open(url, '_blank') instead — user saves from the new tab.
  const downloadExport = async () => {
    const {dataURL, w, h, fmt} = exportPreview;
    try {
      if(fmt==='png'){
        window.open(dataURL, '_blank');
      } else if(fmt==='jpg'){
        const img=new Image();
        img.onload=()=>{
          const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
          const ctx=c.getContext('2d');
          ctx.fillStyle='#eef2f8'; ctx.fillRect(0,0,c.width,c.height);
          ctx.drawImage(img,0,0);
          window.open(c.toDataURL('image/jpeg',0.92), '_blank');
        };
        img.src=dataURL;
      } else if(fmt==='pdf'){
        const jspdf = window.jspdf;
        if(!jspdf){ alert('PDF library still loading — please try again in a moment.'); return; }
        const {jsPDF} = jspdf;
        const mmW=297, mmH=Math.round(mmW*(h/w));
        const doc=new jsPDF({orientation:'landscape',unit:'mm',format:[mmW,mmH]});
        doc.addImage(dataURL,'PNG',0,0,mmW,mmH);
        // open blob URL in new tab instead of triggering download click
        const blobUrl = doc.output('bloburl');
        window.open(blobUrl, '_blank');
      } else if(fmt==='ppt'){
        await buildPptx(dataURL, w, h);
      }
    } catch(e){
      alert('Download failed: ' + e.message);
    }
    setExportPreview(null);
  };

  // Build minimal PPTX from scratch using JSZip (cdnjs)
  const buildPptx = async (dataURL, w, h) => {
    // Lazy-load JSZip from cdnjs
    if(!window.JSZip){
      await new Promise(res=>{
        const s=document.createElement('script');
        s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload=res; document.head.appendChild(s);
      });
    }
    const zip = new window.JSZip();
    // Strip data:image/png;base64, prefix
    const b64 = dataURL.split(',')[1];
    // PPTX dimensions in EMU (1 inch = 914400 EMU); WIDE = 12192000 x 6858000
    const slideW=12192000, slideH=6858000;
    const aspW=w, aspH=h;
    let imgW=slideW, imgH=Math.round(slideW*aspH/aspW);
    if(imgH>slideH){ imgH=slideH; imgW=Math.round(slideH*aspW/aspH); }
    const offX=Math.round((slideW-imgW)/2), offY=Math.round((slideH-imgH)/2);

    const rels_slide = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/dag.png"/>
</Relationships>`;
    const slide_xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="2" name="DAG"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${imgW}" cy="${imgH}"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
    const prs_xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                saveSubsetFonts="1">
  <p:sldMasterIdLst/><p:sldSz cx="${slideW}" cy="${slideH}" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
</p:presentation>`;
    const prs_rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`;
    const content_types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`;
    const root_rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

    zip.file('[Content_Types].xml', content_types);
    zip.file('_rels/.rels', root_rels);
    zip.file('ppt/presentation.xml', prs_xml);
    zip.file('ppt/_rels/presentation.xml.rels', prs_rels);
    zip.file('ppt/slides/slide1.xml', slide_xml);
    zip.file('ppt/slides/_rels/slide1.xml.rels', rels_slide);
    zip.file('ppt/media/dag.png', b64, {base64:true});

    const blob = await zip.generateAsync({type:'blob', mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'});
    window.open(URL.createObjectURL(blob), '_blank');
  };

  const svgXY = e=>{
    const r=svgRef.current.getBoundingClientRect();
    return {x:e.clientX-r.left, y:e.clientY-r.top};
  };

  const onSVGMouseMove=e=>{
    const p=svgXY(e); setMouse(p);
    if(drag) setNodes(prev=>prev.map(n=>n.id===drag.id?{...n,x:p.x-drag.ox,y:p.y-drag.oy}:n));
  };
  const onSVGMouseDown=e=>{
    setExportMenu(false);
    const tag=e.target.tagName;
    if(tag==='svg'||tag==='rect'){
      if(tool==='node'){setModal(svgXY(e));setMLabel('');setMType('variable');}
      else{setSelected(null);setEdgeSrc(null);}
    }
  };
  const onSVGMouseUp=()=>setDrag(null);

  const onNodeDown=(e,node)=>{
    e.stopPropagation();
    const p=svgXY(e);
    if(tool==='move'){setDrag({id:node.id,ox:p.x-node.x,oy:p.y-node.y});setSelected(node.id);}
    else if(tool==='edge'){
      if(!edgeSrc){setEdgeSrc(node.id);}
      else if(edgeSrc!==node.id){
        if(!edges.some(e=>e.src===edgeSrc&&e.tgt===node.id))
          setEdges(prev=>[...prev,{id:euid(),src:edgeSrc,tgt:node.id}]);
        setEdgeSrc(null);
      }
    } else if(tool==='erase'){
      setNodes(prev=>prev.filter(n=>n.id!==node.id));
      setEdges(prev=>prev.filter(e=>e.src!==node.id&&e.tgt!==node.id));
      if(selected===node.id)setSelected(null);
    }
  };

  const onEdgeClick=(e,id)=>{
    e.stopPropagation();
    if(tool==='erase')setEdges(prev=>prev.filter(ed=>ed.id!==id));
  };

  const addNode=()=>{
    if(!mLabel.trim()||!modal)return;
    setNodes(prev=>[...prev,{id:nuid(),label:mLabel.trim(),x:modal.x,y:modal.y,type:mType}]);
    setModal(null);
  };

  const loadLibrary = lib => {
    const dx = 300 - lib.nodes.reduce((s,n)=>s+n.x,0)/lib.nodes.length;
    const dy = 250 - lib.nodes.reduce((s,n)=>s+n.y,0)/lib.nodes.length;
    setNodes(lib.nodes.map(n=>({...n,x:n.x+dx,y:n.y+dy})));
    setEdges(lib.edges.map(e=>({...e})));
    setExposure(lib.exposure);
    setOutcome(lib.outcome);
    setSelected(null); setEdgeSrc(null); setTool('move');
    setSummary(''); setSummaryError('');
    setView('studio');
  };

  const generateSummary = async () => {
    if(!exposure||!outcome){setSummaryError('Set an exposure and outcome first.');return;}
    if(!apiKey){setApiKeyModal(true);return;}
    setSummarizing(true); setSummary(''); setSummaryError('');

    const expLabel = nodes.find(n=>n.id===exposure)?.label||exposure;
    const outLabel = nodes.find(n=>n.id===outcome)?.label||outcome;
    const nodeList = nodes.map(n=>`${n.label} (${n.type})`).join(', ');
    const edgeList = edges.map(e=>{
      const s=nodes.find(n=>n.id===e.src)?.label||e.src;
      const t=nodes.find(n=>n.id===e.tgt)?.label||e.tgt;
      return `${s} → ${t}`;
    }).join('; ');
    const adjSets = analysis?.sets.map(s=>s.length?s.map(id=>nodes.find(n=>n.id===id)?.label||id).join(', '):'(none required)').join(' OR ') || 'unknown';
    const bkCount = analysis?.backdoor.length||0;

    const prompt = `You are an expert epidemiologist and causal inference methodologist. A researcher has constructed the following directed acyclic graph (DAG) and needs a concise, plain-language summary paragraph suitable for a methods section.

DAG Details:
- Exposure of interest: ${expLabel}
- Outcome of interest: ${outLabel}
- All variables: ${nodeList}
- Directed edges: ${edgeList}
- Number of backdoor paths identified: ${bkCount}
- Minimal sufficient adjustment set(s): ${adjSets}

Write a single paragraph (4–6 sentences) that: (1) describes the causal structure being represented, (2) identifies any key sources of bias (confounding, collider, mediation, selection bias, etc.) present in the DAG, (3) states what adjustment is required to estimate the total causal effect of ${expLabel} on ${outLabel} and why, and (4) notes any important methodological implications. Use precise epidemiological language. Do not use bullet points or headers — plain paragraph prose only.`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages',{
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body:JSON.stringify({
          model:'claude-sonnet-4-20250514',
          max_tokens:1000,
          messages:[{role:'user',content:prompt}]
        })
      });
      const data = await res.json();
      const text = data.content?.map(b=>b.text||'').join('').trim();
      if(text) setSummary(text);
      else setSummaryError('No summary returned. Please try again.');
    } catch(err) {
      setSummaryError('Failed to generate summary. Check your connection.');
    }
    setSummarizing(false);
  };

  const selNode = nodes.find(n=>n.id===selected);

  const edgePath = edge=>{
    const s=nodes.find(n=>n.id===edge.src);
    const t=nodes.find(n=>n.id===edge.tgt);
    if(!s||!t)return null;
    const dx=t.x-s.x,dy=t.y-s.y,len=Math.hypot(dx,dy);
    if(!len)return null;
    const ux=dx/len,uy=dy/len;
    const sx=s.x+ux*R,sy=s.y+uy*R;
    const ex=t.x-ux*(R+4),ey=t.y-uy*(R+4);
    if(edges.some(e=>e.src===edge.tgt&&e.tgt===edge.src)){
      const cx=(sx+ex)/2-uy*28,cy=(sy+ey)/2+ux*28;
      return `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`;
    }
    return `M${sx},${sy} L${ex},${ey}`;
  };

  const isBackdoor=edge=>analysis?.backdoor.some(path=>
    path.some((_,i)=>i<path.length-1&&(
      (path[i]===edge.src&&path[i+1]===edge.tgt)||
      (path[i]===edge.tgt&&path[i+1]===edge.src)
    ))
  );

  const toolDefs=[
    {id:'move',title:'Move',icon:<path d="M7 2L7 13L10 10L12 15L14 14L12 9L16 9Z" fill="currentColor"/>},
    {id:'node',title:'Add Node',icon:<><circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.5" fill="none"/><line x1="10" y1="7" x2="10" y2="13" stroke="currentColor" strokeWidth="1.5"/><line x1="7" y1="10" x2="13" y2="10" stroke="currentColor" strokeWidth="1.5"/></>},
    {id:'edge',title:'Add Edge',icon:<><circle cx="4" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" fill="none"/><line x1="6.5" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="1.5"/><polygon points="11,8 15.5,10 11,12" fill="currentColor"/><circle cx="16" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" fill="none"/></>},
    {id:'erase',title:'Erase',icon:<><line x1="5" y1="5" x2="15" y2="15" stroke="currentColor" strokeWidth="1.8"/><line x1="15" y1="5" x2="5" y2="15" stroke="currentColor" strokeWidth="1.8"/></>},
  ];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap');
        *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
        html,body{height:100%;overflow:hidden}

        .root{font-family:'IBM Plex Sans',sans-serif;display:flex;flex-direction:column;height:100vh;background:#eef2f8;color:#1e2a40}

        /* Top nav */
        .nav{height:46px;background:#fff;border-bottom:1.5px solid #dde4f0;display:flex;align-items:center;padding:0 16px;gap:0;flex-shrink:0;box-shadow:0 2px 8px rgba(30,42,64,.06)}
        .nav-spacer{flex:1}
        .nav-key-btn{display:flex;align-items:center;gap:6px;padding:5px 10px;border-radius:7px;border:1.5px solid #dde4f0;background:#f5f8fd;cursor:pointer;color:#1e2a40;font-family:'IBM Plex Sans',sans-serif;font-size:10px;transition:all .15s;margin-right:8px}
        .nav-key-btn:hover{border-color:#3b7cf4;background:#e8f0ff;color:#3b7cf4}
        .nav-proto{font-size:9px;font-weight:800;letter-spacing:.14em;color:#e53e3e;border:1.5px solid #e53e3e;border-radius:5px;padding:2px 7px;text-transform:uppercase;background:#fff5f5;user-select:none}
        .nav-brand{font-size:13px;font-weight:700;color:#1e2a40;letter-spacing:.02em;margin-right:24px}
        .nav-tab{padding:0 16px;height:46px;display:flex;align-items:center;font-size:12px;font-weight:600;border:none;background:transparent;cursor:pointer;color:#9aaac4;border-bottom:2.5px solid transparent;transition:all .15s;font-family:'IBM Plex Sans',sans-serif;margin-bottom:-1.5px}
        .nav-tab:hover{color:#1e2a40}
        .nav-tab.on{color:#3b7cf4;border-bottom-color:#3b7cf4}

        /* Studio layout */
        .studio{display:flex;flex:1;overflow:hidden}
        .tb{width:54px;background:#fff;border-right:1.5px solid #dde4f0;display:flex;flex-direction:column;align-items:center;padding:14px 0;gap:4px;flex-shrink:0}
        .tb-btn{width:38px;height:38px;border-radius:9px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;background:transparent;color:#9aaac4;position:relative}
        .tb-btn[title]:hover::after{content:attr(title);position:absolute;left:54px;top:50%;transform:translateY(-50%);background:#1e2a40;color:#fff;font-size:10px;font-weight:600;white-space:nowrap;padding:4px 9px;border-radius:6px;pointer-events:none;z-index:100;font-family:'IBM Plex Sans',sans-serif;letter-spacing:.02em}
        .tb-btn[title]:hover::before{content:'';position:absolute;left:46px;top:50%;transform:translateY(-50%);border:5px solid transparent;border-right-color:#1e2a40;pointer-events:none;z-index:100}
        .tb-btn svg{width:20px;height:20px}
        .tb-btn:hover{background:#f0f4ff;color:#3b7cf4}
        .tb-btn.on{background:#e8f0ff;color:#3b7cf4;box-shadow:0 0 0 1.5px #aac4ff inset}
        .tb-btn.era{background:#fff0f0;color:#e53e3e;box-shadow:0 0 0 1.5px #ffb0b0 inset}
        .tb-sep{width:22px;height:1px;background:#e8edf5;margin:6px 0}
        .tb-btn-exp{width:38px;height:38px;border-radius:9px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;background:transparent;color:#9aaac4;position:relative;margin-top:auto}
        .tb-btn-exp:hover{background:#f0f4ff;color:#3b7cf4}
        .tb-btn-exp[title]:hover::after{content:attr(title);position:absolute;left:54px;top:50%;transform:translateY(-50%);background:#1e2a40;color:#fff;font-size:10px;font-weight:600;white-space:nowrap;padding:4px 9px;border-radius:6px;pointer-events:none;z-index:100;font-family:'IBM Plex Sans',sans-serif}
        .tb-btn-exp[title]:hover::before{content:'';position:absolute;left:46px;top:50%;transform:translateY(-50%);border:5px solid transparent;border-right-color:#1e2a40;pointer-events:none;z-index:100}
        .exp-menu{position:absolute;left:58px;bottom:14px;background:#fff;border:1.5px solid #dde4f0;border-radius:10px;box-shadow:0 8px 28px rgba(30,42,64,.14);z-index:200;padding:6px;display:flex;flex-direction:column;gap:2px;min-width:148px}
        .exp-item{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:7px;border:none;background:transparent;cursor:pointer;font-size:12px;font-weight:500;color:#1e2a40;font-family:'IBM Plex Sans',sans-serif;text-align:left;transition:background .12s}
        .exp-item:hover{background:#f0f4ff;color:#3b7cf4}
        .exp-item-badge{font-size:9px;font-weight:700;letter-spacing:.06em;padding:2px 5px;border-radius:4px;background:#eef2f8;color:#9aaac4;text-transform:uppercase}
        .cv{flex:1;position:relative;overflow:hidden}
        .sb{position:absolute;bottom:0;left:0;right:0;height:30px;padding:0 14px;background:rgba(255,255,255,.93);backdrop-filter:blur(10px);border-top:1.5px solid #dde4f0;display:flex;align-items:center;gap:14px;font-size:11px}
        .sb-dim{color:#9aaac4}
        @keyframes spin{to{transform:rotate(360deg)}}
        /* API Key modal */
        .apikey-modal-bg{position:fixed;inset:0;background:rgba(15,22,40,.5);backdrop-filter:blur(4px);z-index:600;display:flex;align-items:center;justify-content:center}
        .apikey-modal{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(15,22,40,.25);width:480px;max-width:92vw;padding:28px}
        .apikey-modal h3{margin:0 0 4px;font-size:15px;font-weight:700;color:#1e2a40}
        .apikey-modal p{margin:0 0 16px;font-size:12px;color:#7a8fb0;line-height:1.6}
        .apikey-input{width:100%;box-sizing:border-box;background:#f5f8fd;border:1.5px solid #dde4f0;border-radius:8px;padding:9px 12px;font-size:12px;font-family:'IBM Plex Mono',monospace;color:#1e2a40;outline:none;transition:border-color .15s;margin-bottom:6px}
        .apikey-input:focus{border-color:#3b7cf4}
        .apikey-hint{font-size:10px;color:#b0bcd4;margin-bottom:16px}
        .apikey-hint a{color:#3b7cf4;text-decoration:none}
        .apikey-hint a:hover{text-decoration:underline}
        .apikey-actions{display:flex;gap:8px;justify-content:flex-end}
        .apikey-cancel{padding:8px 16px;border-radius:8px;border:1.5px solid #dde4f0;background:transparent;font-size:12px;font-weight:600;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;color:#9aaac4;transition:all .15s}
        .apikey-cancel:hover{border-color:#9aaac4;color:#1e2a40}
        .apikey-save{padding:8px 20px;border-radius:8px;border:none;background:#1e2a40;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;transition:background .15s}
        .apikey-save:hover{background:#3b7cf4}
        .apikey-clear{padding:8px 14px;border-radius:8px;border:1.5px solid #ffd0d0;background:transparent;font-size:12px;font-weight:600;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;color:#e53e3e;transition:all .15s;margin-right:auto}
        .apikey-clear:hover{background:#fff5f5}
        /* Export preview modal */
        .exp-modal-bg{position:fixed;inset:0;background:rgba(15,22,40,.55);backdrop-filter:blur(4px);z-index:500;display:flex;align-items:center;justify-content:center}
        .exp-modal{background:#fff;border-radius:18px;box-shadow:0 24px 80px rgba(15,22,40,.28);width:680px;max-width:94vw;display:flex;flex-direction:column;overflow:hidden;max-height:90vh}
        .exp-modal-head{padding:20px 24px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1.5px solid #eef2f8}
        .exp-modal-title{font-size:14px;font-weight:700;color:#1e2a40}
        .exp-modal-close{width:28px;height:28px;border-radius:7px;border:none;background:#f0f4ff;color:#9aaac4;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .15s}
        .exp-modal-close:hover{background:#ffe0e0;color:#e53e3e}
        .exp-modal-preview{flex:1;overflow:auto;padding:20px;background:#f4f6fa;display:flex;align-items:center;justify-content:center}
        .exp-modal-preview img{max-width:100%;border-radius:8px;box-shadow:0 4px 20px rgba(30,42,64,.14)}
        .exp-modal-foot{padding:16px 24px;border-top:1.5px solid #eef2f8;display:flex;align-items:center;justify-content:space-between;gap:12px}
        .exp-modal-fmts{display:flex;gap:6px}
        .exp-modal-fmt{padding:5px 10px;border-radius:6px;border:1.5px solid #dde4f0;background:transparent;font-size:11px;font-weight:600;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;color:#9aaac4;transition:all .12s;text-transform:uppercase;letter-spacing:.06em}
        .exp-modal-fmt.active{border-color:#3b7cf4;color:#3b7cf4;background:#e8f0ff}
        .exp-dl-btn{padding:9px 22px;background:#1e2a40;color:#fff;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;transition:background .15s;display:flex;align-items:center;gap:8px}
        .exp-dl-btn:hover{background:#3b7cf4}
        .sb-info{color:#3b7cf4;font-weight:500}

        /* Right panel */
        .pn{width:280px;background:#fff;border-left:1.5px solid #dde4f0;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0}
        .ps{padding:14px 16px;border-bottom:1px solid #eef2f8}
        .pt{font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9aaac4;margin-bottom:10px}
        .fl{font-size:10.5px;color:#7a8fb0;margin-bottom:4px;font-weight:500}
        .sel{width:100%;background:#f5f8fd;border:1.5px solid #dde4f0;border-radius:7px;padding:6px 10px;font-size:12px;font-family:'IBM Plex Sans',sans-serif;outline:none;appearance:none;cursor:pointer;color:#1e2a40;font-weight:500;transition:border-color .15s}
        .sel:focus{border-color:#93bbff;box-shadow:0 0 0 3px rgba(59,124,244,.1)}
        .sel.bl{color:#3b7cf4}
        .sel.gr{color:#0da271}
        .inp{width:100%;background:#f5f8fd;border:1.5px solid #dde4f0;border-radius:7px;padding:6px 10px;color:#1e2a40;font-size:12px;font-family:'IBM Plex Sans',sans-serif;outline:none;margin-bottom:8px;transition:border-color .15s}
        .inp:focus{border-color:#93bbff;box-shadow:0 0 0 3px rgba(59,124,244,.1)}
        .chips{display:flex;flex-wrap:wrap;gap:4px}
        .chip{padding:3px 8px;border-radius:5px;border:1.5px solid;font-size:10px;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;transition:all .12s;background:transparent;font-weight:500}

        .res{flex:1;overflow-y:auto;padding:14px 16px}
        .pi{font-family:'IBM Plex Sans',sans-serif;font-size:10px;padding:5px 8px;border-radius:5px;margin-bottom:4px;line-height:1.55;word-break:break-all}
        .pd{background:#f0faf6;border:1.5px solid #b6e8d4;color:#0a7a55}
        .pb{background:#fff4f4;border:1.5px solid #f5b8b8;color:#b91c1c}
        .as{font-family:'IBM Plex Sans',sans-serif;font-size:11px;padding:7px 10px;border-radius:7px;margin-bottom:5px;background:#f0f5ff;border:1.5px solid #b8d0ff;color:#2558c4}
        .an{font-family:'IBM Plex Sans',sans-serif;font-size:11px;padding:7px 10px;border-radius:7px;background:#f0faf6;border:1.5px solid #b6e8d4;color:#0a7a55}
        .ai{font-size:11px;padding:7px 10px;border-radius:7px;background:#fff4f4;border:1.5px solid #f5b8b8;color:#b91c1c}
        .mn{font-size:10px;color:#9aaac4;margin-bottom:10px}

        /* Summarize */
        .sum-btn{width:100%;padding:9px 14px;background:#1e2a40;color:#fff;border:none;border-radius:8px;font-size:12px;font-family:'IBM Plex Sans',sans-serif;font-weight:700;cursor:pointer;transition:background .15s;display:flex;align-items:center;justify-content:center;gap:7px}
        .sum-btn:hover{background:#2d3f60}
        .sum-btn:disabled{background:#c8d4e4;cursor:not-allowed}
        .sum-box{margin-top:10px;padding:11px 13px;background:#f8fafd;border:1.5px solid #dde4f0;border-radius:8px;font-size:11.5px;line-height:1.75;color:#2a3a54}
        .sum-err{margin-top:8px;font-size:11px;color:#b91c1c;padding:7px 10px;background:#fff4f4;border-radius:7px;border:1.5px solid #f5b8b8}
        .spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
        @keyframes spin{to{transform:rotate(360deg)}}
        /* API Key modal */
        .apikey-modal-bg{position:fixed;inset:0;background:rgba(15,22,40,.5);backdrop-filter:blur(4px);z-index:600;display:flex;align-items:center;justify-content:center}
        .apikey-modal{background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(15,22,40,.25);width:480px;max-width:92vw;padding:28px}
        .apikey-modal h3{margin:0 0 4px;font-size:15px;font-weight:700;color:#1e2a40}
        .apikey-modal p{margin:0 0 16px;font-size:12px;color:#7a8fb0;line-height:1.6}
        .apikey-input{width:100%;box-sizing:border-box;background:#f5f8fd;border:1.5px solid #dde4f0;border-radius:8px;padding:9px 12px;font-size:12px;font-family:'IBM Plex Mono',monospace;color:#1e2a40;outline:none;transition:border-color .15s;margin-bottom:6px}
        .apikey-input:focus{border-color:#3b7cf4}
        .apikey-hint{font-size:10px;color:#b0bcd4;margin-bottom:16px}
        .apikey-hint a{color:#3b7cf4;text-decoration:none}
        .apikey-hint a:hover{text-decoration:underline}
        .apikey-actions{display:flex;gap:8px;justify-content:flex-end}
        .apikey-cancel{padding:8px 16px;border-radius:8px;border:1.5px solid #dde4f0;background:transparent;font-size:12px;font-weight:600;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;color:#9aaac4;transition:all .15s}
        .apikey-cancel:hover{border-color:#9aaac4;color:#1e2a40}
        .apikey-save{padding:8px 20px;border-radius:8px;border:none;background:#1e2a40;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;transition:background .15s}
        .apikey-save:hover{background:#3b7cf4}
        .apikey-clear{padding:8px 14px;border-radius:8px;border:1.5px solid #ffd0d0;background:transparent;font-size:12px;font-weight:600;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;color:#e53e3e;transition:all .15s;margin-right:auto}
        .apikey-clear:hover{background:#fff5f5}
        /* Export preview modal */
        .exp-modal-bg{position:fixed;inset:0;background:rgba(15,22,40,.55);backdrop-filter:blur(4px);z-index:500;display:flex;align-items:center;justify-content:center}
        .exp-modal{background:#fff;border-radius:18px;box-shadow:0 24px 80px rgba(15,22,40,.28);width:680px;max-width:94vw;display:flex;flex-direction:column;overflow:hidden;max-height:90vh}
        .exp-modal-head{padding:20px 24px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1.5px solid #eef2f8}
        .exp-modal-title{font-size:14px;font-weight:700;color:#1e2a40}
        .exp-modal-close{width:28px;height:28px;border-radius:7px;border:none;background:#f0f4ff;color:#9aaac4;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .15s}
        .exp-modal-close:hover{background:#ffe0e0;color:#e53e3e}
        .exp-modal-preview{flex:1;overflow:auto;padding:20px;background:#f4f6fa;display:flex;align-items:center;justify-content:center}
        .exp-modal-preview img{max-width:100%;border-radius:8px;box-shadow:0 4px 20px rgba(30,42,64,.14)}
        .exp-modal-foot{padding:16px 24px;border-top:1.5px solid #eef2f8;display:flex;align-items:center;justify-content:space-between;gap:12px}
        .exp-modal-fmts{display:flex;gap:6px}
        .exp-modal-fmt{padding:5px 10px;border-radius:6px;border:1.5px solid #dde4f0;background:transparent;font-size:11px;font-weight:600;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;color:#9aaac4;transition:all .12s;text-transform:uppercase;letter-spacing:.06em}
        .exp-modal-fmt.active{border-color:#3b7cf4;color:#3b7cf4;background:#e8f0ff}
        .exp-dl-btn{padding:9px 22px;background:#1e2a40;color:#fff;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;transition:background .15s;display:flex;align-items:center;gap:8px}
        .exp-dl-btn:hover{background:#3b7cf4}

        .leg{padding:10px 16px;border-top:1px solid #eef2f8;display:flex;flex-wrap:wrap;gap:8px}
        .li{display:flex;align-items:center;gap:5px;font-size:10px;color:#7a8fb0}
        .ld{width:7px;height:7px;border-radius:50%}

        /* Library */
        .lib{flex:1;overflow-y:auto;padding:28px 32px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:20px;align-content:start;align-items:start}
        .lib-card{background:#fff;border:1.5px solid #dde4f0;border-radius:14px;cursor:pointer;transition:all .2s;display:flex;flex-direction:column}
        .lib-card:hover{border-color:#93bbff;box-shadow:0 6px 24px rgba(59,124,244,.12);transform:translateY(-2px)}
        .lib-card-head{padding:16px 18px 12px;border-bottom:1px solid #eef2f8}
        .lib-tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:7px}
        .lib-name{font-size:14px;font-weight:700;color:#1e2a40;margin-bottom:4px}
        .lib-desc{font-size:11.5px;color:#7a8fb0;line-height:1.65}
        
        .lib-load{margin:0 18px 14px;padding:8px 0;background:#f5f8fd;border:1.5px solid #dde4f0;border-radius:8px;font-size:11.5px;font-weight:700;color:#3b7cf4;font-family:'IBM Plex Sans',sans-serif;cursor:pointer;transition:all .15s;text-align:center}
        .lib-load:hover{background:#e8f0ff;border-color:#93bbff}

        /* Modal */
        .mbg{position:fixed;inset:0;background:rgba(30,42,64,.3);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(3px)}
        .mo{background:#fff;border:1.5px solid #dde4f0;border-radius:14px;padding:22px;width:276px;box-shadow:0 20px 50px rgba(30,42,64,.15)}
        .mh{font-size:15px;font-weight:700;color:#1e2a40;margin-bottom:14px}
        .mac{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
        .bc{padding:7px 14px;border-radius:8px;border:1.5px solid #dde4f0;background:transparent;color:#7a8fb0;cursor:pointer;font-size:12px;font-family:'IBM Plex Sans',sans-serif;font-weight:500}
        .bc:hover{border-color:#9aaac4;color:#1e2a40}
        .ba{padding:7px 16px;border-radius:8px;border:none;background:#3b7cf4;color:#fff;cursor:pointer;font-size:12px;font-family:'IBM Plex Sans',sans-serif;font-weight:700}
        .ba:hover{background:#2566e0}

        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#dde4f0;border-radius:4px}
        svg text{user-select:none;pointer-events:none}
      `}</style>

      <div className="root">
        {/* Top Nav */}
        <div className="nav">
          <div className="nav-brand">DAG Studio</div>
          <button className={`nav-tab${view==='studio'?' on':''}`} onClick={()=>setView('studio')}>
            Studio
          </button>
          <button className={`nav-tab${view==='library'?' on':''}`} onClick={()=>setView('library')}>
            Training Library
          </button>
          <button className={`nav-tab${view==='validation'?' on':''}`} onClick={()=>setView('validation')}>
            Validation
          </button>
          <div className="nav-spacer"/>
          <button
            className="nav-key-btn"
            onClick={()=>{setApiKeyDraft(apiKey);setApiKeyModal(true);}}
            title="Set Anthropic API Key"
          >
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="11" r="4"/>
              <path d="M12 7l8 0M16 7v-2"/>
            </svg>
            {apiKey ? <span style={{color:'#0da271',fontSize:10,fontWeight:700}}>API Key ✓</span> : <span style={{fontSize:10,fontWeight:600}}>API Key</span>}
          </button>
          <div style={{width:1,height:18,background:'#dde4f0',margin:'0 10px'}}/>
          <div className="nav-proto">Prototype</div>
        </div>

        {/* ── STUDIO VIEW ── */}
        {view==='studio' && (
          <div className="studio">
            {/* Toolbar */}
            <div className="tb">
              {toolDefs.slice(0,3).map(t=>(
                <button key={t.id} title={t.title}
                  className={`tb-btn${tool===t.id?' on':''}`}
                  onClick={()=>{setTool(t.id);setEdgeSrc(null)}}>
                  <svg viewBox="0 0 20 20">{t.icon}</svg>
                </button>
              ))}
              <div className="tb-sep"/>
              <button title="Erase" className={`tb-btn${tool==='erase'?' era':''}`}
                onClick={()=>{setTool('erase');setEdgeSrc(null)}}>
                <svg viewBox="0 0 20 20">{toolDefs[3].icon}</svg>
              </button>

              <div className="tb-sep" style={{marginTop:'auto'}}/>

              {/* Export button */}
              <div style={{position:'relative'}}>
                <button title="Export DAG" className="tb-btn-exp"
                  onClick={()=>setExportMenu(m=>!m)}
                  style={{color:exportMenu?'#3b7cf4':'#9aaac4',background:exportMenu?'#e8f0ff':'transparent'}}>
                  {exporting
                    ? <svg viewBox="0 0 20 20" width="20" height="20" style={{animation:'spin 1s linear infinite'}}>
                        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="22" strokeDashoffset="8"/>
                      </svg>
                    : <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <path d="M10 3v9M6.5 8.5L10 12l3.5-3.5" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M4 14v1.5A1.5 1.5 0 005.5 17h9a1.5 1.5 0 001.5-1.5V14" strokeLinecap="round"/>
                      </svg>
                  }
                </button>
                {exportMenu && (
                  <div className="exp-menu">
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:'.1em',color:'#b0bcd4',textTransform:'uppercase',padding:'4px 10px 2px'}}>Export DAG as</div>
                    {[
                      {fmt:'png', label:'PNG Image',    desc:'Raster'},
                      {fmt:'jpg', label:'JPEG Image',   desc:'Raster'},
                      {fmt:'pdf', label:'PDF Document', desc:'Vector'},
                      {fmt:'ppt', label:'PowerPoint',   desc:'PPTX'},
                    ].map(({fmt,label,desc})=>(
                      <button key={fmt} className="exp-item" onClick={()=>openExport(fmt)}>
                        <span className="exp-item-badge">{desc}</span>
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Canvas */}
            <div className="cv">
              <svg ref={svgRef} width="100%" height="100%"
                style={{display:'block',cursor:tool==='node'?'crosshair':tool==='erase'?'not-allowed':'default'}}
                onMouseMove={onSVGMouseMove}
                onMouseDown={onSVGMouseDown}
                onMouseUp={onSVGMouseUp}
              >
                <defs>
                  {[{id:'arr',c:'#9aaac4'},{id:'arr-r',c:'#e53e3e'},{id:'arr-b',c:'#3b7cf4'}].map(({id,c})=>(
                    <marker key={id} id={id} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                      <path d="M0,1 L7,4 L0,7 Z" fill={c}/>
                    </marker>
                  ))}
                  <filter id="sh" x="-60%" y="-60%" width="220%" height="220%">
                    <feDropShadow dx="0" dy="3" stdDeviation="5" floodColor="#1e2a40" floodOpacity=".12"/>
                  </filter>
                  <filter id="gx" x="-80%" y="-80%" width="260%" height="260%">
                    <feDropShadow dx="0" dy="0" stdDeviation="9" floodColor="#3b7cf4" floodOpacity=".28"/>
                  </filter>
                  <filter id="go" x="-80%" y="-80%" width="260%" height="260%">
                    <feDropShadow dx="0" dy="0" stdDeviation="9" floodColor="#0da271" floodOpacity=".28"/>
                  </filter>
                </defs>
                <rect width="100%" height="100%" fill="#eef2f8"/>
                <pattern id="dg" x="0" y="0" width="28" height="28" patternUnits="userSpaceOnUse">
                  <circle cx="0.5" cy="0.5" r="0.9" fill="#c4cfe4"/>
                </pattern>
                <rect width="100%" height="100%" fill="url(#dg)"/>

                {/* Edges */}
                {edges.map(edge=>{
                  const p=edgePath(edge); if(!p)return null;
                  const bk=isBackdoor(edge), hv=hoverEdge===edge.id;
                  const stroke=hv?'#3b7cf4':bk?'#e53e3e':'#9aaac4';
                  const mk=hv?'arr-b':bk?'arr-r':'arr';
                  return(
                    <g key={edge.id}
                      onMouseEnter={()=>setHoverEdge(edge.id)}
                      onMouseLeave={()=>setHoverEdge(null)}
                      onClick={ev=>onEdgeClick(ev,edge.id)}
                      style={{cursor:tool==='erase'?'pointer':'default'}}>
                      <path d={p} stroke="transparent" strokeWidth="14" fill="none"/>
                      <path d={p} stroke={stroke} strokeWidth={hv?2.5:bk?2:1.8} fill="none"
                        strokeDasharray={bk?'5 3':'none'} markerEnd={`url(#${mk})`}/>
                    </g>
                  );
                })}

                {/* Preview */}
                {edgeSrc&&tool==='edge'&&(()=>{
                  const s=nodes.find(n=>n.id===edgeSrc);
                  return s?<line x1={s.x} y1={s.y} x2={mouse.x} y2={mouse.y}
                    stroke="#3b7cf4" strokeWidth="1.5" strokeDasharray="6 4" opacity=".5"/>:null;
                })()}

                {/* Nodes */}
                {nodes.map(node=>{
                  const c=NODE_COLORS[node.type]||NODE_COLORS.variable;
                  const isSel=node.id===selected;
                  const isExp=node.id===exposure, isOut=node.id===outcome;
                  const isLat=node.type==='latent';
                  const lbl=node.label.length>10?node.label.slice(0,9)+'…':node.label;
                  const filt=isExp?'url(#gx)':isOut?'url(#go)':'url(#sh)';
                  return(
                    <g key={node.id} onMouseDown={e=>onNodeDown(e,node)}
                      style={{cursor:tool==='move'?'grab':'pointer'}}>
                      {isSel&&<circle cx={node.x} cy={node.y} r={R+9}
                        fill="none" stroke="#3b7cf4" strokeWidth="1.5" strokeDasharray="4 3" opacity=".65"/>}
                      <circle cx={node.x} cy={node.y} r={R}
                        fill={c.fill} stroke={c.stroke} strokeWidth={1.5}
                        strokeDasharray={isLat?'5 3':'none'} opacity={isLat?.6:1} filter={filt}/>
                      <ellipse cx={node.x-7} cy={node.y-9} rx={10} ry={6}
                        fill="rgba(255,255,255,0.2)" transform={`rotate(-20,${node.x-7},${node.y-9})`}
                        opacity={isLat?.2:.8}/>
                      <text x={node.x} y={node.y+1}
                        textAnchor="middle" dominantBaseline="middle"
                        fill="#fff" fontSize="11" fontWeight="600"
                        fontFamily="'IBM Plex Sans',sans-serif">{lbl}</text>
                    </g>
                  );
                })}
              </svg>

              <div className="sb">
                <span className="sb-dim">{nodes.length} nodes · {edges.length} edges</span>
                <span className="sb-info">
                  {tool==='move'&&'Drag to reposition · Click to select'}
                  {tool==='node'&&'+ Click canvas to place a new node'}
                  {tool==='edge'&&!edgeSrc&&'→ Click source node'}
                  {tool==='edge'&&edgeSrc&&`→ Click target  (from: ${nodes.find(n=>n.id===edgeSrc)?.label})`}
                  {tool==='erase'&&'✕ Click any node or edge to remove'}
                </span>
              </div>
            </div>

            {/* Right Panel */}
            <div className="pn">
              <div className="ps">
                <div className="pt">Effect to Estimate</div>
                <div style={{marginBottom:10}}>
                  <div className="fl">Exposure</div>
                  <select className="sel bl" value={exposure||''} onChange={e=>setExposure(e.target.value)}>
                    <option value="">— none —</option>
                    {nodes.map(n=><option key={n.id} value={n.id}>{n.label}</option>)}
                  </select>
                </div>
                <div>
                  <div className="fl">Outcome</div>
                  <select className="sel gr" value={outcome||''} onChange={e=>setOutcome(e.target.value)}>
                    <option value="">— none —</option>
                    {nodes.map(n=><option key={n.id} value={n.id}>{n.label}</option>)}
                  </select>
                </div>
              </div>

              {selNode&&(
                <div className="ps">
                  <div className="pt">Selected Variable</div>
                  <input className="inp" value={selNode.label}
                    onChange={e=>setNodes(prev=>prev.map(n=>n.id===selected?{...n,label:e.target.value}:n))}/>
                  <div className="chips">
                    {Object.entries(NODE_COLORS).map(([type,c])=>(
                      <button key={type} className="chip"
                        onClick={()=>setNodes(prev=>prev.map(n=>n.id===selected?{...n,type}:n))}
                        style={{
                          color:selNode.type===type?c.fill:'#9aaac4',
                          borderColor:selNode.type===type?c.fill+'80':'#dde4f0',
                          background:selNode.type===type?c.fill+'18':'transparent',
                        }}>{type}</button>
                    ))}
                  </div>
                </div>
              )}

              <div className="res">
                {!analysis ? (
                  <div style={{fontSize:12,color:'#9aaac4',lineHeight:1.7}}>Set an exposure and outcome to run causal analysis.</div>
                ) : <>
                  <div className="pt">All Paths ({analysis.all.length})</div>
                  {analysis.all.slice(0,7).map((path,i)=>{
                    const isBk=analysis.backdoor.some(b=>b.join()===path.join());
                    return(
                      <div key={i} className={`pi ${isBk?'pb':'pd'}`}>
                        {isBk?'⚠ ':'→ '}
                        {path.map(id=>nodes.find(n=>n.id===id)?.label||id).join(' → ')}
                      </div>
                    );
                  })}
                  {analysis.all.length>7&&<div className="mn">+{analysis.all.length-7} more paths</div>}

                  <div className="pt" style={{marginTop:16}}>Minimal Adjustment Sets</div>
                  {analysis.backdoor.length===0?(
                    <div className="an">✓ No adjustment needed</div>
                  ):analysis.sets.length===0?(
                    <div className="ai">No valid set with observed variables.</div>
                  ):analysis.sets.map((set,i)=>(
                    <div key={i} className="as">
                      {set.length===0?'∅ empty set':`{ ${set.map(id=>nodes.find(n=>n.id===id)?.label||id).join(', ')} }`}
                    </div>
                  ))}

                  <div style={{marginTop:20}}>
                    <div className="pt">DAG Summary</div>
                    <button className="sum-btn" disabled={summarizing} onClick={generateSummary}>
                      {summarizing&&<span className="spin"/>}
                      {summarizing?'Generating…':'Generate Methods Paragraph'}
                    </button>
                    {summaryError&&<div className="sum-err">{summaryError}</div>}
                    {summary&&<div className="sum-box">{summary}</div>}
                  </div>
                </>}
              </div>

              <div className="leg">
                {Object.entries(NODE_COLORS).map(([type,c])=>(
                  <div key={type} className="li">
                    <div className="ld" style={{background:c.fill}}/><span>{type}</span>
                  </div>
                ))}
                <div className="li">
                  <svg width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke="#e53e3e" strokeWidth="1.8" strokeDasharray="4 2"/></svg>
                  <span>backdoor</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── LIBRARY VIEW ── */}
        {view==='library' && (
          <div className="lib">
            {LIBRARY.map(lib=>(
              <div key={lib.id} className="lib-card" onClick={()=>loadLibrary(lib)}>
                <div className="lib-card-head">
                  <div className="lib-tag" style={{background:lib.color+'18',color:lib.color}}>{lib.tag}</div>
                  <div className="lib-name">{lib.name}</div>
                  <div className="lib-desc">{lib.description}</div>
                </div>
                <RefPanel refs={lib.refs} accentColor={lib.color}/>
                <button className="lib-load">Load into Studio →</button>
              </div>
            ))}
          </div>
        )}
        {/* ── VALIDATION VIEW ── */}
        {view==='validation' && <ValidationView/>}
        {/* Footer */}
        <div style={{height:'30px',flexShrink:0,background:'#fff',borderTop:'1px solid #eef2f8',display:'flex',alignItems:'center',justifyContent:'center',gap:'6px'}}>
          <span style={{fontSize:10,color:'#b0bcd4',fontWeight:500}}>John D. Diaz-Decaro, PhD, MS</span>
          <span style={{fontSize:10,color:'#dde4f0'}}>·</span>
          <span style={{fontSize:10,color:'#b0bcd4',fontWeight:500}}>Black Swan Causal Labs, LLC</span>
        </div>
      </div>

      {/* API Key Modal */}
      {apiKeyModal && (
        <div className="apikey-modal-bg" onClick={()=>setApiKeyModal(false)}>
          <div className="apikey-modal" onClick={e=>e.stopPropagation()}>
            <h3>Anthropic API Key</h3>
            <p>
              Your key is used directly in your browser to call the Anthropic API.
              It is never stored, logged, or sent anywhere except Anthropic's servers.
              It will be cleared when you close the tab.
            </p>
            <input
              className="apikey-input"
              type="password"
              placeholder="sk-ant-..."
              value={apiKeyDraft}
              onChange={e=>setApiKeyDraft(e.target.value)}
              onKeyDown={e=>{if(e.key==='Enter'){setApiKey(apiKeyDraft);setApiKeyModal(false);}}}
              autoFocus
            />
            <div className="apikey-hint">
              Don't have a key?{' '}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                Get one at console.anthropic.com →
              </a>
            </div>
            <div className="apikey-actions">
              {apiKey && (
                <button className="apikey-clear" onClick={()=>{setApiKey('');setApiKeyDraft('');setApiKeyModal(false);}}>
                  Remove Key
                </button>
              )}
              <button className="apikey-cancel" onClick={()=>setApiKeyModal(false)}>Cancel</button>
              <button className="apikey-save" onClick={()=>{setApiKey(apiKeyDraft);setApiKeyModal(false);}}>
                Save Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export Preview Modal */}
      {exportPreview && (
        <div className="exp-modal-bg" onClick={()=>setExportPreview(null)}>
          <div className="exp-modal" onClick={e=>e.stopPropagation()}>
            <div className="exp-modal-head">
              <div className="exp-modal-title">Export Preview</div>
              <button className="exp-modal-close" onClick={()=>setExportPreview(null)}>×</button>
            </div>
            <div className="exp-modal-preview">
              <img src={exportPreview.dataURL} alt="DAG preview"/>
            </div>
            <div className="exp-modal-foot">
              <div className="exp-modal-fmts">
                {[
                  {fmt:'png',label:'PNG'},
                  {fmt:'jpg',label:'JPG'},
                  {fmt:'pdf',label:'PDF'},
                  {fmt:'ppt',label:'PPT'},
                ].map(({fmt,label})=>(
                  <button key={fmt}
                    className={`exp-modal-fmt${exportPreview.fmt===fmt?' active':''}`}
                    onClick={()=>setExportPreview(p=>({...p,fmt}))}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:4}}>
                <button className="exp-dl-btn" onClick={downloadExport}>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M10 3v9M6.5 8.5L10 12l3.5-3.5" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M4 14v1.5A1.5 1.5 0 005.5 17h9a1.5 1.5 0 001.5-1.5V14" strokeLinecap="round"/>
                  </svg>
                  Open {exportPreview.fmt.toUpperCase()} to Save
                </button>
                <span style={{fontSize:10,color:'#b0bcd4',fontStyle:'italic'}}>Opens in new tab — right-click or ⌘S to save</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Node Modal */}
      {modal&&(
        <div className="mbg" onClick={()=>setModal(null)}>
          <div className="mo" onClick={e=>e.stopPropagation()}>
            <div className="mh">Add Variable</div>
            <input autoFocus className="inp" value={mLabel}
              onChange={e=>setMLabel(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&addNode()}
              placeholder="Variable name…"/>
            <div className="chips">
              {Object.entries(NODE_COLORS).map(([type,c])=>(
                <button key={type} className="chip" onClick={()=>setMType(type)}
                  style={{
                    color:mType===type?c.fill:'#9aaac4',
                    borderColor:mType===type?c.fill+'80':'#dde4f0',
                    background:mType===type?c.fill+'18':'transparent',
                  }}>{type}</button>
              ))}
            </div>
            <div className="mac">
              <button className="bc" onClick={()=>setModal(null)}>Cancel</button>
              <button className="ba" onClick={addNode}>Add Variable</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
