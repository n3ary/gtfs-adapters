/**
 * Regression test for the daily-cron column-shift bug (Jul 5 2026).
 *
 * History: stopsToTxt emitted values shifted by one column, leaving
 * the actual `stop_lat` column empty. Consumers reading stops.txt by
 * header name (e.g. n3ary/gtfs-publisher deriveBbox) saw all stops as
 * having empty coordinates → daily cron FAILED with
 *   "no stops with valid coordinates"
 *
 * This test parses the emitted CSV by header name and asserts that
 * `stop_lat` / `stop_lon` carry numeric values. If stopsToTxt ever
 * drifts from canonical GTFS column order again, this test fails
 * loudly.
 */

import { describe, it, expect } from 'vitest';
import { reconcileStops, stopsToTxt } from '../src/assemble/merge/stops.ts';

// Minimal GTFS-CSV parser mirroring the orchestrator's
// packages/gtfs-static/src/lib/csv.ts behaviour (first non-empty
// line is the header; values keyed by header name). Inlined here
// because the adapter doesn't depend on the orchestrator's csv util
// — duplicating ~25 lines is cheaper than a workspace dep.
function parseCsv(text: string) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim().length === 0) i++;
  if (i >= lines.length) return [];
  const header = (lines[i] ?? '').split(',');
  const out: Record<string, string>[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const rawLine = lines[j] ?? '';
    if (rawLine.length === 0) continue;
    const cols = rawLine.split(',');
    const row: Record<string, string> = {};
    for (let k = 0; k < header.length; k++) row[header[k] ?? ''] = cols[k] ?? '';
    out.push(row);
  }
  return out;
}

describe('stopsToTxt (regression: daily-cron column-shift bug)', () => {
  it('emits stops.txt with stop_lat/stop_lon in their canonical columns', () => {
    // Minimal fixture: 2 Transitous stops + 1 Tranzy stop. All have
    // valid coordinates. The reconcile is identity-ish for this test
    // (we just want stopsToTxt output to be parseable by header).
    const seed = {
      stops: [
        { stopId: 'S1', name: 'Alpha', lat: 46.77, lon: 23.59 },
        { stopId: 'S2', name: 'Beta', lat: 46.78, lon: 23.60 },
      ],
    };
    const tranzy = {
      stops: [
        { stop_id: 'T1', stop_name: 'Gamma', stop_lat: '46.80', stop_lon: '23.62', location_type: '0' },
      ],
    };

    const { stops } = reconcileStops({ seed, tranzy, warnings: [] });
    const txt = stopsToTxt(stops);

    // Parse by header — this is what deriveBbox() does in production.
    const rows = parseCsv(txt);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // The bug surfaced here: with the old column shift, parseCsv
      // mapped row.stop_lat to the wrong (empty) column and
      // row.stop_lon to the value that was supposed to be
      // stop_lat. Both numeric coords must be on their correctly-named
      // columns, otherwise the orchestrator's bbox derivation dies.
      const lat = parseFloat(row.stop_lat ?? '');
      const lon = parseFloat(row.stop_lon ?? '');
      expect(Number.isFinite(lat), `row.stop_lat empty/invalid for ${row.stop_id}: ${row.stop_lat}`).toBe(true);
      expect(Number.isFinite(lon), `row.stop_lon empty/invalid for ${row.stop_id}: ${row.stop_lon}`).toBe(true);
      expect(lat, `row.stop_lat is 0 (null-island sentinel) for ${row.stop_id}`).not.toBe(0);
      expect(lon, `row.stop_lon is 0 (null-island sentinel) for ${row.stop_id}`).not.toBe(0);
    }

    // Also assert the header order — spec says canonical GTFS order.
    const headerLine = txt.split('\n')[0];
    const headers = headerLine.split(',');
    expect(headers).toContain('stop_id');
    expect(headers).toContain('stop_name');
    // stop_lat MUST come before stop_lon in the header.
    expect(headers.indexOf('stop_lat')).toBeLessThan(headers.indexOf('stop_lon'));
  });
});