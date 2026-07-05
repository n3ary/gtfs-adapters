// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Seed loader — takes a Transitous GTFS .zip (URL or local path),
 * extracts to a temp dir, parses the standard GTFS .txt files into
 * the in-memory shapes the reconciliation pipeline consumes.
 *
 * Vendored from ciotlosm/neary-gtfs (feeds/cluj-napoca/lib/seed.js +
 * src/pipeline/lib/http.js) on 2026-06-29. The original was coupled
 * to neary-gtfs's pipeline URL contract (NEARY_SEED_ZIP env var);
 * this version takes the source explicitly so it can be reused from
 * the build orchestrator or tests.
 *
 * Upstream copy: https://github.com/ciotlosm/neary-gtfs
 * Original copyright: MIT, Marius Ciotlos
 *
 * The CSV parsing used to live in src/lib/csv.js (a 54-line hand-rolled
 * GTFS-CSV reader). Now uses @n3ary/gtfs-spec's parseRoutes/parseStops/
 * parseTrips/parseStopTimes/parseShapes — same behaviour, but the spec
 * owns the column names + row types. The local csv.js is deleted.
 */

import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { parseRoutes, parseStops, parseTrips, parseStopTimesStream, parseShapesStream } from '@n3ary/gtfs-spec/spec';

const REQUIRED = ['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt'];
const OPTIONAL = ['shapes.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt'];

export const USER_AGENT = 'cluj-napoca-gtfs-adapter/0.3.3 (https://github.com/n3ary/gtfs-adapters/tree/main/adapters/cluj-napoca)';

/**
 * @param {string} source  absolute file path OR http(s) URL
 * @param {object} [opts]
 * @param {string} [opts.userAgent]  override the default UA for this fetch
 * @returns {Promise<{
 *   seedDir: string,
 *   agencyTxt: string,
 *   routes: Array<{routeId, shortName, longName, type, color, textColor}>,
 *   stops: Array<{stopId, name, lat, lon}>,
 *   trips: Array<{tripId, routeId, directionId, headsign, shapeId, serviceId}>,
 *   stopTimes: Map<string, Array<{stopId, sequence}>>,
 *   shapesById: Map<string, Array<{lat, lon, seq}>>,
 *   optional: string[],
 * }>}
 */
export async function loadSeed(source, opts = {}) {
  const seedDir = mkdtempSync(join(tmpdir(), 'cluj-napoca-seed-'));
  const zipPath = join(seedDir, 'seed.zip');

  if (source.startsWith('http://') || source.startsWith('https://')) {
    console.log(`[seed] fetching ${source}`);
    await fetchToFile(source, zipPath, { userAgent: opts.userAgent });
  } else {
    console.log(`[seed] using local ${source}`);
    copyFileSync(source, zipPath);
  }
  console.log(`[seed] zip size: ${(statSync(zipPath).size / 1024).toFixed(1)} KB`);

  // Extract everything to seedDir (flat — GTFS zips don't have subdirectories).
  // unzip is part of the standard toolchain on macOS/Linux; the Python adapter
  // shells out to it too, so we mirror that.
  const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', seedDir]);
  if (r.status !== 0) throw new Error(`unzip failed (status ${r.status})`);

  for (const f of REQUIRED) {
    try { statSync(join(seedDir, f)); }
    catch { throw new Error(`seed missing required file: ${f}`); }
  }

  const agencyTxt = readFileSync(join(seedDir, 'agency.txt'), 'utf8');
  // parseRoutes/Stops/Trips return Promises (see @n3ary/gtfs-spec/src/spec).
  // await them before using the arrays.
  const [routesRows, stopsRows, tripsRows] = await Promise.all([
    parseRoutes(readFileSync(join(seedDir, 'routes.txt'), 'utf8')),
    parseStops(readFileSync(join(seedDir, 'stops.txt'), 'utf8')),
    parseTrips(readFileSync(join(seedDir, 'trips.txt'), 'utf8')),
  ]);
  // stop_times.txt routinely exceeds 500 MB on national feeds; use the
  // streaming reader and collect into the trip_id-keyed map directly.
  const stopTimes = new Map();
  let stopTimesCount = 0;
  const stStream = parseStopTimesStream(
    (async function* () {
      yield readFileSync(join(seedDir, 'stop_times.txt'), 'utf8');
    })(),
  );
  for await (const st of stStream) {
    const sequence = parseInt(st.stop_sequence, 10);
    if (!Number.isFinite(sequence)) continue;
    const entry = { stopId: st.stop_id, sequence };
    if (!stopTimes.has(st.trip_id)) stopTimes.set(st.trip_id, []);
    stopTimes.get(st.trip_id).push(entry);
    stopTimesCount++;
  }
  for (const arr of stopTimes.values()) arr.sort((a, b) => a.sequence - b.sequence);

  // shapes.txt is optional per GTFS, but the Cluj-Napoca Transitous
  // mirror always ships it. When present we group it by shape_id so
  // the reconciliation step can project each trip's stops onto its
  // polyline (replaces straight-line haversine for stop-to-stop distance).
  // Use the streaming parser: shapes.txt routinely exceeds Node's
  // ~512 MB v8 string limit on national feeds.
  let shapesById = new Map();
  try {
    statSync(join(seedDir, 'shapes.txt'));
    const byId = new Map();
    for await (const row of parseShapesStream(
      (async function* () {
        yield readFileSync(join(seedDir, 'shapes.txt'), 'utf8');
      })(),
    )) {
      if (!row.shape_id) continue;
      const lat = parseFloat(row.shape_pt_lat);
      const lon = parseFloat(row.shape_pt_lon);
      const seq = parseInt(row.shape_pt_sequence, 10);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(seq)) continue;
      if (!byId.has(row.shape_id)) byId.set(row.shape_id, []);
      byId.get(row.shape_id).push({ lat, lon, seq });
    }
    for (const arr of byId.values()) {
      arr.sort((a, b) => a.seq - b.seq);
      // Strip the helper `seq` field — consumers only need lat/lon.
      for (const p of arr) delete p.seq;
    }
    shapesById = byId;
  } catch {
    // No shapes.txt in seed — leave shapesById empty and let the
    // reconciler fall back to haversine.
  }

  const routes = routesRows.map((r) => ({
    routeId: r.route_id,
    shortName: r.route_short_name,
    longName: r.route_long_name,
    type: r.route_type,
    color: r.route_color || '',
    textColor: r.route_text_color || '',
  }));

  const stops = stopsRows.map((s) => ({
    stopId: s.stop_id,
    name: s.stop_name,
    lat: parseFloat(s.stop_lat),
    lon: parseFloat(s.stop_lon),
  }));

  const trips = tripsRows.map((t) => ({
    tripId: t.trip_id,
    routeId: t.route_id,
    directionId: t.direction_id ? Number(t.direction_id) : 0,
    headsign: t.trip_headsign || '',
    shapeId: t.shape_id || '',
    serviceId: t.service_id,
  }));

  console.log(`[seed] parsed: ${routes.length} routes, ${stops.length} stops, ${trips.length} trips, ${stopTimesCount} stop_times`);

  return { seedDir, agencyTxt, routes, stops, trips, stopTimes, shapesById, optional: OPTIONAL };
}

