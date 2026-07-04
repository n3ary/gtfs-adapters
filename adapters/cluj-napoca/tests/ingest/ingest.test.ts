// @ts-nocheck - matching the rest of the cluj adapter package.
// Tests for the programmatic ingestBuild entry added with the
// single-publisher R2 architecture (gtfs-adapters#@).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock Tranzy + Transitous + CTP so the test exercises only the
// orchestration in src/ingest/index.ts. The mocks use the existing
// fixture data via the seed-builder helper, so the produced zip is
// real (just synthesized sources, not live upstream fetches).
vi.mock('../../src/sources/tranzy/index.ts', () => ({
  TranzyClient: class {
    constructor(opts) {
      this.opts = opts;
    }
    async fetchAll() {
      // Map to the fixtures.tranzy shape the rest of the codebase
      // expects. Empty by default — drives the seed+CSV path.
      return {
        routes: [],
        stops: [],
        trips: [],
        shapes: [],
        stop_times: [],
        warnings: [],
      };
    }
  },
}));

vi.mock('../../src/sources/transitous/index.ts', async (importOriginal) => {
  const mod = await importOriginal();
  const { buildFixtureSeedMemory } = await import('../fixtures/seed-builder');
  const { seedPatternsByRouteDir } = mod;
  return {
    ...mod,
    loadTransitousSeed: async () => {
      // Use the real builder for patterns so reconcile() sees the same
      // shape a live fetch produces.
      const seed = buildFixtureSeedMemory();
      return {
        ...seed,
        patternsByRouteDir: seedPatternsByRouteDir(seed),
      };
    },
  };
});

vi.mock('../../src/sources/ctp-csv/index.ts', async (importOriginal) => {
  const mod = await importOriginal();
  const { fixtures } = await import('../fixtures/index');
  const { parseCtpCsv } = mod;

  return {
    fetchAllCsvSchedules: async (routes, opts) => {
      const byRouteService = new Map();
      for (const [shortName, bySvc] of Object.entries(fixtures.csv || {})) {
        const m = new Map();
        for (const [svcId, body] of Object.entries(bySvc)) {
          m.set(svcId, parseCtpCsv(body));
        }
        byRouteService.set(shortName, m);
      }
      return { byRouteService, warnings: [] };
    },
    readCtpCsvFromDisk: () => '',  // unused under mocked fetchAllCsvSchedules
    parseCtpCsv: mod.parseCtpCsv,
  };
});

import { ingestBuild } from '../../src/ingest/index';

const WORK = join(tmpdir(), `cluj-ingest-${Date.now()}`);

beforeAll(() => mkdirSync(WORK, { recursive: true }));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

describe('ingestBuild', () => {
  it('throws when tranzy.apiKey is missing', async () => {
    await expect(
      ingestBuild({
        outputDir: join(WORK, 'no-key'),
        tranzy: { apiKey: '', agencyId: '2' },
        transitous: {},
        ctp: { serviceKeys: ['lv', 's', 'd'] },
      }),
    ).rejects.toThrow(/tranzy\.apiKey is required/);
  });

  it('runs end-to-end with mocked sources, returning a Buffer containing a real gtfs.zip', async () => {
    const outDir = join(WORK, 'happy');
    const result = await ingestBuild({
      outputDir: outDir,
      outputName: 'fixture.gtfs.zip',
      tranzy: { apiKey: 'fake', agencyId: '2', rateLimitMs: 1 },
      transitous: {},
      ctp: { serviceKeys: ['lv', 's', 'd'] },
      calendarDays: 30,
      buildDate: new Date('2026-06-29T12:00:00Z'),
    });

    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.zipPath).toBe(join(outDir, 'fixture.gtfs.zip'));
    expect(existsSync(result.zipPath)).toBe(true);

    // The returned Buffer must match the on-disk file (same sha256).
    const fs = readFileSync(result.zipPath);
    expect(fs.equals(result.zip)).toBe(true);

    // PK signature check — verify zip magic bytes.
    expect(result.zip[0]).toBe(0x50); // 'P'
    expect(result.zip[1]).toBe(0x4b); // 'K'
  });
});
