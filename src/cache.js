import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool        TEXT NOT NULL,
  cache_key   TEXT NOT NULL UNIQUE,
  query       TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_searches_created    ON searches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_searches_tool_time  ON searches(tool, created_at DESC);
`;

/**
 * SQLite-backed cache for research-mcp tool results.
 *
 * Pure data layer. No knowledge of HTTP, MCP, or specific tool semantics —
 * just stores blobs keyed by cache_key with timestamps.
 */
export class Cache {
  constructor({
    dbPath,
    now = () => Date.now(),
    maxRows = 5000,
    maxAgeMs = 30 * 24 * 3600 * 1000,
    pruneEveryWrites = 200,
    pruneOnStart = true,
  } = {}) {
    if (!dbPath) throw new Error('Cache requires dbPath');
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.now = now;
    this.maxRows = maxRows;
    this.maxAgeMs = maxAgeMs;
    this.pruneEveryWrites = pruneEveryWrites;
    this._writeCount = 0;

    this._insert = this.db.prepare(`
      INSERT INTO searches (tool, cache_key, query, params_json, result_json, created_at)
      VALUES (@tool, @cache_key, @query, @params_json, @result_json, @created_at)
      ON CONFLICT(cache_key) DO UPDATE SET
        tool = excluded.tool,
        query = excluded.query,
        params_json = excluded.params_json,
        result_json = excluded.result_json,
        created_at = excluded.created_at
    `);
    this._getByKey = this.db.prepare(`SELECT * FROM searches WHERE cache_key = ?`);
    this._getById  = this.db.prepare(`SELECT * FROM searches WHERE id = ?`);
    this._listAll  = this.db.prepare(`
      SELECT id, tool, query, params_json, created_at
      FROM searches
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this._listByTool = this.db.prepare(`
      SELECT id, tool, query, params_json, created_at
      FROM searches
      WHERE tool = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    this._pruneByAge = this.db.prepare(`DELETE FROM searches WHERE created_at < ?`);
    this._countRows = this.db.prepare(`SELECT COUNT(*) AS n FROM searches`);
    // LIMIT -1 OFFSET ? = delete every row past the newest `maxRows`.
    this._pruneOverCap = this.db.prepare(`
      DELETE FROM searches WHERE id IN (
        SELECT id FROM searches ORDER BY created_at DESC LIMIT -1 OFFSET ?
      )
    `);

    if (pruneOnStart) {
      try { this.prune(); } catch { /* a locked/odd WAL on boot must not crash startup */ }
    }
  }

  set({ tool, cacheKey, query, params, result }) {
    this._insert.run({
      tool,
      cache_key: cacheKey,
      query,
      params_json: JSON.stringify(params ?? {}),
      result_json: JSON.stringify(result),
      created_at: this.now(),
    });
    // Opportunistic, amortized eviction — a COUNT(*) every K writes is cheap.
    if (this.pruneEveryWrites > 0 && ++this._writeCount % this.pruneEveryWrites === 0) {
      try { this.prune(); } catch { /* eviction is best-effort */ }
    }
  }

  /**
   * Evict rows older than maxAgeMs and trim the table to the newest maxRows.
   * Age-based eviction is independent of read-time TTL. Returns counts for
   * observability. Safe to call repeatedly; driven by the injectable now() clock.
   */
  prune() {
    const cutoff = this.now() - this.maxAgeMs;
    const byAge = this._pruneByAge.run(cutoff).changes;
    let byCap = 0;
    if (this.maxRows > 0) {
      const { n } = this._countRows.get();
      if (n > this.maxRows) byCap = this._pruneOverCap.run(this.maxRows).changes;
    }
    return { byAge, byCap, remaining: this._countRows.get().n };
  }

  get({ cacheKey, ttlMs }) {
    if (!ttlMs || ttlMs <= 0) return null;
    const row = this._getByKey.get(cacheKey);
    if (!row) return null;
    if (this.now() - row.created_at > ttlMs) return null;
    return rowToEntry(row);
  }

  list({ limit = 20, toolFilter = null } = {}) {
    const cappedLimit = Math.min(Math.max(1, limit), 100);
    const rows = toolFilter
      ? this._listByTool.all(toolFilter, cappedLimit)
      : this._listAll.all(cappedLimit);
    const nowMs = this.now();
    return rows.map(r => ({
      id: r.id,
      tool: r.tool,
      query: r.query,
      params: JSON.parse(r.params_json),
      created_at_iso: new Date(r.created_at).toISOString(),
      age_hours: Math.round((nowMs - r.created_at) / 36e4) / 100,
    }));
  }

  getById(id) {
    const row = this._getById.get(id);
    if (!row) return null;
    return rowToEntry(row);
  }

  close() {
    this.db.close();
  }
}

function rowToEntry(row) {
  return {
    id: row.id,
    tool: row.tool,
    cacheKey: row.cache_key,
    query: row.query,
    params: JSON.parse(row.params_json),
    result: JSON.parse(row.result_json),
    created_at: row.created_at,
    created_at_iso: new Date(row.created_at).toISOString(),
  };
}