export async function fetchToFile(url, dest, { userAgent = USER_AGENT, fetch: fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  // Buffer the body in memory so we can sniff for WAF HTML /
  // captcha pages BEFORE writing to disk. Transitous (the seed
  // source) has been seen returning HTTP 200 + a Cloudflare
  // challenge page when their edge rate-limits us. The captcha
  // HTML doesn't carry a non-2xx status, so a plain res.ok check
  // used to let it through. fetchToFile then wrote the HTML to
  // disk labelled seed.zip - the unzip step either failed loudly
  // downstream or parsed garbage rows. The resulting GTFS shipped
  // to consumers crashed 'stops near me' (and other views) with
  // SQL errors against bogus data.
  const buf = Buffer.from(await res.arrayBuffer());
  assertSeedZipBody(buf, url);
  await pipeline(Readable.from(buf), createWriteStream(dest));
}

/**
 * Guard a buffer against WAF / captcha / maintenance HTML bodies
 * BEFORE writing to disk. Mirrors the publisher-side
 * `assertNotWafBody` guard (see n3ary/gtfs-publisher#99 for the
 * upstream fix). Kept local here because the two repos have
 * separate dependency graphs and the snippets are small enough
 * that a shared package would be over-engineering.
 *
 * Throws with the URL + the first matched marker (or a hex prefix
 * of the body) so the build fails loudly via the caller's
 * unhandled-rejection path. The CTP CSV multi-fetch layer already
 * has its own fail-fast (`fetchAllCsvSchedules`); this fills the
 * gap below it for the Transitous seed download.
 */
export function assertSeedZipBody(buf, url) {
  const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // 'PK\x03\x04'
  // Cheap path: ZIP magic. If the body looks like a zip, trust it
  // and return - covers the overwhelmingly common case.
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) return;

  // Otherwise sniff the first ~1 KB for HTML/WAF markers + Content-Type
  // -style preamble. Some WAFs strip / mislabel headers; sniff is
  // the last line of defense.
  const head = buf.subarray(0, Math.min(buf.length, 1024)).toString('utf8').toLowerCase();
  const MARKERS = [
    '<!doctype html',
    '<html',
    'cloudflare',
    'attention required',
    'cf-mitigated',
    'just a moment',
    'checking your browser',
    'access denied',
    'forbidden',
    'captcha',
  ];
  for (const m of MARKERS) {
    if (head.includes(m)) {
      throw new Error(
        `GET ${url}: upstream body contains "${m}" marker - ` +
        `looks like a WAF / captcha page. Aborting to avoid shipping poisoned output.`,
      );
    }
  }

  // Not a zip AND no WAF markers - something else weird (truncated
  // download, partial Content-Length mismatch, etc.). Surface the
  // first 64 bytes so the operator can diagnose.
  const preview = buf.subarray(0, Math.min(buf.length, 64))
    .toString('utf8')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  throw new Error(
    `GET ${url}: upstream body is not a ZIP file ` +
    `(first bytes: "${preview.slice(0, 64)}") - ` +
    `aborting to avoid shipping poisoned output.`,
  );
}
