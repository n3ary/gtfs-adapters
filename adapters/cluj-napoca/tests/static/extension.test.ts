import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import {
  staticExtension,
  applyStaticPostLoad,
  type ComputedUpdates,
} from '../../src/static/index.ts';
import { SCHEMA } from '@n3ary/gtfs-spec/sql';

/**
 * End-to-end check of staticExtension applied to a SQLite built
 * from a synthetic GTFS zip. Verifies:
 *   1. networks.network_color column was added (DDL landed)
 *   2. routes.route_color was substituted by the fixup
 *   3. networks.network_color was computed for at least one network
 *   4. _neary_config exists with the right rows from feedConfig.timing
 */

const WORK = join(tmpdir(), `adapter-static-ext-${Date.now()}`);
const SQLITE_PATH = join(WORK, 'feeds.sqlite3');
const SQLITE_GZ = join(WORK, 'feeds.sqlite3.gz');

function buildSyntheticSqlite(): void {
  mkdirSync(WORK, { recursive: true });
  const db = new DatabaseSync(SQLITE_PATH);
  try {
    for (const [tableName, spec] of Object.entries(SCHEMA)) {
      const cols = spec.columns.map(([n, t]) => `${n} ${t}`).join(', ');
      const constraints = spec.tableConstraints ?? [];
      const body = [...spec.columns.map(([n, t]) => `${n} ${t}`), ...constraints].join(', ');
      const opts = spec.withoutRowid ? ' WITHOUT ROWID' : '';
      db.exec(`CREATE TABLE ${tableName} (${body})${opts};`);
      void cols;
      void tableName;
    }
    // Synthetic routes — one route with placeholder (#000) + one valid.
    db.prepare(
      'INSERT INTO routes (route_id, agency_id, route_short_name, route_type, route_color) VALUES (?, ?, ?, ?, ?)',
    ).run('R1', 'A1', '1', '3', '000000');
    db.prepare(
      'INSERT INTO routes (route_id, agency_id, route_short_name, route_type, route_color) VALUES (?, ?, ?, ?, ?)',
    ).run('R2', 'A1', '2', '3', 'FF0000');
    // Networks + route_networks.
    db.prepare('INSERT INTO networks (network_id, network_name) VALUES (?, ?)').run('night', 'Night');
    db.prepare('INSERT INTO networks (network_id, network_name) VALUES (?, ?)').run('school', 'School');
    db.prepare('INSERT INTO route_networks (network_id, route_id) VALUES (?, ?)').run('night', 'R1');
    db.prepare('INSERT INTO route_networks (network_id, route_id) VALUES (?, ?)').run('school', 'R2');
  } finally {
    db.close();
  }
}

function readSqlite(): DatabaseSync {
  // gz-compress / decompress round-trip to mirror the pipeline's filename
  // (gtfs-static writes .sqlite3.gz). The hash/size semantics are
  // exercised elsewhere; we only care that we can read what we wrote.
  const db = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  return db;
}

