import { timingSafeEqual } from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Validator, type Schema } from '@cfworker/json-schema';

const TTL = 2 * 60 * 60 * 1000;
const INPUT_LIMIT = 128 * 1024;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const tokenPattern = /^[a-f0-9]{64}$/;
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
const errorResult = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const origins = (env: Env) => env.STUDIO_ORIGINS.split(',');

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > INPUT_LIMIT) { await reader.cancel(); throw new Error('Request exceeds 128 KiB'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

type Session = { hostHash: ArrayBuffer; clientHash: ArrayBuffer; expiresAt: number };
type BrowserAttachment = { tools: Tool[] };
type Pending = { resolve: (result: CallToolResult) => void; timer: ReturnType<typeof setTimeout> };

export class CanvasSession extends DurableObject<Env> {
  private pending = new Map<string, Pending>();

  async create(hostHash: ArrayBuffer, clientHash: ArrayBuffer, expiresAt: number) {
    if (await this.ctx.storage.get('session')) throw new Error('Session already exists');
    await this.ctx.storage.put('session', { hostHash, clientHash, expiresAt } satisfies Session);
    await this.ctx.storage.setAlarm(expiresAt);
  }

  private async authorized(secret: string, role: 'host' | 'client') {
    if (!tokenPattern.test(secret)) return false;
    const session = await this.ctx.storage.get<Session>('session');
    if (!session || Date.now() >= session.expiresAt) return false;
    return timingSafeEqual(new Uint8Array(await digest(secret)), new Uint8Array(role === 'host' ? session.hostHash : session.clientHash));
  }

  private finishPending(message: string) {
    for (const { resolve, timer } of this.pending.values()) { clearTimeout(timer); resolve(errorResult(message)); }
    this.pending.clear();
  }

  async alarm() {
    this.finishPending('Canvas session expired. Check the canvas before retrying any edit.');
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'Session expired');
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/browser/')) {
      const protocol = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(x => x.trim()) ?? [];
      const secret = protocol.find(x => x.startsWith('auth.'))?.slice(5) ?? '';
      if (!origins(this.env).includes(request.headers.get('Origin') ?? '') || !await this.authorized(secret, 'host')) return json({ error: 'Unauthorized' }, 401);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      if (this.ctx.getWebSockets().length) return json({ error: 'A canvas is already connected' }, 409);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ tools: [] } satisfies BrowserAttachment);
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'canvas-bridge' } });
    }

    const bearer = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
    const secret = bearer.split('.')[1] ?? '';
    if (url.pathname === '/disconnect') {
      if (!await this.authorized(secret, 'host')) return json({ error: 'Unauthorized' }, 401);
      await this.alarm();
      return json({ disconnected: true });
    }
    if (!await this.authorized(secret, 'client')) return new Response('A current canvas connection key is required.', {
      status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="canvas-session"', 'Cache-Control': 'no-store' },
    });
    if (url.pathname !== '/mcp') return json({ error: 'Not found' }, 404);
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

    let body: unknown;
    try { body = await boundedJson(request); } catch { return json({ error: 'Invalid JSON or request exceeds 128 KiB' }, 400); }
    const server = new Server({ name: this.env.SERVER_NAME, version: '1.0.0' }, {
      capabilities: { tools: {} },
      instructions: 'Tools operate on the connected researcher browser canvas. Keep the page open. Read current state before editing. Changes are visible and undoable. If a call disconnects or times out, inspect current state before retrying; a mutation may have completed. Never infer unreported scientific facts.',
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const socket = this.ctx.getWebSockets()[0];
      const tools = socket?.deserializeAttachment()?.tools as Tool[] | undefined;
      if (!tools?.length) throw new Error('The canvas is not ready. Keep the studio page open and connect again.');
      return { tools };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => this.callCanvas(params.name, params.arguments ?? {}));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { return await transport.handleRequest(request, { parsedBody: body }); }
    finally { await server.close(); }
  }

  private async callCanvas(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const socket = this.ctx.getWebSockets()[0];
    if (!socket) return errorResult('The browser canvas is disconnected. Reconnect from the studio.');
    const tools = (socket.deserializeAttachment() as BrowserAttachment).tools;
    const tool = tools.find(t => t.name === name);
    if (!tool) return errorResult('Unknown tool for this canvas.');
    // This validator interprets schemas without eval(), as required by Workers.
    const validation = new Validator(tool.inputSchema as Schema).validate(args);
    if (!validation.valid) return errorResult('Invalid tool arguments: ' + validation.errors.map(e => e.instanceLocation + ': ' + e.error).join('; '));
    if (this.pending.size) return errorResult('Another canvas operation is in progress. Wait for its result before continuing.');
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(errorResult('Canvas operation timed out; it may have completed. Read the canvas state before retrying an edit.'));
      }, 30_000);
      this.pending.set(id, { resolve, timer });
      try { socket.send(JSON.stringify({ type: 'call', id, name, arguments: args, deadline: Date.now() + 28_000 })); }
      catch { clearTimeout(timer); this.pending.delete(id); resolve(errorResult('Canvas disconnected before the operation could be confirmed. Inspect state before retrying.')); }
    });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || new TextEncoder().encode(message).byteLength > OUTPUT_LIMIT) { socket.close(1009, 'Message too large'); return; }
    let data: { type?: string; tools?: Tool[]; id?: string; result?: CallToolResult };
    try { data = JSON.parse(message); } catch { socket.close(1008, 'Invalid message'); return; }
    if (data.type === 'ready') {
      const allowed = this.env.TOOL_NAMES.split(',');
      const tools = data.tools;
      if (!Array.isArray(tools) || tools.length !== allowed.length || new Set(tools.map(t => t.name)).size !== allowed.length || tools.some(t => !allowed.includes(t.name) || t.inputSchema?.type !== 'object') || JSON.stringify(tools).length > 24_000) {
        socket.close(1008, 'Unexpected tool catalog'); return;
      }
      socket.serializeAttachment({ tools } satisfies BrowserAttachment);
      socket.send(JSON.stringify({ type: 'ready' }));
    } else if (data.type === 'result' && data.id) {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(data.id);
      if (!Array.isArray(data.result?.content)) pending.resolve(errorResult('Canvas returned an invalid tool result.'));
      else pending.resolve(data.result);
    }
  }

  async webSocketClose(socket: WebSocket, code: number) {
    socket.close(code === 1006 ? 1011 : code, 'Canvas disconnected');
    this.finishPending('Canvas disconnected; inspect current state before retrying an edit.');
    // Closing/reloading the page revokes both credentials immediately.
    await this.ctx.storage.deleteAll();
  }
  async webSocketError(socket: WebSocket) { await this.webSocketClose(socket, 1011); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const isStudio = origin !== null && origins(env).includes(origin);
    // Authenticated MCP clients may send any Origin; browser pairing is limited to our own studios.
    const canCors = url.pathname === '/mcp' || isStudio;
    const cors = (response: Response) => {
      if (response.status === 101) return response;
      const out = new Response(response.body, response);
      out.headers.set('Cache-Control', 'no-store');
      out.headers.set('X-Content-Type-Options', 'nosniff');
      if (origin && canCors) {
        out.headers.set('Access-Control-Allow-Origin', origin);
        out.headers.set('Vary', 'Origin');
        out.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        out.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id');
        out.headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
      }
      return out;
    };
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: canCors ? 204 : 403 }));
    if (url.pathname === '/' || url.pathname === '/health') return cors(json({ name: env.SERVER_NAME, version: '1.0.0', transport: 'streamable-http', studio: origins(env)[0], setup: 'Open the studio, select Connect MCP, enable a connection and use the provided Authorization header. Keep the page open.' }));
    try {
      if (url.pathname === '/sessions' && request.method === 'POST') {
        if (!isStudio) return cors(json({ error: 'Open the official studio to connect a canvas.' }, 403));
        const limit = await env.CREATE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' });
        if (!limit.success) return cors(json({ error: 'Too many connection attempts. Try again in a minute.' }, 429));
        const id = random(), host = random(), client = random(), expiresAt = Date.now() + TTL;
        await env.SESSIONS.getByName(id).create(await digest(host), await digest(client), expiresAt);
        return cors(json({ id, hostToken: host, clientToken: `${id}.${client}`, expiresAt }, 201));
      }
      const id = url.pathname.startsWith('/browser/') ? url.pathname.slice('/browser/'.length) : request.headers.get('Authorization')?.replace(/^Bearer /, '').split('.')[0];
      if (!id || !tokenPattern.test(id)) return cors(new Response('Use the connection key from the studio.', { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="canvas-session"' } }));
      const limit = await env.REQUEST_LIMIT.limit({ key: id });
      if (!limit.success) return cors(json({ error: 'Too many requests for this canvas.' }, 429));
      if (url.pathname === '/mcp' && request.method === 'POST') {
        // Buffer only a bounded body before the DO hop, including on rejected credentials.
        // This also avoids leaving an upstream request stream alive after an early 401.
        try { request = new Request(request, { body: JSON.stringify(await boundedJson(request)) }); }
        catch { return cors(json({ error: 'Invalid JSON or request exceeds 128 KiB' }, 400)); }
      }
      return cors(await env.SESSIONS.getByName(id).fetch(request));
    } catch {
      // Never log request bodies, credentials, or study content.
      return cors(json({ error: 'Bridge unavailable. Inspect the canvas before retrying an edit.' }, 503));
    }
  },
} satisfies ExportedHandler<Env>;
