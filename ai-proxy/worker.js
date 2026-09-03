// dag-studio-ai-proxy: Cloudflare Worker
// Holds the Gemini API key as a Cloudflare secret and proxies the DAG Studio
// "research question -> causal DAG" assistant. The published app never contains
// the key; the browser only ever talks to this Worker.
//
// This is a generic {prompt} -> {text} pass-through (same contract as
// spifd-ai-proxy). All DAG-specific instructions and the dagitty output format
// are composed by the DAG Studio frontend and sent in `prompt`; the Worker just
// forwards them to Gemini and returns the text.
//
// Deploy: see README.md in this folder.

// Only accept calls coming from your own site. The DAG Studio editor is served
// at https://dagstudio.blackswancausallabs.com/ (the github.io URL 301-redirects
// there, so the browser's Origin is the custom domain). The github.io entry is
// kept as a fallback. localhost entries are for `npm run dev` / `preview`; remove
// them if you want production-only hardening.
const ALLOWED_ORIGINS = [
  'https://dagstudio.blackswancausallabs.com',
  'https://black-swan-causal-labs.github.io',
  'http://localhost:5173',
  'http://localhost:4173',
];

// Model is pinned here, server-side, so a caller cannot redirect the key to an
// expensive model. Keep this to a free-tier / lightweight model.
const MODEL = 'gemini-2.5-flash';

// Reject anything unreasonably large before it ever reaches the model.
const MAX_PROMPT_CHARS = 8000;

// Low temperature keeps the DAG faithful to the question; the ceiling gives room
// for a dagitty graph plus a short confounder-suggestion note.
const TEMPERATURE = 0.2;
const MAX_OUTPUT_TOKENS = 2048;

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

    // Primary guard: only your own pages may call this endpoint.
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: { message: 'Origin not allowed.' } }, 403, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: { message: 'Invalid JSON.' } }, 400, origin);
    }

    const prompt = (body && typeof body.prompt === 'string') ? body.prompt.trim() : '';
    if (!prompt) {
      return json({ error: { message: 'Missing prompt.' } }, 400, origin);
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return json({ error: { message: 'Prompt too long.' } }, 413, origin);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: { message: 'Proxy is not configured (no key set).' } }, 500, origin);
    }

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + encodeURIComponent(MODEL) + ':generateContent?key='
      + encodeURIComponent(env.GEMINI_API_KEY);

    let upstream;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
      });
    } catch (e) {
      return json({ error: { message: 'Upstream request failed.' } }, 502, origin);
    }

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      let msg = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + upstream.status);
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
      // Do not leak the upstream key or raw internals to the browser.
      return json({ error: { message: msg } }, upstream.status, origin);
    }

    const cand = data && data.candidates && data.candidates[0];
    const text = (cand && cand.content && cand.content.parts)
      ? cand.content.parts.map((p) => p.text || '').join('').trim()
      : '';

    if (!text) {
      const blocked = data && data.promptFeedback
        ? ('Request blocked: ' + JSON.stringify(data.promptFeedback))
        : 'Empty response from model.';
      return json({ error: { message: blocked } }, 502, origin);
    }

    return json({ text }, 200, origin);
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
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
