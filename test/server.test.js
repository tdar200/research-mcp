import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'src', 'server.js');
const TEST_DB = join(tmpdir(), `research-mcp-server-test-${process.pid}.db`);

/** Spawn the server, write a sequence of JSON-RPC messages, return parsed responses. */
async function rpc(messages, env = {}) {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER], {
      env: { ...process.env, RESEARCH_MCP_DB_PATH: TEST_DB, RESEARCH_MCP_CACHE_TTL_HOURS: '0', ...env },
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

test('server lists 5 tools including list_research and get_research', async () => {
  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  const listResp = responses.find(r => r.id === 2);
  assert.ok(listResp, 'expected tools/list response');
  const names = listResp.result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['fetch_url', 'get_research', 'list_research', 'search_and_read', 'web_search']);
});

test('server list_research returns empty entries on fresh DB', async () => {
  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_research', arguments: { limit: 10 } } },
  ]);
  const callResp = responses.find(r => r.id === 2);
  assert.ok(callResp, 'expected tools/call response');
  const payload = JSON.parse(callResp.result.content[0].text);
  assert.deepEqual(payload, { entries: [] });
});

test('server get_research returns error on unknown id', async () => {
  const responses = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_research', arguments: { id: 999 } } },
  ]);
  const callResp = responses.find(r => r.id === 2);
  assert.ok(callResp.result.isError, 'expected error result');
});
