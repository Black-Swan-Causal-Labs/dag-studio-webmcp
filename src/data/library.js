/**
 * DAG Studio — Training Library
 *
 * Eight canonical DAG archetypes for pharmacoepidemiology and RWE research.
 * Each entry includes a description, 3 curated references, and the node/edge
 * structure to load into the studio canvas.
 */

const LIBRARY = [
  {
    id: 'confounding', name: 'Classic Confounding', tag: 'Confounding', color: '#e8972a',
    description: 'A confounder is a common cause of both the exposure and outcome, creating a spurious association. Adjustment for the confounder closes the backdoor path and yields an unbiased estimate of the causal effect.',
    refs: [
      { title: 'Causal diagrams for epidemiologic research', cite: 'Greenland, Pearl & Robins · Epidemiology 1999', url: 'https://doi.org/10.1097/00001648-199901000-00008' },
      { title: 'Causal Inference: What If (Ch. 7 — Confounding)', cite: 'Hernán & Robins · CRC Press 2020', url: 'https://www.hsph.harvard.edu/miguel-hernan/causal-inference-book/' },
      { title: 'Reducing bias through directed acyclic graphs', cite: 'Shrier & Platt · BMC Med Res Methodol 2008', url: 'https://doi.org/10.1186/1471-2288-8-70' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [ { id:'conf', label:'Confounder', x:220, y:140, type:'confounder' }, { id:'exp', label:'Exposure', x:150, y:300, type:'exposure' }, { id:'out', label:'Outcome', x:450, y:300, type:'outcome' } ],
    edges: [ { id:'e1', src:'conf', tgt:'exp' }, { id:'e2', src:'conf', tgt:'out' }, { id:'e3', src:'exp', tgt:'out' } ],
  },
  {
    id: 'mbias', name: 'M-Bias', tag: 'M-Bias', color: '#e53e3e',
    description: 'M-bias occurs when a pre-exposure variable (M) is a common descendant of two unmeasured causes. Conditioning on M opens a collider path and introduces bias, even though M precedes exposure.',
    refs: [
      { title: 'Avoiding bias due to perfect prediction in multiple logistic regression', cite: 'Greenland · Stat Med 2003', url: 'https://doi.org/10.1002/sim.1485' },
      { title: 'To Adjust or Not to Adjust? Sensitivity Analysis of M-Bias', cite: 'Ding & Miratrix · JCGS 2015', url: 'https://doi.org/10.1080/10618600.2015.1023764' },
      { title: 'A structural approach to selection bias', cite: 'Hernán, Hernández-Díaz & Robins · Epidemiology 2004', url: 'https://doi.org/10.1097/01.ede.0000135174.63482.43' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [ { id:'u1', label:'U1', x:130, y:130, type:'latent' }, { id:'u2', label:'U2', x:470, y:130, type:'latent' }, { id:'m', label:'M', x:300, y:230, type:'confounder' }, { id:'exp', label:'Exposure', x:150, y:370, type:'exposure' }, { id:'out', label:'Outcome', x:450, y:370, type:'outcome' } ],
    edges: [ { id:'e1', src:'u1', tgt:'exp' }, { id:'e2', src:'u1', tgt:'m' }, { id:'e3', src:'u2', tgt:'m' }, { id:'e4', src:'u2', tgt:'out' }, { id:'e5', src:'exp', tgt:'out' } ],
  },
  {
    id: 'collider', name: 'Collider Bias', tag: 'Collider', color: '#8b5cf6',
    description: "Conditioning on a collider opens a non-causal path between its causes, inducing spurious association. This is the mechanism behind index event bias and Berkson's bias.",
    refs: [
      { title: 'Causality: Models, Reasoning and Inference (§1.2)', cite: 'Pearl · Cambridge University Press 2009', url: 'http://bayes.cs.ucla.edu/BOOK-2K/' },
      { title: 'Collider bias undermines our understanding of COVID-19 disease risk', cite: 'Griffith et al. · Nature Comms 2020', url: 'https://doi.org/10.1038/s41467-020-19478-2' },
      { title: 'Index event bias as an explanation for paradoxes of recurrence risk research', cite: 'Dahabreh & Kent · JAMA 2011', url: 'https://doi.org/10.1001/jama.2011.163' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [ { id:'exp', label:'Exposure', x:150, y:200, type:'exposure' }, { id:'out', label:'Outcome', x:450, y:200, type:'outcome' }, { id:'col', label:'Collider', x:300, y:340, type:'variable' } ],
    edges: [ { id:'e1', src:'exp', tgt:'out' }, { id:'e2', src:'exp', tgt:'col' }, { id:'e3', src:'out', tgt:'col' } ],
  },
  {
    id: 'selection', name: 'Selection Bias', tag: 'Selection Bias', color: '#0da271',
    description: 'Selection bias arises when study inclusion depends on both exposure and outcome. The selection node acts as a collider; restricting analysis to selected individuals conditions on it, opening a backdoor path.',
    refs: [
      { title: 'A structural approach to selection bias', cite: 'Hernán, Hernández-Díaz & Robins · Epidemiology 2004', url: 'https://doi.org/10.1097/01.ede.0000135174.63482.43' },
      { title: 'Causal Inference: What If (Ch. 8 — Selection Bias)', cite: 'Hernán & Robins · CRC Press 2020', url: 'https://www.hsph.harvard.edu/miguel-hernan/causal-inference-book/' },
      { title: 'Selection bias in the estimation of effect modification', cite: 'Lash & Fink · Epidemiology 2004', url: 'https://doi.org/10.1097/01.ede.0000099081.60081.4f' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [ { id:'exp', label:'Exposure', x:150, y:200, type:'exposure' }, { id:'out', label:'Outcome', x:450, y:200, type:'outcome' }, { id:'sel', label:'Selected', x:300, y:340, type:'variable' } ],
    edges: [ { id:'e1', src:'exp', tgt:'out' }, { id:'e2', src:'exp', tgt:'sel' }, { id:'e3', src:'out', tgt:'sel' } ],
  },
  {
    id: 'mediation', name: 'Mediation', tag: 'Mediation', color: '#3b7cf4',
    description: 'A mediator lies on the causal path from exposure to outcome. Conditioning on the mediator blocks the indirect effect. Avoiding adjustment for mediators is essential when the total effect is of interest.',
    refs: [
      { title: 'Explanation in Causal Inference: Methods for Mediation and Interaction', cite: 'VanderWeele · Oxford University Press 2015', url: 'https://global.oup.com/academic/product/explanation-in-causal-inference-9780199325870' },
      { title: 'Mediation Analysis with a Survival Outcome', cite: 'VanderWeele · Int J Epidemiol 2011', url: 'https://doi.org/10.1093/ije/dyr066' },
      { title: 'Causal Inference: What If (Ch. 17 — Mediating variables)', cite: 'Hernán & Robins · CRC Press 2020', url: 'https://www.hsph.harvard.edu/miguel-hernan/causal-inference-book/' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [ { id:'exp', label:'Exposure', x:130, y:260, type:'exposure' }, { id:'med', label:'Mediator', x:300, y:260, type:'variable' }, { id:'out', label:'Outcome', x:470, y:260, type:'outcome' } ],
    edges: [ { id:'e1', src:'exp', tgt:'med' }, { id:'e2', src:'med', tgt:'out' }, { id:'e3', src:'exp', tgt:'out' } ],
  },
  {
    id: 'iv', name: 'Instrumental Variable', tag: 'Instruments', color: '#e8972a',
    description: 'An instrumental variable affects the outcome only through the exposure and is independent of unmeasured confounders. IVs can identify causal effects despite unobserved confounding — the basis of Mendelian randomization.',
    refs: [
      { title: 'Causality: Models, Reasoning and Inference (§5.4)', cite: 'Pearl · Cambridge University Press 2009', url: 'http://bayes.cs.ucla.edu/BOOK-2K/' },
      { title: 'Mendelian randomization: using genes as instruments for causal inferences', cite: 'Davey Smith & Ebrahim · Stat Med 2003', url: 'https://doi.org/10.1002/sim.1792' },
      { title: 'Causal Inference: What If (Ch. 16 — Instrumental variable estimation)', cite: 'Hernán & Robins · CRC Press 2020', url: 'https://www.hsph.harvard.edu/miguel-hernan/causal-inference-book/' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [ { id:'iv', label:'IV', x:100, y:260, type:'variable' }, { id:'exp', label:'Exposure', x:280, y:260, type:'exposure' }, { id:'out', label:'Outcome', x:460, y:260, type:'outcome' }, { id:'u', label:'U (unobs)', x:370, y:140, type:'latent' } ],
    edges: [ { id:'e1', src:'iv', tgt:'exp' }, { id:'e2', src:'exp', tgt:'out' }, { id:'e3', src:'u', tgt:'exp' }, { id:'e4', src:'u', tgt:'out' } ],
  },
  {
    id: 'timevary', name: 'Time-Varying Confounding', tag: 'Time-Varying', color: '#3b7cf4',
    description: 'When a time-varying covariate is both a confounder and affected by prior exposure, standard regression introduces collider bias. G-methods (g-computation, IPTW, g-estimation) are required for valid estimation.',
    refs: [
      { title: 'A new approach to causal inference in mortality studies (G-computation)', cite: 'Robins · Math Modelling 1986', url: 'https://doi.org/10.1016/0270-0255(86)90088-6' },
      { title: 'Marginal structural models and causal inference in epidemiology', cite: 'Robins, Hernán & Brumback · Epidemiology 2000', url: 'https://doi.org/10.1097/00001648-200009000-00011' },
      { title: 'Causal Inference: What If (Ch. 19–21 — G-methods)', cite: 'Hernán & Robins · CRC Press 2020', url: 'https://www.hsph.harvard.edu/miguel-hernan/causal-inference-book/' },
    ],
    exposure: 'exp2', outcome: 'out',
    nodes: [ { id:'exp1', label:'Exp (t1)', x:110, y:260, type:'exposure' }, { id:'l', label:'L (t2)', x:260, y:180, type:'confounder' }, { id:'exp2', label:'Exp (t2)', x:260, y:320, type:'exposure' }, { id:'out', label:'Outcome', x:440, y:260, type:'outcome' } ],
    edges: [ { id:'e1', src:'exp1', tgt:'l' }, { id:'e2', src:'exp1', tgt:'exp2' }, { id:'e3', src:'l', tgt:'exp2' }, { id:'e4', src:'l', tgt:'out' }, { id:'e5', src:'exp2', tgt:'out' } ],
  },
  {
    id: 'overadjust', name: 'Over-adjustment', tag: 'Over-adjustment', color: '#e53e3e',
    description: 'Adjusting for a variable on the causal path blocks part of the causal effect, resulting in underestimation of the total effect. A common error when post-exposure variables are included as covariates.',
    refs: [
      { title: 'Overadjustment bias and unnecessary adjustment in epidemiologic studies', cite: 'Schisterman, Cole & Platt · Epidemiology 2009', url: 'https://doi.org/10.1097/EDE.0b013e3181a819a1' },
      { title: 'The table 2 fallacy: presenting and interpreting confounder and modifier coefficients', cite: 'Westreich & Greenland · Am J Epidemiol 2013', url: 'https://doi.org/10.1093/aje/kws412' },
      { title: 'Causal diagrams for epidemiologic research', cite: 'Greenland, Pearl & Robins · Epidemiology 1999', url: 'https://doi.org/10.1097/00001648-199901000-00008' },
    ],
    exposure: 'exp', outcome: 'out',
    nodes: [ { id:'exp', label:'Exposure', x:130, y:260, type:'exposure' }, { id:'bio', label:'Biomarker', x:300, y:260, type:'variable' }, { id:'out', label:'Outcome', x:470, y:260, type:'outcome' }, { id:'con', label:'Covariate', x:300, y:140, type:'confounder' } ],
    edges: [ { id:'e1', src:'exp', tgt:'bio' }, { id:'e2', src:'bio', tgt:'out' }, { id:'e3', src:'exp', tgt:'out' }, { id:'e4', src:'con', tgt:'exp' }, { id:'e5', src:'con', tgt:'out' } ],
  },
];

export default LIBRARY;