// Test-side mirror of the pipeline's UPDATE applier (see
// @gtfs/static/src/lib/extension.ts + make-sqlite.ts). The test stands
// in for the pipeline so we can verify the hook's return value → SQL
// effect round-trip without setting up the full pipeline.
function applyUpdatesToTestDb(db: DatabaseSync, updates: ComputedUpdates): void {
  db.exec('BEGIN');
  try {
    for (const [tableName, rows] of Object.entries(updates)) {
      if (rows.length === 0) continue;
      const spec = SCHEMA[tableName];
      if (!spec) throw new Error(`test: unknown table "${tableName}"`);
      // Find PK columns — single PK on `route_id` / `network_id` is
      // declared as `network_id TEXT PRIMARY KEY` (PRIMARY KEY in the
      // type string). Adequate for the 2 tables this adapter touches.
      const pkCol = spec.columns.find(([, type]) => /\bPRIMARY KEY\b/i.test(type))?.[0];
      if (!pkCol) throw new Error(`test: no PK on "${tableName}"`);
      const setCols = Object.keys(rows[0]!).filter((c) => c !== pkCol);
      if (setCols.length === 0) continue;
      const setClause = setCols.map((c) => `${c} = ?`).join(', ');
      const stmt = db.prepare(`UPDATE ${tableName} SET ${setClause} WHERE ${pkCol} = ?`);
      for (const row of rows) {
        const values = [
          ...setCols.map((c) => row[c] as string | number | bigint | null | Uint8Array),
          row[pkCol] as string | number | bigint | null | Uint8Array,
        ];
        // node:sqlite rest spread variance (same as pipeline).
        stmt.run(...(values as Array<string | number | bigint | null | Uint8Array>));
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* original error is the actionable one */ }
    throw e;
  }
}

function runExtension(ext: ReturnType<typeof staticExtension>): DatabaseSync {
  // Re-open rw so the extension can UPDATE rows.
  const db = new DatabaseSync(SQLITE_PATH);
  try {
    // Apply columnExtensions first (mirrors createSchema() order).
    for (const { table, column } of ext.columnExtensions ?? []) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column[0]} ${column[1]};`);
    }
    for (const [tableName, te] of Object.entries(ext.tableExtensions ?? {})) {
      const cols = te.columns.map(([n, t]) => `${n} ${t}`).join(', ');
      db.exec(`CREATE TABLE ${tableName} (${cols});`);
      if (te.rows && te.rows.length > 0) {
        const colNames = te.columns.map(([n]) => n);
        const stmt = db.prepare(
          `INSERT OR IGNORE INTO ${tableName} (${colNames.join(', ')}) VALUES (${colNames.map(() => '?').join(', ')})`,
        );
        for (const row of te.rows) {
          // node:sqlite rest spread variance — same as pipeline.
          stmt.run(...(colNames.map((c) => (row[c] ?? null)) as Array<string | number | bigint | null | Uint8Array>));
        }
      }
    }
    // Read the buffered routes/networks/route_networks back as the
    // pipeline does, then run the hook (now pure data-in/data-out)
    // and apply the returned updates via the test's UPDATE helper.
    const routes = db.prepare('SELECT * FROM routes').all() as Array<Record<string, unknown>>;
    const networks = db.prepare('SELECT * FROM networks').all() as Array<Record<string, unknown>>;
    const routeNetworks = db.prepare('SELECT * FROM route_networks').all() as Array<Record<string, unknown>>;
    const updates = applyStaticPostLoad({
      feedId: 'test',
      routes,
      networks,
      routeNetworks,
    });
    applyUpdatesToTestDb(db, updates);
  } finally {
    db.close();
  }
  return readSqlite();
}

const TIMING_BLOCK = { peak_kmh: 14, offpeak_kmh: 22 };

beforeAll(async () => {
  buildSyntheticSqlite();
});

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
});

describe('staticExtension', () => {
  it('adds networks.network_color + _neary_config + applies route fixup + computes network colors', async () => {
    const ext = staticExtension({ timing: TIMING_BLOCK });
    expect(ext.columnExtensions).toEqual([
      { table: 'networks', column: ['network_color', 'TEXT'] },
    ]);
    expect(Object.keys(ext.tableExtensions ?? {})).toEqual(['_neary_config']);
    expect(ext.fillComputedColumns).toBeDefined();

    const db = runExtension(ext);
    try {
      // networks.network_color was computed, not NULL, for both networks.
      const netRows = db.prepare('SELECT network_id, network_color FROM networks ORDER BY network_id').all() as Array<{ network_id: string; network_color: string | null }>;
      expect(netRows.length).toBe(2);
      for (const r of netRows) {
        expect(r.network_color).toMatch(/^[0-9A-F]{6}$/);
      }

      // routes.route_color — R1's placeholder (#000000) was substituted
      // with the per-type modal; R2's FF0000 (the only non-placeholder)
      // was preserved. Both routes end up with a valid 6-char hex.
      const routeRows = db.prepare('SELECT route_id, route_color FROM routes ORDER BY route_id').all() as Array<{ route_id: string; route_color: string | null }>;
      for (const r of routeRows) {
        expect(r.route_color).not.toBe('000000');  // placeholder gone
        expect(r.route_color).toMatch(/^[0-9A-F]{6}$/);
      }

      // _neary_config rows — exactly the timing block.
      const cfgRows = db.prepare('SELECT key, value FROM _neary_config').all() as Array<{ key: string; value: string }>;
      expect(cfgRows).toEqual([
        { key: 'timing', value: JSON.stringify(TIMING_BLOCK) },
      ]);
    } finally {
      db.close();
    }
  });

  it('handles a feed with no timing config (empty _neary_config rows)', async () => {
    // Reset to a clean state (no prior run's UPDATEs).
    rmSync(WORK, { recursive: true, force: true });
    buildSyntheticSqlite();
    const ext = staticExtension({});
    expect((ext.tableExtensions?._neary_config?.rows?.length ?? 0)).toBe(0);

    const db = runExtension(ext);
    try {
      const cfgRows = db.prepare('SELECT COUNT(*) AS c FROM _neary_config').get() as { c: number };
      expect(cfgRows.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it('gz round-trip preserves content (smoke)', async () => {
    // Mimic the pipeline's last step: gzip the sqlite. Not strictly part
    // of the extension's contract but confirms nothing in the test broke
    // by accidentally holding the DB open or corrupting the file.
    const raw = readFileSyncCompat(SQLITE_PATH);
    const gz = gzipSync(raw);
    const decoded = gunzipSync(gz);
    expect(decoded.equals(raw)).toBe(true);
    expect(gz.length).toBeLessThan(raw.length);
    const hash = createHash('sha256').update(gz).digest('hex');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Tiny compat helper — the synthetic build is the only place that
// writes the .sqlite3; tests read it for assertions.
function readFileSyncCompat(p: string): Buffer {
  // Defer to node:fs.readFileSync via require to avoid yet another
  // top-level import. tsconfig.test.json already has node types.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync(p);
}
