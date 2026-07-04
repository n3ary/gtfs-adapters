// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Transitous seed → GTFS-shaped derived structures.
 *
 * The Transitous seed has a slightly different shape than Tranzy's JSON
 * output (camelCase instead of snake_case, e.g. `routeId` vs `route_id`).
 * This module:
 *   1. Stamps each row with `source: 'transitous'` for attribution.
 *   2. Builds `seedPatternsByRouteDir` — first trip per (route_id,
 *      direction_id), the canonical pattern shape the reconciler uses
 *      for Transitous-only routes.
 *
 * Pure functions — no network, no side effects. Easy to unit-test by
 * passing in fixture seed arrays.
 */

/**
 * Build a `patternByRouteDir` map from the seed's first trip per
 * `(route_id, direction_id)`. Same lookup `feeds/cluj-napoca/build.js`
 * does — and the one that fails for `neary-gtfs#13` (25N missing
 * dir=1) and `#15` (M26 missing dir=1). The reconciler falls back to
 * Tranzy when this returns nothing.
 *
 * @param {{trips: Array, stopTimes: Map<string, Array>}} seed
 * @returns {Map<string, {
 *   stops: Array<{stopId, sequence}>,
 *   shapeId: string,
 *   headsign: string,
 *   tripId: string,
 *   source: 'seed',
 * }>}
 */
export function seedPatternsByRouteDir(seed) {
  const out = new Map();
  for (const trip of seed.trips) {
    const key = `${trip.routeId}|${trip.directionId}`;
    if (out.has(key)) continue;
    const stops = seed.stopTimes.get(trip.tripId);
    if (!stops || stops.length === 0) continue;
    out.set(key, {
      stops,
      shapeId: trip.shapeId,
      headsign: trip.headsign,
      tripId: trip.tripId,
      source: 'seed',
    });
  }
  return out;
}

/**
 * Normalize a Transitous seed: stamp every row with `source: 'transitous'`.
 * Pure pass-through for downstream indexes.
 *
 * @param {object} seed - output of `loadTransitousSeed()`
 * @returns {object} same shape, with `source` stamp on each row
 */
export function transformTransitousSeed(seed) {
  const stamp = (rows) => rows.map((row) => ({ ...row, source: 'transitous' }));
  return {
    ...seed,
    routes: stamp(seed.routes ?? []),
    stops: stamp(seed.stops ?? []),
    trips: stamp(seed.trips ?? []),
    agencyTxt: seed.agencyTxt,
    shapesById: seed.shapesById,
    stopTimes: seed.stopTimes,
    seedDir: seed.seedDir,
    source: seed.source ?? 'transitous',
  };
}