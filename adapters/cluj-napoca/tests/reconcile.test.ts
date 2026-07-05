// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).

import { describe, it, expect } from 'vitest';

import { reconcile } from '../src/assemble/index.ts';
import { parseCtpCsv } from '../src/sources/ctp-csv/index.ts';
import { fixtures } from './fixtures/index.ts';
import { buildFixtureSeedMemory } from './fixtures/seed-builder.ts';

function buildCsvByRouteService() {
// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
  /** @type {Map<string, Map<string, any>>} */
  const out = new Map();
  for (const [shortName, bySvc] of Object.entries(fixtures.csv)) {
    const m = new Map();
    for (const [svcId, body] of Object.entries(bySvc)) {
      // Use the real parser so the structure matches what production produces
      // (incl. the frequencyAnnotations field).
      const parsed = parseCtpCsv(body);
      m.set(svcId, parsed);
    }
    out.set(shortName, m);
  }
  return out;
}

describe('reconcile', () => {
  const seed = buildFixtureSeedMemory();
  const csv = {
    byRouteService: buildCsvByRouteService(),
    warnings: [],
  };

  it('emits all required GTFS files', async () => {
    const { files } = await reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    expect(files['agency.txt']).toBeTruthy();
    expect(files['routes.txt']).toBeTruthy();
    expect(files['stops.txt']).toBeTruthy();
    expect(files['trips.txt']).toBeTruthy();
    expect(files['stop_times.txt']).toBeTruthy();
    expect(files['calendar.txt']).toBeTruthy();
    expect(files['feed_info.txt']).toBeTruthy();
  });

  it('emits agency.txt without trailing-blank rows (orchestrator CHECK + FK invariants)', async () => {
    // Regression for the daily-cron bug PR #84 surfaced: the seed
    // CSV ends with a trailing `\n`, so `seed.agencyTxt.split('\n')`
    // yielded an empty string as the last element. The pre-fix
    // ensureAgencyTimezone() processed that empty line by padding
    // it up to `header.length` columns and overwriting the timezone
    // column — producing a row like `,,,Europe/Bucharest,,,`. That
    // row had empty agency_id (PK violation) and empty agency_name
    // (NOT NULL violation) under the new spec DDL constraints. Before
    // the constraints, INSERT OR IGNORE silently dropped it.
    const { files } = await reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    const lines = files['agency.txt']!.split('\n').filter((l) => l.trim().length > 0);
    // 1 header + ≥1 data row, NO empty trailing row.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Every data row must have a non-empty agency_name (column 1).
    for (const line of lines.slice(1)) {
      const cols = line.split(',');
      expect(cols[1], `row has empty agency_name: ${JSON.stringify(line)}`).toBeTruthy();
      expect(cols[1].length).toBeGreaterThan(0);
    }
  });

  it('route 22 from Tranzy (orange, neary-gtfs#14) is included with its Tranzy color', async () => {
    // Non-black Tranzy colors are passed through unchanged; only black /
    // missing values get substituted with the per-type modal color.
    const { files } = await reconcile({ seed, tranzy: fixtures.tranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    const routesLines = files['routes.txt'].split('\n');
    const r22 = routesLines.find((l) => l.startsWith('22,'));
    expect(r22).toBeTruthy();
    expect(r22).toMatch(/EF8732/);
  });

  it('M26 direction=1 is resolvable via Tranzy fallback (fixes #15)', async () => {
    const { warnings } = await reconcile({ seed, tranzy: fixtures.tranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    // We should NOT have a warning about M26 dir=1 having no pattern.
    const has = warnings.some((w) => w.message.includes('M26') && w.message.includes('dir=1') && w.message.includes('No pattern'));
    expect(has).toBe(false);
  });

  it('generates trip_ids in ${route}_${dir}_${serviceId}_${HHMM} format', async () => {
    const { files } = await reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    const tripLines = files['trips.txt'].split('\n').slice(1).filter(Boolean);
    expect(tripLines.length).toBeGreaterThan(0);
    const tripIdRe = /^[A-Za-z0-9]+_[01]_(LV|S|D|LD)(?:_FREQ)?_\d{4}$/;
    for (const line of tripLines) {
      const cols = line.split(',');
      // trips.txt is now spec-driven: trip_id is the first column
      // (canonical GTFS order). The old hand-rolled writer emitted
      // `route_id, service_id, trip_id, ...` which was non-canonical
      // and made this assertion silently wrong — the spec-driven
      // serializer fixed that drift surface for free.
      const tripId = cols[0];
      // Format options:
      //   <route>_<dir>_<serviceId>_<HHMM>          (regular trip)
      //   <route>_<dir>_<serviceId>_FREQ_<HHMM>     (frequency anchor)
      // route may contain letters (M26, 25N). HHMM is the tail
      // (4 digits, no colon) — required for neary's parseLiveStartMin
      // fallback. We do NOT claim parity with the live RT feed's IDs;
      // the reconciler matches by (route, direction, time).
      expect(tripId).toMatch(tripIdRe);
      // Sanity: trip_id ends in 4 digits (HHMM tail).
      expect(tripId).toMatch(/_\d{4}$/);
    }
  });

  it('stop_times arrivals are monotonically non-decreasing within each trip', async () => {
    const { files } = await reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    const lines = files['stop_times.txt'].split('\n').slice(1).filter(Boolean);
    /** @type {Map<string, number[]>} */
    const byTrip = new Map();
    for (const line of lines) {
      const cols = line.split(',');
      const tripId = cols[0];
      const arrSec = hhmmssToSeconds(cols[1]);
      if (!byTrip.has(tripId)) byTrip.set(tripId, []);
      byTrip.get(tripId).push(arrSec);
    }
    for (const arr of byTrip.values()) {
      for (let i = 1; i < arr.length; i++) {
        expect(arr[i]).toBeGreaterThanOrEqual(arr[i - 1]);
      }
    }
  });

  it('stop_times preserves stop_sequence from the upstream pattern (seed or Tranzy)', async () => {
    // Seed fixture has sequences 0, 1, 2 for route 35 dir=0 trips
    // (stops A, B, C). The reconciler must inherit those numbers,
    // not re-number with a fresh sequential index — re-numbering would
    // discard any non-contiguous numbering the operator uses.
    const { files } = await reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    const lines = files['stop_times.txt'].split('\n').slice(1).filter(Boolean);
    /** @type {Map<string, Array<{stopId: string, sequence: number}>>} */
    const byTrip = new Map();
    for (const line of lines) {
      const cols = line.split(',');
      const tripId = cols[0];
      const seq = Number(cols[4]);
      const stopId = cols[3];
      if (!byTrip.has(tripId)) byTrip.set(tripId, []);
      byTrip.get(tripId).push({ stopId, sequence: seq });
    }
    // For trip 35_0_LV_0600 (35 dir=0 LV service at 06:00), the stops
    // are A, B, C with sequences 0, 1, 2 from the seed.
    const trip0600 = byTrip.get('35_0_LV_0600');
    expect(trip0600).toBeDefined();
    const seqByStop = Object.fromEntries(trip0600.map((s) => [s.stopId, s.sequence]));
    expect(seqByStop.A).toBe(0);
    expect(seqByStop.B).toBe(1);
    expect(seqByStop.C).toBe(2);
  });

  it('calendar.txt has LV, S, D entries (services we actually scraped)', async () => {
    const { files } = await reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    expect(files['calendar.txt']).toMatch(/^LV,/m);
    expect(files['calendar.txt']).toMatch(/^S,/m);
    expect(files['calendar.txt']).toMatch(/^D,/m);
  });

  it('drops phantom routes (Tranzy catalog entry but no trips anywhere) with a WARN', async () => {
    // Synthetic Tranzy response that lists route 999 ("Phantom") in /routes
    // but provides no /trips or /stop_times for it — mirrors the live
    // behavior observed for route_id=117 (short_name="2") and
    // route_id=73 (short_name="M35") where Tranzy catalogs the route but
    // carries no trip data. The phantom-route filter in
    // `src/assemble/index.js` should drop these with a WARN.
    const phantomTranzy = {
      routes: [
        { route_id: '999', agency_id: 2, route_short_name: 'Phantom', route_long_name: 'Phantom Route', route_type: 3 },
      ],
      stops: [],
      trips: [],
      stop_times: [],
      shapes: [],
      calendar: [],
    };
    const { files, warnings } = await reconcile({ seed, tranzy: phantomTranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    const routesLines = files['routes.txt'].split('\n').slice(1).filter(Boolean);
    expect(routesLines.find((l) => l.startsWith('999,'))).toBeUndefined();
    const phantomWarn = warnings.find((w) => w.message.includes('phantom route'));
    expect(phantomWarn).toBeDefined();
    expect(phantomWarn.severity).toBe('warn');
    expect(phantomWarn.message).toContain('Phantom');
    expect(phantomWarn.message).toContain('route_id=999');
  });

  it('keeps routes that have ONLY Tranzy fallback trips (no CSV)', async () => {
    // Mirror real Tranzy-fallback behavior: a route with no CSV coverage
    // but with /trips + /stop_times in Tranzy data should still produce
    // _NTxxx synthetic trip rows and survive the phantom filter.
    const fallbackTranzy = {
      routes: [
        { route_id: '888', agency_id: 2, route_short_name: 'M99', route_long_name: 'M99 Metroline', route_type: 3 },
      ],
      stops: [],
      trips: [
        { trip_id: 'tranzy-M99-fwd', route_id: '888', direction_id: 0, trip_headsign: 'M99' },
      ],
      stop_times: [
        { trip_id: 'tranzy-M99-fwd', stop_id: 'A', stop_sequence: 0 },
        { trip_id: 'tranzy-M99-fwd', stop_id: 'B', stop_sequence: 1 },
      ],
      shapes: [],
      calendar: [],
    };
    const { files, warnings } = await reconcile({ seed, tranzy: fallbackTranzy, csv, options: { buildDate: new Date('2026-06-29') } });
    const routesLines = files['routes.txt'].split('\n').slice(1).filter(Boolean);
    expect(routesLines.find((l) => l.startsWith('888,'))).toBeDefined();
    const phantomWarn = warnings.find((w) => w.message.includes('phantom route'));
    expect(phantomWarn).toBeUndefined();
    // And the Tranzy fallback warning should be present.
    expect(warnings.some((w) => w.message.includes('Tranzy /trips fallback'))).toBe(true);
  });

  it('emits networks.txt + route_networks.txt with category-classified routes (neary#125, neary#129)', async () => {
    // Synthesize a Tranzy response with one route per category so we can
    // pin the file shape end-to-end without depending on the live catalog.
    const tranzy = {
      routes: [
        { route_id: '93',  route_short_name: 'TE1',  route_long_name: 'Transport Elevi Manastur',             route_type: 3 },
        { route_id: '145', route_short_name: 'M76A', route_long_name: 'TE2 Floresti str. Somesului',          route_type: 3 },
        { route_id: '68',  route_short_name: 'M26U', route_long_name: 'Uzinei Electrice - Floresti / Cetate (untold)', route_type: 3 },
        { route_id: '15',  route_short_name: '25N',  route_long_name: 'Str. Bucium - Str. Unirii',            route_type: 11 },
        { route_id: '205', route_short_name: 'CS',   route_long_name: 'CURSA SPECIALA',                       route_type: 3 },
        // Regular urban — no category, should NOT appear in route_networks.txt.
        { route_id: '1',   route_short_name: '1',    route_long_name: 'Str. Bucium - P-ta 1 Mai',             route_type: 3 },
      ],
      stops: [],
      trips: [
        { trip_id: 't-93',  route_id: '93',  direction_id: 0, trip_headsign: '' },
        { trip_id: 't-145', route_id: '145', direction_id: 0, trip_headsign: '' },
        { trip_id: 't-68',  route_id: '68',  direction_id: 0, trip_headsign: '' },
        { trip_id: 't-15',  route_id: '15',  direction_id: 0, trip_headsign: '' },
        { trip_id: 't-205', route_id: '205', direction_id: 0, trip_headsign: '' },
        { trip_id: 't-1',   route_id: '1',   direction_id: 0, trip_headsign: '' },
      ],
      stop_times: [
        { trip_id: 't-93',  stop_id: 'A', stop_sequence: 0 },
        { trip_id: 't-145', stop_id: 'A', stop_sequence: 0 },
        { trip_id: 't-68',  stop_id: 'A', stop_sequence: 0 },
        { trip_id: 't-15',  stop_id: 'A', stop_sequence: 0 },
        { trip_id: 't-205', stop_id: 'A', stop_sequence: 0 },
        { trip_id: 't-1',   stop_id: 'A', stop_sequence: 0 },
      ],
      shapes: [],
      calendar: [],
    };
    const { files } = await reconcile({ seed: buildFixtureSeedMemory(), tranzy, csv, options: { buildDate: new Date('2026-06-29') } });

    // The seed ships with route M26 (Piata Garii - Selimbar) which
    // classifies as metroline. So networks.txt also gets a metroline
    // row from the seed — pin both seed-derived and Tranzy-derived
    // categories here.
    expect(files['networks.txt']).toBe(
      'network_id,network_name\n' +
      'special,Cursa Speciala\n' +
      'school,Transport Elevi\n' +
      'festival,Untold\n' +
      'night,Noapte\n' +
      'metroline,Metropolitan\n',
    );

    // route_networks.txt — one row per categorized route. M76A (route_id 145)
    // is now BOTH school AND metroline (long_name "TE2 Floresti" matches the
    // school TE-prefix check we re-added). M26U (route_id 68) still has
    // 1:many via Untold + M* prefix. Regular urban route 1 excluded;
    // M26 (seed) included as metroline.
    const rnLines = files['route_networks.txt'].trim().split('\n');
    expect(rnLines[0]).toBe('network_id,route_id');
    expect(rnLines).toContain('school,93');
    expect(rnLines).toContain('school,145'); // M76A is BOTH school + metroline
    expect(rnLines).toContain('metroline,145');
    expect(rnLines).toContain('festival,68');
    expect(rnLines).toContain('metroline,68'); // M26U also metroline
    expect(rnLines).toContain('night,15');
    expect(rnLines).toContain('special,205');
    expect(rnLines).toContain('metroline,M26');
    expect(rnLines).not.toContainEqual(expect.stringMatching(/^[^,]*,1$/));

    // routes.txt — route_desc carries the human label(s) comma-separated
    // for 1:many, route_long_name is in start-end format (or empty for CS).
    const routesTxt = files['routes.txt'];
    const r93row = routesTxt.split('\n').find((l) => l.startsWith('93,'));
    expect(r93row).toMatch(/,Manastur,Transport Elevi,/);
    const r145row = routesTxt.split('\n').find((l) => l.startsWith('145,'));
    // M76A: "TE2 Floresti " stripped → "str. Somesului". route_desc is
    // now "Transport Elevi, Metropolitan" (1:many via TE prefix in
    // long_name + M* prefix in short_name). CSV writer quotes the field
    // because it contains a comma.
    expect(r145row).toMatch(/,str\. Somesului,"Transport Elevi, Metropolitan",/);
    const r68row = routesTxt.split('\n').find((l) => l.startsWith('68,'));
    // Trailing "(untold)" stripped from long_name. M26U is also
    // metroline (M* prefix) → route_desc carries both labels.
    expect(r68row).toMatch(/,Uzinei Electrice - Floresti \/ Cetate,(?:"Untold, Metropolitan"|Untold, Metropolitan),/);
    const r15row = routesTxt.split('\n').find((l) => l.startsWith('15,'));
    expect(r15row).toMatch(/,Str\. Bucium - Str\. Unirii,Noapte,/);
    const r205row = routesTxt.split('\n').find((l) => l.startsWith('205,'));
    // CS long_name cleared, route_desc = "Cursa Speciala"
    expect(r205row).toMatch(/,CS,,Cursa Speciala,/);
    // Regular urban: empty route_desc. The field after the destination
    // string is route_desc — index 4 (0=route_id, 1=agency_id,
    // 2=route_short_name, 3=route_long_name, 4=route_desc).
    const r1row = routesTxt.split('\n').find((l) => l.startsWith('1,'));
    expect(r1row.split(',')[4]).toBe('');
  });

  it('derives route_long_name from stop_times when cleanup leaves it empty', async () => {
    // Synthesize a route whose Tranzy long_name is just an annotation
    // (no start/end). After cleanup → empty. The orchestrator should
    // fall back to "<first stop> - <last stop>" from stop_times.
    const tranzy = {
      routes: [
        { route_id: '777', route_short_name: '88X', route_long_name: '(untold)', route_type: 3 },
      ],
      stops: [],
      trips: [
        { trip_id: 't-777-a', route_id: '777', direction_id: 0, trip_headsign: '' },
        { trip_id: 't-777-b', route_id: '777', direction_id: 0, trip_headsign: '' },
      ],
      stop_times: [
        // Trip A: short version (3 stops)
        { trip_id: 't-777-a', stop_id: 'A', stop_sequence: 0 },
        { trip_id: 't-777-a', stop_id: 'B', stop_sequence: 1 },
        { trip_id: 't-777-a', stop_id: 'C', stop_sequence: 2 },
        // Trip B: long version (5 stops) — should win as the canonical variant
        { trip_id: 't-777-b', stop_id: 'A', stop_sequence: 0 },
        { trip_id: 't-777-b', stop_id: 'B', stop_sequence: 1 },
        { trip_id: 't-777-b', stop_id: 'C', stop_sequence: 2 },
        { trip_id: 't-777-b', stop_id: 'D', stop_sequence: 3 },
        { trip_id: 't-777-b', stop_id: 'E', stop_sequence: 4 },
      ],
      shapes: [],
      calendar: [],
    };
    const { files, warnings } = await reconcile({
      seed: buildFixtureSeedMemory(), tranzy, csv, options: { buildDate: new Date('2026-06-29') },
    });

    const routesTxt = files['routes.txt'];
    const r777row = routesTxt.split('\n').find((l) => l.startsWith('777,'));
    // "(untold)" got stripped to empty → fallback to longest trip's
    // first/last stops: A=Piata Garii, E=Selimbar
    expect(r777row).toMatch(/,Piata Garii - Selimbar,/);

    // Build log surfaces the derived count. New format mentions "desc or
    // stops fallback" so the assertion key changes.
    const info = warnings.find((w) => w.severity === 'info' && w.message.includes('derived'));
    expect(info).toBeDefined();
    expect(info.message).toMatch(/derived 1 long_name\(s\)/);

    // Route 777 still classifies as festival (via "untold" in route_desc
    // which Tranzy provides on `(untold)`-style annotations? No — route_desc
    // is empty for this synthetic row, but the cleaned long_name still
    // doesn't contain "untold" post-strip. The classification uses the
    // cleaned long_name. So route 777 falls through to regular urban.
    // The point of this test is the fallback, not the classification.
  });
});

function hhmmssToSeconds(hms) {
  const parts = hms.split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}