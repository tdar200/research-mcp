import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'src', 'server.js');
const TEST_DB = join(tmpdir(), `research-mcp-ebay-server-test-${process.pid}.db`);

async function rpc(messages, env = {}) {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER], {
      env: { ...process.env, RESEARCH_MCP_DB_PATH: TEST_DB, RESEARCH_MCP_CACHE_TTL_HOURS: '0', EBAY_CLIENT_ID: '', EBAY_CLIENT_SECRET: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let errBuf = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { errBuf += c.toString(); });
    child.on('error', reject);
    child.on('close', () => {
      const lines = out.trim().split('\n').filter(Boolean);
      try {
        resolve(lines.map(l => JSON.parse(l)));
      } catch (e) {
        reject(new Error(`Failed to parse server output. stderr=${errBuf}\nstdout=${out}`));
      }
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    setTimeout(() => child.stdin.end(), 200);
  });
}

test('server lists ebay_search with query/limit/condition/price schema', async () => {
  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  const listResp = responses.find(r => r.id === 2);
  const tool = listResp.result.tools.find(t => t.name === 'ebay_search');
  assert.ok(tool, 'ebay_search tool listed');
  const props = tool.inputSchema.properties;
  assert.ok(props.query, 'has query');
  assert.ok(props.limit, 'has limit');
  assert.ok(props.condition, 'has condition');
  assert.ok(props.price_min, 'has price_min');
  assert.ok(props.price_max, 'has price_max');
  assert.ok(props.sort, 'has sort');
  assert.ok(props.marketplace, 'has marketplace');
  assert.deepEqual(tool.inputSchema.required, ['query']);
});

test('ebay_search without credentials returns setup guidance, not a crash', async () => {
  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ebay_search', arguments: { query: 'ryzen 9 7950x' } } },
  ]);
  const callResp = responses.find(r => r.id === 2);
  assert.ok(callResp, 'expected tools/call response');
  const payload = JSON.parse(callResp.result.content[0].text);
  assert.deepEqual(payload.results, []);
  assert.match(payload.error, /EBAY_CLIENT_ID/);
  assert.match(payload.error, /developer\.ebay\.com/);
});
