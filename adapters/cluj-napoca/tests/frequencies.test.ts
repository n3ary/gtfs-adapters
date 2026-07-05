// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * M26 frequency-anchor test — locks in the v0.1 fix for `neary-gtfs#15`.
 *
 * M26's LV CSV has frequency annotations (`05:05-22:40` range + `10-20min`
 * headway) that the legacy `feeds/cluj-napoca/build.js` silently dropped.
 * After the fix, those annotations produce a `frequencies.txt` row plus
 * a "frequency anchor" trip in `trips.txt`.
 */

import { describe, it, expect } from 'vitest';

import { reconcile } from '../src/assemble/index.ts';
import { parseCtpCsv } from '../src/sources/ctp-csv/index.ts';
import { fixtures } from './fixtures/index.ts';
import { buildFixtureSeedMemory } from './fixtures/seed-builder.ts';

function buildCsvByRouteService() {
  const out = new Map();
  for (const [shortName, bySvc] of Object.entries(fixtures.csv)) {
    const m = new Map();
    for (const [svcId, body] of Object.entries(bySvc)) {
      const parsed = parseCtpCsv(body);
      m.set(svcId, parsed);
    }
    out.set(shortName, m);
  }
  return out;
}

describe('#15 — M26 frequency annotation fix', () => {
  const seed = buildFixtureSeedMemory();
  const csv = { byRouteService: buildCsvByRouteService(), warnings: [] };

  it('emits a frequencies.txt row for M26 dir0 LV', () => {
    const { files } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    expect(files['frequencies.txt']).toBeTruthy();
    expect(files['frequencies.txt']).toMatch(/^trip_id,/m);
    // Anchor for M26 dir=0 LV at 05:05 (start of operating window).
    expect(files['frequencies.txt']).toMatch(/M26_0_LV_FREQ_0505/);
    // Window: 05:05 to 22:40 (from the range annotation).
    expect(files['frequencies.txt']).toMatch(/M26_0_LV_FREQ_0505,05:05:00,22:40:00,900,0/);
  });

  it('emits a frequency anchor trip in trips.txt with the right pattern', () => {
    const { files } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    const tripLines = files['trips.txt'].split('\n').slice(1).filter(Boolean);
    const anchor = tripLines.find((l) => l.includes('M26_0_LV_FREQ_0505'));
    expect(anchor).toBeTruthy();
    // Anchor trip uses the seed pattern (M26 dir=0 → stops D, E).
    const stopTimeLines = files['stop_times.txt'].split('\n').slice(1).filter(Boolean);
    const anchorStopTimes = stopTimeLines.filter((l) => l.startsWith('M26_0_LV_FREQ_0505,'));
    expect(anchorStopTimes.length).toBe(2); // 2 stops in M26 pattern: D, E
    // First stop is the origin (D), at 05:05:00 (start of window).
    expect(anchorStopTimes[0]).toMatch(/^M26_0_LV_FREQ_0505,05:05:00,05:05:00,D,/);
  });

  it('does NOT emit a frequency anchor for routes with no annotations', () => {
    const { files, warnings } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    // 35 has no frequency annotations → no anchor
    expect(files['frequencies.txt']).not.toMatch(/^35_\d+_(LV|S|D|LD)_FREQ_/m);
  });

  it('logs the frequency anchor in build warnings', () => {
    const { warnings } = reconcile({ seed, tranzy: null, csv, options: { buildDate: new Date('2026-06-29') } });
    expect(warnings.some((w) => w.message.includes('frequency anchor') && w.message.includes('M26') && w.message.includes('dir=0'))).toBe(true);
  });
});

describe('classifyCell (frequency annotation classification)', () => {
  it('classifies HH:MM as time', async () => {
    const { classifyCell } = await import('../src/sources/ctp-csv/index.js');
    expect(classifyCell('06:30')).toEqual({ type: 'time', value: '06:30' });
  });

  it('classifies HH:MM-HH:MM as range', async () => {
    const { classifyCell } = await import('../src/sources/ctp-csv/index.js');
    expect(classifyCell('05:05-22:40')).toEqual({ type: 'range', start: '05:05', end: '22:40' });
  });

  it('classifies N-Mmin as headway range', async () => {
    const { classifyCell } = await import('../src/sources/ctp-csv/index.js');
    expect(classifyCell('10-20min')).toEqual({
      type: 'headway', minSec: 600, maxSec: 1200, avgSec: 900,
    });
  });

  it('classifies Nmin as single headway', async () => {
    const { classifyCell } = await import('../src/sources/ctp-csv/index.js');
    expect(classifyCell('5min')).toEqual({
      type: 'headway', minSec: 300, maxSec: null, avgSec: 300,
    });
  });

  it('returns unknown for unparseable cells', async () => {
    const { classifyCell } = await import('../src/sources/ctp-csv/index.js');
    expect(classifyCell('TODO')).toEqual({ type: 'unknown' });
    expect(classifyCell('05:30-')).toEqual({ type: 'unknown' });
    expect(classifyCell('12:00-13:00-14:00')).toEqual({ type: 'unknown' });
  });

  // CTP uses '*' / '**' as per-route annotations whose meaning is
  // documented on each line's HTML legend page (e.g. M23 = shared
  // run with M81/M22, M39 = extends past terminus / skips neighborhood).
  // classifyCell strips the asterisks and preserves them on the
  // returned object so the parser can log them without counting them
  // as unrecognized cells. The trip itself is KEPT in the schedule.
  it('strips leading asterisk and preserves annotation on time cells', async () => {
    const { classifyCell } = await import('../src/sources/ctp-csv/index.js');
    expect(classifyCell('*04:40')).toEqual({ type: 'time', value: '04:40', annotation: '*' });
  });

  it('strips trailing asterisk and preserves annotation on time cells', async () => {
    const { classifyCell } = await import('../src/sources/ctp-csv/index.js');
    expect(classifyCell('22:50*')).toEqual({ type: 'time', value: '22:50', annotation: '*' });
  });

  it('strips double trailing asterisk (M39 Cluj-Due-skip marker)', async () => {
    const { classifyCell } = await import('../src/sources/ctp-csv/index.js');
    expect(classifyCell('07:55**')).toEqual({ type: 'time', value: '07:55', annotation: '**' });
  });

  it('plain times do not get an annotation key', async () => {
    const { classifyCell } = await import('../src/sources/ctp-csv/index.js');
    // toEqual distinguishes present-but-undefined from absent, so this
    // verifies the existing HH:MM behavior is unchanged.
    expect(classifyCell('06:30')).toEqual({ type: 'time', value: '06:30' });
    expect('annotation' in classifyCell('06:30')).toBe(false);
  });
});