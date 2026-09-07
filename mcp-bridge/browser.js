/** Optional remote MCP pairing. Native WebMCP remains independent of this module. */
export function mountCanvasBridge(tools, { endpoint, title, signal }) {
  if (typeof document === 'undefined' || signal?.aborted) return () => {};
  const host = document.createElement('div');
  host.dataset.canvasMcpBridge = '';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{font:14px/1.5 system-ui,sans-serif;color:#172d43}
    *{box-sizing:border-box} button,input,textarea{font:inherit}
    button{padding:9px 14px;border:1px solid #cad5df;border-radius:6px;cursor:pointer;background:#fff;color:#172d43}
    button:hover{background:#edf4f7}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #379dc0;outline-offset:2px}
    button:disabled{opacity:.5;cursor:wait}.primary{background:#173f56;color:#fff}.primary:hover{background:#245771}
    .launcher{white-space:nowrap;padding:8px 12px}.fallback{position:fixed;bottom:16px;right:16px;z-index:1000}
    dialog{border:1px solid #d4dfe7;border-radius:12px;padding:24px;color:#172d43;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;background:white}
    dialog::backdrop{background:#071b3377}h2{font-size:21px;margin:0 0 12px}p{margin:12px 0}.muted{color:#526578;font-size:13px}
    .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.top{display:flex;justify-content:space-between;align-items:start;gap:12px}.top button{padding:4px 9px}
    label{display:block;margin-top:14px;font-weight:600}input,textarea{display:block;width:100%;margin-top:5px;padding:9px;border:1px solid #bdcbd6;border-radius:5px;background:#f8fafb;color:#183349}
    textarea{font:12px/1.5 ui-monospace,monospace;height:132px;resize:vertical}[hidden]{display:none!important}.status{min-height:22px;font-weight:600}
  `;
  shadow.append(style);
  const launcher = document.createElement('button');
  launcher.className = 'launcher'; launcher.textContent = 'Connect MCP';
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', `Connect MCP to ${title}`);
  // Static markup only; credentials and remote data are always assigned as text/value.
  dialog.innerHTML = `<div class="top"><h2>Connect an MCP agent</h2><button aria-label="Close connection panel">✕</button></div>
    <p>A WebMCP-capable agent can already use this page directly. For another MCP client, enable a temporary connection to this canvas.</p>
    <p class="muted">The connected agent can read and edit this canvas using its predefined tools. Tool requests and results pass through Black Swan Causal Labs’ Cloudflare relay to your agent provider. Study content is not saved in the relay database. Share the connection key only with an agent you trust.</p>
    <p class="muted">Keep this page open. The key expires in two hours. Disconnect or close/reload the page to end access. Changes remain undoable in the studio.</p>
    <p class="status" role="status" aria-live="polite">Not connected.</p>
    <div class="setup" hidden><label>MCP server URL<input readonly aria-label="MCP server URL"></label>
    <label>Authorization header<input type="password" readonly aria-label="Authorization header"></label>
    <p class="muted">Use Streamable HTTP and the complete Authorization header value. Your client must support custom headers. Clients with native WebMCP can use the studio page instead.</p>
    <div class="row"><button data-action="copy-header">Copy authorization</button><button data-action="copy-config">Copy MCP configuration</button></div></div>
    <div class="row"><button class="primary" data-action="enable">Enable connection</button><button data-action="disconnect" hidden>Disconnect</button></div>`;
  shadow.append(launcher, dialog);
  const control = document.getElementById('canvas-mcp-control');
  if (!control) launcher.classList.add('fallback');
  (control || document.body).append(host);
  const status = dialog.querySelector('.status');
  const setup = dialog.querySelector('.setup');
  const enable = dialog.querySelector('[data-action="enable"]');
  const disconnect = dialog.querySelector('[data-action="disconnect"]');
  const urlField = dialog.querySelector('[aria-label="MCP server URL"]');
  const authField = dialog.querySelector('[aria-label="Authorization header"]');
  const toolMap = new Map(tools.map(tool => [tool.name, tool]));
  let socket = null, credentials = null, active = false, disposed = false, timeout = null, callChain = Promise.resolve();
  let generation = 0;
  const reset = message => {
    active = false; credentials = null; setup.hidden = true; authField.value = '';
    enable.disabled = false; enable.hidden = false; disconnect.hidden = true;
    launcher.textContent = 'Connect MCP'; status.textContent = message;
    clearTimeout(timeout);
  };
  const revoke = async session => {
    if (!session) return;
    try { await fetch(endpoint + '/disconnect', { method: 'POST', headers: { Authorization: `Bearer ${session.id}.${session.hostToken}` }, keepalive: true }); }
    catch { /* The WebSocket close and fixed expiry also revoke access. */ }
  };
  const stop = async () => {
    ++generation; active = false;
    const session = credentials;
    const oldSocket = socket; socket = null;
    // Clear access locally before waiting for the network.
    reset('Disconnected. This key can no longer control the canvas.');
    oldSocket?.close(1000, 'Researcher disconnected');
    await revoke(session);
  };
  const copy = async value => {
    try { await navigator.clipboard.writeText(value); status.textContent = 'Copied. Keep this key private.'; }
    catch { status.textContent = 'Clipboard is unavailable. Select and copy the connection fields manually.'; }
  };
  launcher.onclick = () => dialog.showModal();
  dialog.querySelector('[aria-label="Close connection panel"]').onclick = () => dialog.close();
  disconnect.onclick = () => { void stop(); };
  dialog.querySelector('[data-action="copy-header"]').onclick = () => { if (credentials && active) void copy('Bearer ' + credentials.clientToken); };
  dialog.querySelector('[data-action="copy-config"]').onclick = () => {
    if (credentials && active) void copy(JSON.stringify({ mcpServers: { [title.toLowerCase().replace(/[^a-z0-9]+/g, '-')]: { url: endpoint + '/mcp', headers: { Authorization: 'Bearer ' + credentials.clientToken } } } }, null, 2));
  };
  enable.onclick = async () => {
    const attempt = ++generation;
    enable.disabled = true; status.textContent = 'Connecting this canvas…';
    try {
      const response = await fetch(endpoint + '/sessions', { method: 'POST', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(response.status === 429 ? 'Too many attempts. Try again in a minute.' : 'Could not create a connection. Try again.');
      const session = await response.json();
      if (disposed || attempt !== generation) { await revoke(session); return; }
      credentials = session;
      const wsUrl = new URL(endpoint + '/browser/' + session.id); wsUrl.protocol = wsUrl.protocol === 'http:' ? 'ws:' : 'wss:';
      const ws = new WebSocket(wsUrl, ['canvas-bridge', 'auth.' + session.hostToken]);
      socket = ws;
      timeout = setTimeout(() => { if (socket === ws) { void stop(); status.textContent = 'Connection timed out. Enable a new connection.'; } }, 15_000);
      ws.onopen = () => {
        if (disposed || socket !== ws) { ws.close(); return; }
        const descriptors = tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) }));
        ws.send(JSON.stringify({ type: 'ready', tools: descriptors }));
      };
      ws.onmessage = event => {
        if (socket !== ws || disposed || typeof event.data !== 'string' || event.data.length > 131072) return;
        let data; try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'ready') {
          clearTimeout(timeout); active = true;
          timeout = setTimeout(() => { void stop(); status.textContent = 'Connection expired. Enable a new one to continue.'; }, Math.max(0, session.expiresAt - Date.now()));
          setup.hidden = false; enable.hidden = true; disconnect.hidden = false;
          urlField.value = endpoint + '/mcp'; authField.value = 'Bearer ' + session.clientToken;
          launcher.textContent = 'MCP connected'; status.textContent = 'Connected. Add these settings to your MCP client.';
        } else if (data.type === 'call') {
          // Serialize remote calls and verify the connection again immediately before execution.
          callChain = callChain.then(async () => {
            if (!active || socket !== ws || Date.now() > data.deadline || disposed) return;
            let result;
            try {
              const tool = toolMap.get(data.name);
              if (!tool) throw new Error('Unknown canvas tool.');
              result = await tool.execute(data.arguments ?? {});
              if (!Array.isArray(result?.content)) result = { content: [{ type: 'text', text: JSON.stringify(result) }] };
            } catch (error) { result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Canvas operation failed.' }] }; }
            if (active && socket === ws && ws.readyState === WebSocket.OPEN) {
              const payload = JSON.stringify({ type: 'result', id: data.id, result });
              ws.send(new TextEncoder().encode(payload).length <= 2 * 1024 * 1024 ? payload : JSON.stringify({ type: 'result', id: data.id, result: { isError: true, content: [{ type: 'text', text: 'Result exceeds the bridge limit. Use the studio export controls.' }] } }));
              status.textContent = 'Last agent operation: ' + data.name + '. Review changes on the canvas.';
            }
          }).catch(() => { status.textContent = 'Operation could not be confirmed. Inspect the canvas before retrying.'; });
        }
      };
      ws.onclose = () => { if (socket === ws) { socket = null; reset('Canvas connection ended. Enable a new connection to continue.'); } };
      ws.onerror = () => { if (socket === ws) { void stop(); status.textContent = 'Could not connect. Check your network and try again.'; } };
    } catch (error) { if (attempt === generation) reset(error instanceof Error ? error.message : 'Connection failed.'); }
  };
  const cleanup = () => { disposed = true; void stop(); host.remove(); };
  signal?.addEventListener('abort', cleanup, { once: true });
  return cleanup;
}
