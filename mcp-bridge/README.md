# DAG Studio WebMCP: remote MCP bridge

The native WebMCP interface works directly in a compatible browser. This optional Streamable HTTP bridge lets MCP clients with custom-header support use the **same live canvas and predefined tools**. It does not expose the separate DAG Studio analytical MCP server.

## Connect an agent

1. Open [DAG Studio WebMCP](https://dag-studio-webmcp-sandbox.pages.dev).
2. Select **Connect MCP**, read the connection explanation, then **Enable connection**.
3. Add the displayed server URL to your MCP client using Streamable HTTP. Set its `Authorization` header to the complete copied value, including `Bearer `, or copy the provided MCP configuration for clients that accept that JSON format.
4. Keep the studio tab open. Ask the agent to read the current design before making edits. Both agent and human changes use the existing canvas state and Undo history.
5. Select **Disconnect** to revoke access. Closing or reloading the page also ends the session. Keys expire after two hours; reconnect to obtain a new key.

Anyone with your connection key can invoke that canvas's tools while connected. Give it only to your intended MCP client. A client without custom-header support should use native WebMCP; this release does not implement OAuth discovery. Merely pasting a website URL into an arbitrary agent does not add WebMCP capability to that agent.

## Data and session behavior

- Pairing is opt-in. Loading the page does not contact the relay.
- Each browser canvas has a separate Durable Object and independent random 256-bit browser and client credentials. Only credential hashes and expiry are stored in the relay database.
- Study content travels through the Cloudflare relay to the connected agent provider. Tool descriptors are attached to the browser socket; study specifications, command arguments, and results are not written to the relay database or application logs.
- Browser and client credentials have different permissions. Client keys cannot attach a replacement canvas or revoke other sessions.
- Only the configured studio origins may create sessions or open browser sockets. MCP requests require the current client key, including when sent by a browser client on another origin.
- A session processes one remote operation at a time. Arguments are validated against the page's tool schema. SDDS also checks its current revision before committing edits.
- Calls time out after 30 seconds. A timed-out or interrupted mutation may have completed: read the current state before retrying. The bridge never automatically retries mutations.
- Disconnect disables local execution immediately. Network loss revokes credentials when Cloudflare observes the closed socket; fixed expiry bounds an abandoned session. No reconnect or replay occurs silently.
- Payload limits are 128 KiB for requests and 2 MiB for results. Use the page's export controls for larger output.
- Rate limits are 10 session creations per minute per client IP and 120 requests per minute per session, enforced at the Cloudflare location. These are abuse controls, not a global billing cap.

## Develop and test

From the repository root, install the application and bridge dependencies:

```sh
npm ci
npm ci --prefix mcp-bridge
npm run typecheck --prefix mcp-bridge
```

Start the relay in one terminal:

```sh
npm run dev --prefix mcp-bridge -- --port 8791 --var STUDIO_ORIGINS:http://127.0.0.1:5173
```

Start the app in another terminal:

```sh
VITE_MCP_BRIDGE_URL=http://127.0.0.1:8791 npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Run the end-to-end tests with Google Chrome installed:

```sh
STUDIO_URL=http://127.0.0.1:5173 BRIDGE_URL=http://127.0.0.1:8791 npm test --prefix mcp-bridge
```

The tests launch a clean headless Chrome context, pair two real canvases with SDK MCP clients, exercise agent edits and human edits/Undo, validate session isolation, reject malformed inputs and credentials, and verify revocation. Test canvases are separate from the researcher's existing tabs. Set `EVIDENCE_DIR` to save screenshots outside the repository.

## Deploy and register

```sh
npm run typecheck --prefix mcp-bridge
npm run deploy --prefix mcp-bridge
npm run build
npx wrangler pages deploy dist --project-name dag-studio-webmcp-sandbox --branch webmcp-challenge
mcp-publisher validate server.json
gh workflow run publish-mcp.yml --ref main
```

The existing Pages production branch is `webmcp-challenge`; `main` uploads are previews.

Run an authenticated smoke test against the deployed studio before publishing. `server.json` records the organization namespace and connection requirements. The browser's default relay URL and Wrangler's studio-origin allowlist must agree with the deployment. Site and Worker deployments remain manual. Registry publication uses the manually dispatched `Publish MCP Registry listing` workflow, with GitHub OIDC and no stored registry secret. Commits do not publish automatically.

The source is intentionally identical between the two bridge Workers except for configuration and application wiring. Keep protocol/security fixes synchronized across both repositories.
