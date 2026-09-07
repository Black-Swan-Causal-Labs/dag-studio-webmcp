import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdir } from 'node:fs/promises';

const kind = process.env.STUDIO_KIND ?? 'dag';
const studio = process.env.STUDIO_URL ?? (kind === 'dag' ? 'http://127.0.0.1:5173' : 'http://127.0.0.1:5174');
const endpoint = process.env.BRIDGE_URL ?? (kind === 'dag' ? 'http://127.0.0.1:8791' : 'http://127.0.0.1:8792');
const readName = kind === 'dag' ? 'get_current_dag' : 'get_study_spec';
const unpack = result => { assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); };

test(`${kind}: paired MCP controls the real canvas, preserves human edits, isolates sessions, and revokes keys`, { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const clients = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(studio);
    assert.match(await page.title(), /Studio/);
    assert.equal(await page.locator('vite-error-overlay').count(), 0);

    async function pair(target) {
      await target.getByRole('button', { name: 'Connect MCP', exact: true }).click();
      await target.getByRole('button', { name: 'Enable connection', exact: true }).click();
      await target.getByText('Connected. Add these settings to your MCP client.', { exact: true }).waitFor({ timeout: 20000 });
      const auth = await target.locator('[aria-label="Authorization header"]').inputValue();
      const url = await target.getByRole('textbox', { name: 'MCP server URL', exact: true }).inputValue();
      assert.equal(url, endpoint + '/mcp');
      const client = new Client({ name: 'canvas-bridge-integration-test', version: '1.0.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: auth } } }));
      await target.getByRole('button', { name: 'Close connection panel' }).click();
      return { client, auth };
    }

    const { client, auth } = await pair(page);
    const list = await client.listTools();
    assert.equal(list.tools.length, kind === 'dag' ? 9 : 10);
    const initial = unpack(await client.callTool({ name: readName, arguments: {} }));
    assert.equal((await client.callTool({ name: 'not_a_canvas_tool', arguments: {} })).isError, true);
    assert.equal((await fetch(endpoint + '/disconnect', { method: 'POST', headers: { Authorization: auth } })).status, 401);
    assert.equal((await fetch(endpoint + '/mcp', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ oversized: 'x'.repeat(131073) }) })).status, 400);
    const invalid = await client.callTool({ name: kind === 'dag' ? 'add_node' : 'update_design_element', arguments: {} });
    assert.equal(invalid.isError, true);
    assert.deepEqual(unpack(await client.callTool({ name: readName, arguments: {} })), initial);

    if (kind === 'dag') {
      unpack(await client.callTool({ name: 'add_node', arguments: { id: 'bridge-test-node', label: 'MCP bridge test', type: 'unclassified', x: 300, y: 240 } }));
      await page.getByText('MCP bridge test', { exact: true }).first().waitFor();
      assert.ok(unpack(await client.callTool({ name: readName, arguments: {} })).nodes.some(n => n.id === 'bridge-test-node'));
      await page.getByRole('button', { name: /Undo/i }).first().click();
      assert.ok(!unpack(await client.callTool({ name: readName, arguments: {} })).nodes.some(n => n.id === 'bridge-test-node'));
    } else {
      const id = initial.spec.elements[0].id;
      const updated = unpack(await client.callTool({ name: 'update_design_element', arguments: { id, expected_revision: initial.revision, patch: { label: 'MCP bridge test' } } }));
      assert.equal(updated.revision, initial.revision + 1);
      assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'MCP bridge test');
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Human edit after MCP');
      await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
      assert.equal(unpack(await client.callTool({ name: readName, arguments: {} })).spec.elements[0].label, 'Human edit after MCP');
      const stale = await client.callTool({ name: 'update_design_element', arguments: { id, expected_revision: initial.revision, patch: { label: 'STALE' } } });
      assert.equal(stale.isError, true);
      assert.equal(unpack(await client.callTool({ name: readName, arguments: {} })).spec.elements[0].label, 'Human edit after MCP');
      const svg = unpack(await client.callTool({ name: 'export_schematic', arguments: {} }));
      assert.match(svg.svg, /^<svg/);
    }
    if (process.env.EVIDENCE_DIR) {
      await mkdir(process.env.EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/${kind}-mcp-canvas.png` });
    }

    const otherPage = await context.newPage();
    await otherPage.goto(studio);
    const other = await pair(otherPage);
    assert.deepEqual(unpack(await other.client.callTool({ name: readName, arguments: {} })), initial);
    const rejected = await fetch(endpoint + '/mcp', { method: 'POST', headers: { Authorization: auth.slice(0, -8) + '00000000', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(rejected.status, 401);
    assert.equal((await fetch(endpoint + '/sessions', { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);

    await page.getByRole('button', { name: 'MCP connected', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    let revoked;
    for (let attempt = 0; attempt < 20; attempt++) {
      revoked = await fetch(endpoint + '/mcp', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: '{}' });
      if (revoked.status === 401) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(revoked.status, 401);
    // A different researcher's session remains usable after the first disconnects.
    assert.deepEqual(unpack(await other.client.callTool({ name: readName, arguments: {} })), initial);
    await otherPage.close({ runBeforeUnload: false });
    let closedStatus;
    for (let attempt = 0; attempt < 20; attempt++) {
      closedStatus = (await fetch(endpoint + '/mcp', { method: 'POST', headers: { Authorization: other.auth, 'Content-Type': 'application/json' }, body: '{}' })).status;
      if (closedStatus === 401) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(closedStatus, 401, 'Closing a canvas must revoke its connection key');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: native tool catalog, MCP handshake, live mutation, human edit/Undo, isolation, invalid input, origin gate, credential rejection, disconnect revocation; no page runtime errors.');
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    await browser.close();
  }
});
