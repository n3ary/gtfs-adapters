#!/usr/bin/env node
// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * One-off: dump the 35 URLs that returned 404 in the latest fetch-stage run,
 * so we can cross-reference with CTP's published schedule list and
 * figure out which are real catalog gaps vs transient issues.
 */
import { loadTransitousSeed } from '../src/sources/transitous/index.ts';
import { fetchCtpCsv } from '../src/sources/ctp-csv/index.ts';

const seed = await loadTransitousSeed({ url: 'https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip' });
const routes = seed.routes.map((r) => ({ shortName: r.shortName }));
const svcKeys = ['lv', 's', 'd'];
const notFound = [];
const concurrency = 8;

const tasks = [];
for (const route of routes) {
  for (const svc of svcKeys) {
    tasks.push({ route: route.shortName, svc });
  }
}

const queue = tasks.slice();
const workers = Array.from({ length: concurrency }, async () => {
  while (queue.length > 0) {
    const t = queue.shift();
    if (!t) break;
    const { buildCtpCsvUrl } = await import('../src/sources/ctp-csv/index.js');
    const url = buildCtpCsvUrl(t.route, t.svc);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://ctpcj.ro/index.php/ro/orare-linii/linii-urbane',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) {
        notFound.push({ route: t.route, svc: t.svc, url });
      }
    } catch (err) {
      // ignore
    }
  }
});
await Promise.all(workers);

console.log(`Found ${notFound.length} 404s:`);
console.log();
for (const x of notFound.sort((a, b) => a.route.localeCompare(b.route, 'ro') || a.svc.localeCompare(b.svc))) {
  console.log(`  ${x.route.padEnd(8)} ${x.svc.padEnd(3)} ${x.url}`);
}