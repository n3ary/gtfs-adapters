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

import { parseRoutes, parseStops, parseTrips, parseStopTimesStream, parseShapes } from '@n3ary/gtfs-spec/spec';

const REQUIRED = ['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt'];
const OPTIONAL = ['shapes.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt'];

export const USER_AGENT = 'cluj-napoca-gtfs-adapter/0.1 (https://github.com/ciotlosm/cluj-napoca-gtfs-adapter)';

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
  const routesRows = parseRoutes(readFileSync(join(seedDir, 'routes.txt'), 'utf8'));
  const stopsRows = parseStops(readFileSync(join(seedDir, 'stops.txt'), 'utf8'));
  const tripsRows = parseTrips(readFileSync(join(seedDir, 'trips.txt'), 'utf8'));
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
  let shapesById = new Map();
  try {
    statSync(join(seedDir, 'shapes.txt'));
    const shapesRows = parseShapes(readFileSync(join(seedDir, 'shapes.txt'), 'utf8'));
    const byId = new Map();
    for (const row of shapesRows) {
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

export async function fetchToFile(url, dest, { userAgent = USER_AGENT } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}
