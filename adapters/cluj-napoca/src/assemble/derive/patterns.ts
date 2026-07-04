// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Pattern resolution: given the seed + Tranzy + CSV inputs, return
 * the best stop sequence for each `(route_id, direction_id)` pair.
 *
 * Source priority (per `docs/assemble-rules.md`):
 *   1. Transitous seed (`neary-gtfs#13` and `#15` succeed when the
 *      seed has the pattern)
 *   2. Tranzy (`#13`/`#15` are *fixed* by this — Tranzy fills the
 *      missing direction)
 *   3. Otherwise null → trips for that (route, dir) are dropped
 *
 * Each resolved pattern also carries:
 *   - `shapeId`: shape_id to write into trips.txt
 *   - `headsign`: preferred headsign (Tranzy > seed > CSV's stop name)
 *   - `stops[]`: ordered stop list
 */

import { seedPatternsByRouteDir } from '../../sources/transitous/index';

/**
 * Build a per-(route, dir) pattern map from Tranzy. Tranzy organizes
 * shapes per direction with shape_id = `<route>_<dir>`. We group trips
 * by (route_id, direction_id, shape_id) and pick the longest trip's
 * stop sequence as the representative pattern.
 *
 * Accepts `tranzy.stopTimes` as either a `Map<string, stops[]>` (when
 * fed from a normalized source) or an array of `{trip_id, stop_id,
 * stop_sequence}` rows (raw Tranzy API response). We normalize on the fly.
 *
 * @param {{trips: any[], stopTimes?: any, stop_times?: any[]} | null} tranzy
 * @returns {Map<string, {
 *   stops: Array<{stopId, sequence}>,
 *   shapeId: string,
 *   headsign: string,
 *   tripId: string,
 *   source: 'tranzy',
 * }>}
 */
export function tranzyPatternsByRouteDir(tranzy) {
  if (!tranzy || !Array.isArray(tranzy.trips)) return new Map();

  /** @type {Map<string, Array<{stopId, sequence}>>} */
  const stopTimesByTrip = normalizeStopTimes(tranzy.stopTimes ?? tranzy.stop_times);

  /** @type {Map<string, any[]>} */
  const byKey = new Map();
  for (const trip of tranzy.trips) {
    const routeId = trip.route_id ? String(trip.route_id) : null;
    const dir = trip.direction_id != null ? Number(trip.direction_id) : 0;
    if (!routeId) continue;
    const key = `${routeId}|${dir}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(trip);
  }

  const out = new Map();
  for (const [key, trips] of byKey.entries()) {
    // Pick the trip with the most stops as representative.
    let best = trips[0];
    let bestLen = 0;
    for (const t of trips) {
      const tripId = t.trip_id ?? t.tripId;
      const stops = stopTimesByTrip.get(tripId) ?? [];
      if (stops.length > bestLen) {
        best = t;
        bestLen = stops.length;
      }
    }
    if (!best) continue;
    const tripId = best.trip_id ?? best.tripId;
    const stops = stopTimesByTrip.get(tripId) ?? [];
    if (stops.length === 0) continue;
    out.set(key, {
      stops,
      shapeId: best.shape_id ?? '',
      headsign: best.trip_headsign ?? '',
      tripId,
      source: 'tranzy',
    });
  }
  return out;
}

/** @returns {Map<string, Array<{stopId, sequence}>>} */
function normalizeStopTimes(input) {
  const out = new Map();
  if (!input) return out;
  if (input instanceof Map) {
    for (const [tripId, stops] of input.entries()) {
      out.set(tripId, stops.slice().sort((a, b) => (a.sequence ?? a.stop_sequence ?? 0) - (b.sequence ?? b.stop_sequence ?? 0)));
    }
    return out;
  }
  if (Array.isArray(input)) {
    for (const row of input) {
      const tripId = row.trip_id ?? row.tripId;
      if (!tripId) continue;
      const seq = Number(row.stop_sequence ?? row.sequence);
      const stopId = row.stop_id ?? row.stopId;
      if (!out.has(tripId)) out.set(tripId, []);
      out.get(tripId).push({ stopId, sequence: seq });
    }
    for (const arr of out.values()) arr.sort((a, b) => a.sequence - b.sequence);
  }
  return out;
}

/**
 * Resolve a single (route_id, direction_id) pattern using the
 * Tranzy → seed priority order.
 *
 * Why Tranzy first: Cluj-Napoca city hall promotes Tranzy as the
 * authoritative live source for the network, so Tranzy is more
 * up-to-date (per-direction shapes, recent route additions). When a
 * route exists in both, Tranzy's pattern is the live truth.
 *
 * The seed (Transitous) is the fallback when Tranzy is missing the
 * route or direction. This is what fixed neary-gtfs#13 (25N dir=1
 * missing from seed) and #15 (M26 dir=1 missing from seed) — both
 * Tranzy-only directions.
 *
 * @param {string} routeId
 * @param {number} directionId
 * @param {{
 *   seedPatterns: Map<string, any>,
 *   tranzyPatterns: Map<string, any>,
 *   csvFallbackStops?: (routeShortName: string, dir: number) => string[] | null,
 * }} sources
 * @returns {{stops, shapeId, headsign, source} | null}
 */
export function resolvePattern(routeId, directionId, sources) {
  const key = `${routeId}|${directionId}`;
  const tranzy = sources.tranzyPatterns.get(key);
  if (tranzy && tranzy.stops.length > 0) {
    return { stops: tranzy.stops, shapeId: tranzy.shapeId, headsign: tranzy.headsign, source: 'tranzy' };
  }
  const seed = sources.seedPatterns.get(key);
  if (seed && seed.stops.length > 0) {
    return { stops: seed.stops, shapeId: seed.shapeId, headsign: seed.headsign, source: 'seed' };
  }
  return null;
}

export { seedPatternsByRouteDir };