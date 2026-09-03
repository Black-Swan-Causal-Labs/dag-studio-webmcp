# DAG Studio AI Proxy (Cloudflare Worker)

A tiny Cloudflare Worker that holds your Gemini API key server-side and forwards
the DAG Studio research-assistant calls (research question -> causal DAG). The
published app never contains the key, so it cannot be scraped from the page.

## How it fits together

```
browser  --(research question, no key)-->  this Worker  --(adds your key)-->  Gemini
   ^                                                                            |
   |----------------- { text: "<dagitty DAG>" } response -----------------------|
```

The Worker is a generic `{prompt}` -> `{text}` pass-through. The DAG Studio
frontend composes the full prompt (the strict system instructions plus the
dagitty output format) and parses the returned dagitty. The Worker itself knows
nothing about DAGs, which keeps it small and unchanging.

## One-time deploy

You need a Cloudflare account (the same one running the SPIFD2 proxy is fine) and
Node installed.

1. Install and sign in to Wrangler:
   ```
   npm install -g wrangler
   wrangler login
   ```
2. From this `ai-proxy` folder, store your key as an encrypted secret (it is
   never written to any file):
   ```
   wrangler secret put GEMINI_API_KEY
   ```
   Paste a **new** free-tier key when prompted (separate from the SPIFD2 key so
   the quotas do not overlap). Use a key with billing disabled.
3. Deploy:
   ```
   wrangler deploy
   ```
   Wrangler prints the live URL, e.g. `https://dag-studio-ai-proxy.<you>.workers.dev`.
4. (Optional) Put it on your own domain by uncommenting the `routes` block in
   `wrangler.toml` (for example `dag-studio-ai.blackswancausallabs.com`) and
   deploying again.

## Turn it on in the app

In DAG Studio's `index.html`, set the one config line near the top of the script
(added in Part B of this build):

```js
var AI_PROXY_URL = 'https://dag-studio-ai-proxy.<you>.workers.dev';
```

Leave it as `''` to keep bring-your-own-key behavior. When it is set, the
research-assistant works with no key, routed through the Worker.

## Origin lock

`ALLOWED_ORIGINS` in `worker.js` is set to the live editor origin
`https://black-swan-causal-labs.github.io` plus `localhost:5173` / `localhost:4173`
for `npm run dev` / `npm run preview`. If you move DAG Studio to a custom domain,
add that origin here and redeploy. For production-only hardening, remove the
localhost entries.

## Recommended: rate limiting

The Origin check keeps casual abuse out, but the simplest robust throttle is a
Cloudflare dashboard Rate Limiting rule on the Worker route (no code):
Security -> WAF -> Rate limiting rules. Cap requests per IP per minute.

## Guardrails already in the Worker

- Only accepts POST requests whose `Origin` is in `ALLOWED_ORIGINS`.
- Pins the model server-side (`MODEL`) so the key cannot be pointed at an
  expensive model.
- Pins temperature and output-token ceiling server-side.
- Caps prompt size (`MAX_PROMPT_CHARS`).
- Never returns the key or raw upstream internals to the browser.

## Privacy note

With the proxy on, the research question the user types passes through your
Worker on its way to Gemini. The Worker does not log request bodies. Note that
Gemini **free-tier** terms allow Google to use inputs to improve their models, so
do not encourage users to paste confidential or proprietary questions. If that
becomes a concern, switch the pinned key to a paid tier (whose terms exclude
training) by changing only the secret; no code change is needed.
