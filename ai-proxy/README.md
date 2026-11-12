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

The Worker is single-purpose. The browser sends only `{question}`; the Worker
composes the instructions (`SYSTEM_INSTRUCTIONS` in `worker.js`), calls Gemini,
and returns `{text}` containing just the dagitty graph and an optional
`CONFOUNDERS:` line. It is deliberately not a generic prompt relay: a caller
cannot supply its own instructions, and a reply without a graph is not returned.

To change how the assistant builds DAGs, edit `SYSTEM_INSTRUCTIONS` and redeploy.

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
3. Deploy (re-run this after any change to `worker.js` or `wrangler.toml`):
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

`ALLOWED_ORIGINS` in `worker.js` lists the pages allowed to call the Worker from
a browser: the production editor, its github.io fallback, the WebMCP sandbox,
and `localhost:5173` / `localhost:4173` for `npm run dev` / `npm run preview`.
Add any new host here and redeploy.

The `Origin` header only constrains browsers. A script can send any value, so
the guardrails below do not rely on it.

## Guardrails in the Worker

- **No free-form prompt.** Only the research question is taken from the request
  (capped at `MAX_QUESTION_CHARS`); instructions are composed server-side.
- **No free-form output.** Only a dagitty graph and the `CONFOUNDERS:` line are
  returned; anything else the model writes is dropped, and a reply with no graph
  is an error.
- **Per-IP rate limit.** The `RATE_LIMIT` binding in `wrangler.toml` allows 10
  requests per minute per client IP. Adjust `limit` there and redeploy.
- **Pinned model, temperature and output ceiling**, so the key cannot be pointed
  at an expensive model.
- **Key in a request header**, never in a URL, and upstream error text is not
  relayed to the browser.

Use a free-tier key with billing disabled as the final backstop: the worst case
is then an exhausted daily quota, not a bill.

## Tests

```
node --test ai-proxy/worker.test.js
```

Runs the Worker against a stubbed Gemini upstream (no network, no key) and
checks each guardrail above.

## Privacy note

With the proxy on, the research question the user types passes through your
Worker on its way to Gemini. The Worker does not log request bodies. Note that
Gemini **free-tier** terms allow Google to use inputs to improve their models, so
do not encourage users to paste confidential or proprietary questions. If that
becomes a concern, switch the pinned key to a paid tier (whose terms exclude
training) by changing only the secret; no code change is needed.
