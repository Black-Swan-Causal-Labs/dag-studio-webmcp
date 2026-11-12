// dag-studio-ai-proxy: Cloudflare Worker
// Holds the Gemini API key as a Cloudflare secret and serves exactly one job
// for DAG Studio: research question -> causal DAG in dagitty syntax.
//
// This is deliberately NOT a generic prompt relay. The browser sends only the
// researcher's question; the instructions are composed here, and only a
// dagitty graph (plus an optional CONFOUNDERS line) is ever returned. The
// Origin header is trivially spoofed by non-browser clients, so the design
// assumes anyone can reach this endpoint and makes sure there is nothing
// worth abusing: no free-form prompt, no free-form output, a short input cap,
// and per-IP rate limiting.
//
// Deploy: see README.md in this folder.

// Browser pages allowed to call this endpoint (CORS + first-line filter).
const ALLOWED_ORIGINS = [
  'https://dagstudio.blackswancausallabs.com',
  'https://black-swan-causal-labs.github.io',
  'https://dag-studio-webmcp-sandbox.pages.dev',
  'http://localhost:5173',
  'http://localhost:4173',
];

// Model is pinned here, server-side, so a caller cannot redirect the key to an
// expensive model. Keep this to a free-tier / lightweight model.
const MODEL = 'gemini-2.5-flash';

// A research question, not a document.
export const MAX_QUESTION_CHARS = 1500;

// Low temperature keeps the DAG faithful to the question; the ceiling gives room
// for a dagitty graph plus a short confounder-suggestion note.
const TEMPERATURE = 0.2;
const MAX_OUTPUT_TOKENS = 2048;

// The model's ONLY job is to turn the question into a dagitty DAG that stays
// faithful to it, plus an optional short note of confounders worth considering.
export const SYSTEM_INSTRUCTIONS = `You are a causal-inference assistant embedded in DAG Studio. Your ONLY task is to translate the researcher's question into a causal directed acyclic graph (DAG) in dagitty syntax.

STRICT RULES:
- Stay faithful to the research question. Do not invent an exposure or outcome that was not asked about.
- Tag the primary exposure with [exposure] and the primary outcome with [outcome].
- Add only variables that are causally justified for THIS question: established confounders, mediators on the causal path, and relevant colliders. Prefer well-established domain variables over speculation.
- Every variable you declare MUST participate in at least one directed edge. Never output an isolated node with no arrows.
- If the question names variables the researchers adjusted for, controlled for, matched on, or "accounted for", include EACH one and connect it by its causal role. Default each to a confounder, drawing an edge from it into BOTH the exposure and the outcome, unless it is clearly a mediator (it lies on the exposure->outcome path) or a collider (a shared effect of the exposure and the outcome). Draw the causal structure, not the analysis plan: represent what causes what, and let the identification tooling decide what to adjust for. Do not drop any named variable and do not leave any unconnected. For example, for "the effect of X on Y, accounting for A, B, and C", emit A -> X, A -> Y, B -> X, B -> Y, C -> X, C -> Y (unless one is genuinely a mediator or collider); never leave A, B, or C as a bare declaration.
- Use short, readable node labels made of letters and digits only, with no spaces (write LungCancer, not Lung Cancer). Draw directed edges with -> only.
- Do NOT simulate data, cite literature, fetch anything, or add commentary inside the graph.

OUTPUT EXACTLY these two parts and nothing else:
1) A fenced code block labelled dagitty with a single graph, for example:
\`\`\`dagitty
dag {
  Smoking [exposure]
  LungCancer [outcome]
  Age
  Smoking -> LungCancer
  Age -> Smoking
  Age -> LungCancer
}
\`\`\`
2) After the block, one line starting "CONFOUNDERS:" listing up to 5 additional potential confounders NOT already in the DAG that the researcher might consider (comma-separated), or "CONFOUNDERS: none".`;

const QUESTION_MARKER = '\n\nResearch question: ';

// Pull the question out of the request body. `question` is the contract.
// `prompt` is accepted only for browser tabs still running the previous
// frontend, which sent the whole composed prompt: the question is cut out of
// its tail and everything before it is discarded, so a caller cannot supply
// its own instructions through either field.
export function extractQuestion(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.question === 'string') return body.question.trim();
  if (typeof body.prompt === 'string') {
    const at = body.prompt.indexOf(QUESTION_MARKER);
    return at >= 0 ? body.prompt.slice(at + QUESTION_MARKER.length).trim() : '';
  }
  return '';
}

// Keep only what the app uses: the dagitty graph and the CONFOUNDERS line.
// Returns '' when the reply contains no graph, so the endpoint cannot be used
// to fetch arbitrary model output.
export function extractDagReply(text) {
  if (!text) return '';
  const fenced = text.match(/```(?:dagitty|r)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const graph = body.match(/dag\s*\{[\s\S]*\}/i);
  if (!graph) return '';
  const conf = text.match(/^CONFOUNDERS:[^\n]{0,400}/im);
  return '```dagitty\n' + graph[0].trim() + '\n```' + (conf ? '\n' + conf[0].trim() : '');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: { message: 'Method not allowed.' } }, 405, origin);
    }
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: { message: 'Origin not allowed.' } }, 403, origin);
    }

    // Per-IP throttle (binding declared in wrangler.toml). Skipped only when
    // the binding is absent, e.g. in a local test harness.
    if (env.RATE_LIMIT) {
      const key = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RATE_LIMIT.limit({ key });
      if (!success) {
        return json({ error: { message: 'Too many requests. Wait a minute and try again.' } }, 429, origin);
      }
    }

    let body;
    try {
      const raw = await request.text();
      if (raw.length > 16000) return json({ error: { message: 'Request too large.' } }, 413, origin);
      body = JSON.parse(raw);
    } catch (e) {
      return json({ error: { message: 'Invalid JSON.' } }, 400, origin);
    }

    const question = extractQuestion(body);
    if (!question) {
      return json({ error: { message: 'Missing research question.' } }, 400, origin);
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return json({ error: { message: `Question too long (limit ${MAX_QUESTION_CHARS} characters).` } }, 413, origin);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: { message: 'Proxy is not configured (no key set).' } }, 500, origin);
    }

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + encodeURIComponent(MODEL) + ':generateContent';

    let upstream;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        // Key travels in a header, not the URL, so it cannot end up in logs.
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] },
          contents: [{ role: 'user', parts: [{ text: 'Research question: ' + question }] }],
          generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
      });
    } catch (e) {
      return json({ error: { message: 'Upstream request failed.' } }, 502, origin);
    }

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      // Do not relay upstream error text: it can carry request internals.
      const status = upstream.status === 429 ? 429 : 502;
      const message = status === 429
        ? 'The AI service is at its request limit. Try again shortly.'
        : 'The AI service returned an error (HTTP ' + upstream.status + ').';
      return json({ error: { message } }, status, origin);
    }

    const cand = data && data.candidates && data.candidates[0];
    const text = (cand && cand.content && cand.content.parts)
      ? cand.content.parts.map((p) => p.text || '').join('').trim()
      : '';

    const reply = extractDagReply(text);
    if (!reply) {
      const message = data && data.promptFeedback && data.promptFeedback.blockReason
        ? 'The request was blocked by the AI service.'
        : 'The assistant did not return a DAG. Try rephrasing the question.';
      return json({ error: { message } }, 502, origin);
    }

    return json({ text: reply }, 200, origin);
  },
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}
