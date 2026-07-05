// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * CTP CSV fetcher — network + disk read paths.
 *
 * Two read paths:
 *   - `fetchCtpCsv` — fetches from CTP upstream (reconcile dev)
 *   - `readCtpCsvFromDisk` — reads from `.build-input/csv/` (build)
 *
 * Both return `CtpCsvSchedule | null` (or throw on operator errors,
 * see each function's doc).
 *
 * Multi-fetch orchestrator (`fetchAllCsvSchedules`) accepts a `loadFn`
 * so callers can mix-and-match data sources.
 */

import { USER_AGENT } from '../../lib/seed.ts';
import { warnMsg } from '../../lib/log-severity.ts';
import { readCsvBody, readStatusManifest } from '../../lib/build-input.ts';
import { TRANZY_TO_CTP_SHORTNAME, canonicalShortName } from './shortname-aliases.ts';
import { parseCtpCsv } from './parser.ts';

export { parseCtpCsv, classifyCell } from './parser.ts';
export { TRANZY_TO_CTP_SHORTNAME, canonicalShortName } from './shortname-aliases.ts';

const DEFAULT_BASE_URL = 'https://ctpcj.ro/orare/csv/orar_{routeShortName}_{serviceId}.csv';

/**
 * Normalize a route_short_name for CTP's CSV URL path.
 *
 * CTP's URL convention strips whitespace from route_short_name:
 *   - `39 CREIC` (the Transitous route_short_name with a space)
 *     becomes `39CREIC` (no space) → URL `orar_39CREIC_lv.csv`
 *   - URL-encoded form `orar_39%20CREIC_lv.csv` returns 404 even
 *     when CTP has published the CSV — verified by hitting both
 *     endpoints: the no-space form returns the actual route_long_name
 *     header, the URL-encoded form returns 404.
 *
 * Exposed as a separate helper for completeness, but most callers
 * should reach for {@link canonicalShortName} instead — it composes
 * this helper with the {@link TRANZY_TO_CTP_SHORTNAME} alias map
 * so both rules apply in one call.
 *
 * @param {string} routeShortName
 * @returns {string}
 */
export function normalizeShortNameForCtpUrl(routeShortName) {
  return routeShortName.replace(/\s+/g, '');
}

/**
 * Build the canonical CTP CSV URL for a (route_short_name, service_id)
 * pair. Single source of truth — the fetch-stage script and the
 * inspect-404s diagnostic both use this so URL-convention changes
 * only need to land in one place.
 *
 * Calls {@link canonicalShortName} for the catalog→CTP alias map
 * (e.g. `39C` → `39CREIC`) and whitespace normalization. That helper
 * is the single place those rules live; everything else that touches
 * a CSV-IO identifier (csvPath, byRouteService key, route lookup)
 * funnels through it too.
 *
 * @param {string} routeShortName
 * @param {string} serviceKey  'lv' | 's' | 'd' (or 'ld')
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function buildCtpCsvUrl(routeShortName, serviceKey, baseUrl = DEFAULT_BASE_URL) {
  // canonicalShortName applies the Tranzy→CTP alias map and strips
  // whitespace — same rules every other CSV-IO path uses. Keeping it
  // here means the URL convention lives in exactly one place.
  const urlShortName = canonicalShortName(routeShortName);
  return baseUrl
    .replace('{routeShortName}', encodeURIComponent(urlShortName))
    .replace('{serviceId}', encodeURIComponent(serviceKey));
}

// ctpcj.ro's WAF treats default Node fetch headers as suspicious.
// These are the minimal set that produces clean CSV responses.
// (Verified 2026-06-29.)
const WAF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://ctpcj.ro/index.php/ro/orare-linii/linii-urbane',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

const DEFAULT_SERVICE_KEYS = ['lv', 's', 'd'];
const DEFAULT_SERVICE_ID_MAP = { lv: 'LV', s: 'S', d: 'D' };

/**
 * Fetch + parse one CSV from upstream CTP.
 *
 * The build pipeline NEVER calls this — the build command reads
 * pre-fetched CSVs from `.build-input/` via {@link readCtpCsvFromDisk}.
 * This function exists for the `reconcile` (dry-run) command and any
 * other dev workflow that wants live data without running smoke first.
 *
 * Failure modes (all soft — return null, downstream uses Tranzy
 * fallback):
 *   - network error / timeout
 *   - 404 (CTP doesn't publish this CSV — legit catalog gap)
 *   - other 4xx/5xx (server-side issue, worth surfacing)
 *   - 200 OK but body isn't CSV (WAF challenge page)
 *
 * @param {string} routeShortName
 * @param {string} serviceKey
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {typeof fetch} [opts.fetch]
 * @returns {Promise<CtpCsvSchedule | null>}
 */
export async function fetchCtpCsv(routeShortName, serviceKey, opts = {}) {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  // URL construction handles both the Tranzy→CTP alias map
  // (e.g. `39C` → `39CREIC`) and the whitespace normalization
  // (`39 CREIC` → `39CREIC`). See {@link buildCtpCsvUrl} for details.
  const url = buildCtpCsvUrl(routeShortName, serviceKey, baseUrl);
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { ...WAF_HEADERS, 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.warn(`[ctp-csv] ${routeShortName}_${serviceKey}: ${err.message || err}`);
    return null;
  }
  if (!res.ok) {
    if (res.status !== 404) console.warn(`[ctp-csv] ${routeShortName}_${serviceKey}: HTTP ${res.status}`);
    return null;
  }
  const body = await res.text();
  // Sanity check: real CSV always starts with "route_long_name,". Anything
  // else (WAF challenge page, captcha HTML, etc.) is a soft failure.
  // During heavy WAF incidents this can fire for hundreds of fetches
  // per build — log the first 3 unique body signatures, then dedup.
  // The full per-category counts end up in the smoke summary.
  if (!body.startsWith('route_long_name,')) {
    wafWarnDedup(routeShortName, serviceKey, body);
    return null;
  }
  return parseCtpCsv(body);
}

/**
 * Read + parse one CSV from the `.build-input/` directory populated
 * by a prior smoke run.
 *
 * Used by the build command. Throws if the manifest is missing —
 * that's an operator error (smoke wasn't run), not a catalog gap.
 * Returns null only for legit 404 entries that smoke recorded.
 *
 * @param {string} routeShortName
 * @param {string} serviceKey
 * @returns {CtpCsvSchedule | null}
 */
export function readCtpCsvFromDisk(routeShortName, serviceKey) {
  const manifest = readStatusManifest();
  if (!manifest) {
    throw new Error(
      `[ctp-csv] .build-input/csv-status.json not found. ` +
      `Run scripts/fetch-stage.js first to populate the build-input directory.`,
    );
  }
  const entry = manifest.entries.find((e) => e.route === routeShortName && e.svc === serviceKey);
  if (!entry) {
    throw new Error(
      `[ctp-csv] ${routeShortName}_${serviceKey} not found in smoke manifest. ` +
      `Smoke may have run against a different route list — re-run it.`,
    );
  }
  if (entry.status !== 'ok') {
    // 404 / WAF / HTTP / network — smoke would have failed loud on
    // infra, so reaching here implies a legit catalog gap (status=not-found).
    // Return null and let downstream use Tranzy fallback.
    return null;
  }
  const body = readCsvBody(routeShortName, serviceKey);
  if (body == null) {
    throw new Error(
      `[ctp-csv] ${routeShortName}_${serviceKey} marked ok in manifest but body file is missing. ` +
      `Re-run smoke.`,
    );
  }
  return parseCtpCsv(body);
}

/**
 * Module-level dedup for WAF warnings. When CTP blocks us with a
 * challenge page, every fetchCtpCsv call would otherwise spam the
 * same `<!DOCTYPE html> ...` warning line. We log the first 3 unique
 * body signatures and emit a single "and N more" line at the end.
 */
const _wafSeen = new Set();
let _wafLogged = 0;
let _wafTotal = 0;
function wafWarnDedup(shortName, svcKey, body) {
  _wafTotal++;
  const sig = `${body.length}:${body.slice(0, 60).replace(/\s+/g, ' ')}`;
  if (_wafSeen.has(sig)) {
    // Already logged this signature — silent (counted in summary).
    return;
  }
  _wafSeen.add(sig);
  if (_wafLogged < 3) {
    console.warn(`[ctp-csv] ${shortName}_${svcKey}: not CSV (got ${body.length}B starting "${body.slice(0, 40).replace(/\s+/g, ' ')}…")`);
    _wafLogged++;
    if (_wafLogged === 3 && _wafTotal > 3) {
      console.warn(`[ctp-csv] (further WAF/non-CSV responses suppressed — full breakdown in smoke summary)`);
    }
  }
  // Once we've logged 3 unique sigs + the suppression notice, the
  // dedup map just keeps counting silently.
}

/**
 * Load all (route, service) CSVs in parallel with bounded concurrency.
 *
 * The `loadFn` parameter selects the data source:
 *   - default `fetchCtpCsv` — fetches from CTP upstream (reconcile dev)
 *   - `readCtpCsvFromDisk` — reads from .build-input/csv/ (build)
 *
 * The loadFn can be sync or async; this function awaits both via
 * Promise.resolve().
 *
 * @param {Array<{shortName: string}>} routes
 * @param {object} [opts]
 * @param {(shortName: string, svcKey: string, opts: object) => any} [opts.loadFn]
 * @param {string[]} [opts.serviceKeys]
 * @param {Record<string, string>} [opts.serviceIdMap]
 * @param {number} [opts.concurrency]
 */
export async function fetchAllCsvSchedules(routes, opts = {}) {
  const serviceKeys = opts.serviceKeys ?? DEFAULT_SERVICE_KEYS;
  const serviceIdMap = opts.serviceIdMap ?? DEFAULT_SERVICE_ID_MAP;
  const concurrency = opts.concurrency ?? 4;
  const loadFn = opts.loadFn ?? fetchCtpCsv;

  /** @type {Array<() => Promise<void>>} */
  const tasks = [];
  /** @type {Map<string, Map<string, CtpCsvSchedule>>} */
  const byRouteService = new Map();
  /** @type {string[]} */
  const warnings = [];

  for (const route of routes) {
    for (const svcKey of serviceKeys) {
      // Canonicalize the shortName here so the byRouteService map key,
      // the CSV-IO call, and the warning text all agree on one name.
      // Callers can pass either catalog-side name (`39C` from Tranzy,
      // `39 CREIC` from Transitous) — both resolve to `39CREIC`.
      const shortName = canonicalShortName(route.shortName);
      const serviceId = serviceIdMap[svcKey] ?? svcKey.toUpperCase();
      // Wrap in a function so the load only starts when the worker dequeues
      // it — otherwise all tasks would kick off concurrently before the
      // concurrency cap could bite.
      tasks.push(async () => {
        const parsed = await Promise.resolve(loadFn(shortName, svcKey, opts));
        if (!parsed) {
          warnings.push(warnMsg(`CSV missing: ${shortName}_${svcKey}`));
          return;
        }
        if (!byRouteService.has(shortName)) byRouteService.set(shortName, new Map());
        byRouteService.get(shortName).set(serviceId, parsed);
      });
    }
  }

  // Bounded-concurrency runner.
  const queue = tasks.slice();
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (task) await task();
      }
    },
  );
  await Promise.all(workers);

  return { byRouteService, warnings };
}

export const CSV_BASE_URL = DEFAULT_BASE_URL;
export const CSV_SERVICE_KEYS = DEFAULT_SERVICE_KEYS;
export const CSV_SERVICE_ID_MAP = DEFAULT_SERVICE_ID_MAP;