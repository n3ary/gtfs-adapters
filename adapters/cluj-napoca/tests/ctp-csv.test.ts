// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity.
import { describe, it, expect } from 'vitest';

import { parseCtpCsv, fetchCtpCsv, fetchAllCsvSchedules } from '../src/sources/ctp-csv/index.ts';
import { fixtures } from './fixtures/index.ts';

describe('parseCtpCsv', () => {
  it('parses a standard weekday CSV', () => {
    const result = parseCtpCsv(fixtures.csv['35'].LV);
    expect(result.routeLongName).toBe('Piata Garii - Cart. Zorilor');
    expect(result.inStopName).toBe('Piata Garii');
    expect(result.outStopName).toBe('Cart. Zorilor');
    expect(result.departures.dir0).toEqual(['06:00', '06:30']);
    expect(result.departures.dir1).toEqual(['06:30', '07:00']);
    expect(result.warnings).toHaveLength(0);
  });

  it('classifies range + headway cells into frequencyAnnotations (M26)', () => {
    const result = parseCtpCsv(fixtures.csv.M26.LV);
// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
    // dir0 column: range "05:05-22:40", headway "10-20min", time "05:41"
    // dir1 column: three individual times
    expect(result.departures.dir0).toEqual(['05:41']);
    expect(result.departures.dir1).toEqual(['05:23', '05:32', '05:50']);
    expect(result.frequencyAnnotations.dir0.ranges).toEqual([
      { start: '05:05', end: '22:40' },
    ]);
    expect(result.frequencyAnnotations.dir0.headways).toEqual([
      { minSec: 600, maxSec: 1200, avgSec: 900 },
    ]);
    // dir1 had no frequency annotations.
    expect(result.frequencyAnnotations.dir1.ranges).toEqual([]);
    expect(result.frequencyAnnotations.dir1.headways).toEqual([]);
    // No warnings — we classified, not dropped.
    expect(result.warnings).toEqual([]);
  });

  it('rewrites post-midnight times as HH+24', () => {
    const csv = `route_long_name,"x"
service_name,"x"
service_start,"x"
in_stop_name,"x"
out_stop_name,"x"
23:55,00:20
24:15,00:45
`;
    const result = parseCtpCsv(csv);
    expect(result.departures.dir0).toEqual(['23:55', '24:15']);
    expect(result.departures.dir1).toEqual(['24:20', '24:45']);
  });

  it('returns null on too-short input', () => {
    expect(parseCtpCsv('route_long_name,"x"\n')).toBeNull();
  });
});

describe('fetchCtpCsv', () => {
  it('substitutes placeholders and calls fetch', async () => {
    let called = null;
    const fetch = async (url, opts) => {
      called = { url: url.toString(), headers: opts.headers };
      return new Response(fixtures.csv['35'].LV, {
        status: 200,
        headers: { 'Content-Type': 'text/csv' },
      });
    };
    const result = await fetchCtpCsv('35', 'lv', { fetch });
    expect(result).not.toBeNull();
    expect(called.url).toContain('orar_35_lv.csv');
    // The fetch wrapper merges { ...WAF_HEADERS, 'User-Agent': USER_AGENT }.
    // USER_AGENT (the adapter's) wins for the User-Agent header; the WAF
    // headers (incl. a Chrome UA) are still sent as additional headers.
    expect(called.headers['User-Agent']).toMatch(/cluj-napoca-gtfs-adapter/);
  });

  it('returns null on 404 silently', async () => {
    const fetch = async () => new Response('', { status: 404 });
    const result = await fetchCtpCsv('M26', 'lv', { fetch });
    expect(result).toBeNull();
  });

  it('returns null on non-CSV body (WAF challenge page)', async () => {
    const fetch = async () => new Response('<html>captcha</html>', { status: 200 });
    const result = await fetchCtpCsv('35', 'lv', { fetch });
    expect(result).toBeNull();
  });
});

describe('fetchAllCsvSchedules', () => {
  it('fans out per (route, service) with bounded concurrency', async () => {
    let inflight = 0;
    let peak = 0;
    const fetch = async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return new Response(fixtures.csv['35'].LV, { status: 200 });
    };
    const { byRouteService, warnings } = await fetchAllCsvSchedules(
      [{ shortName: '35' }, { shortName: 'M26' }],
      {
        serviceKeys: ['lv', 's', 'd'],
        serviceIdMap: { lv: 'LV', s: 'S', d: 'D' },
        concurrency: 2,
        fetch,
      },
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(byRouteService.has('35')).toBe(true);
    // Only 35 fixtures are returned; M26 hits the CSV '35' by accident, but
    // that's fine for this concurrency test.
    expect(warnings).toBeDefined();
  });
});