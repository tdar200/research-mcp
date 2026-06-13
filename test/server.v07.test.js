import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Cache } from '../src/cache.js';
import { UNTRUSTED_BEGIN } from '../src/untrusted.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'src', 'server.js');

function freshDb(tag) {
  const p = join(tmpdir(), `research-mcp-server-v07-${tag}-${process.pid}.db`);
  for (const s of ['', '-wal', '-shm']) { try { if (existsSync(p + s)) unlinkSync(p + s); } catch { /* ignore */ } }
  return p;
}

/** Seed a clean (unfenced) fetch_url cache entry, then return the db path. */
function seedFetchEntry(tag) {
  const db = freshDb(tag);
  const cache = new Cache({ dbPath: db, pruneOnStart: false });
  cache.set({
    tool: 'fetch_url',
    cacheKey: 'seed1',
    query: 'https://x.example/p',
    params: { max_chars: 20000 },
    result: { url: 'https://x.example/p', title: 'T', content: 'CLEAN PAGE BODY', truncated: false },
  });
  cache.close();
  return db;
}

/** Spawn the server against an existing db (does NOT unlink it) and run a sequence. */
function rpc(dbPath, messages, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER], {
      env: { ...process.env, RESEARCH_MCP_DB_PATH: dbPath, RESEARCH_MCP_CACHE_TTL_HOURS: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', () => {
      const lines = out.trim().split('\n').filter(Boolean);
      try { resolve(lines.map((l) => JSON.parse(l))); }
      catch (e) { reject(new Error(`parse fail. stderr=${err}\nstdout=${out}`)); }
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    setTimeout(() => child.stdin.end(), 300);
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
const GET = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_research', arguments: { id: 1 } } };

test('get_research fences cached fetch_url content as untrusted by default', async () => {
  const db = seedFetchEntry('wrap');
  const responses = await rpc(db, [INIT, GET]);
  const r = responses.find((x) => x.id === 2);
  const text = r.result.content[0].text;
  assert.ok(text.includes(UNTRUSTED_BEGIN), 'content should be fenced as untrusted');
  assert.ok(text.includes('CLEAN PAGE BODY'));
});

test('get_research does not fence content when DISABLE_UNTRUSTED_WRAP=1', async () => {
  const db = seedFetchEntry('nowrap');
  const responses = await rpc(db, [INIT, GET], { DISABLE_UNTRUSTED_WRAP: '1' });
  const r = responses.find((x) => x.id === 2);
  const text = r.result.content[0].text;
  assert.ok(!text.includes(UNTRUSTED_BEGIN), 'content should NOT be fenced');
  assert.ok(text.includes('CLEAN PAGE BODY'));
});
