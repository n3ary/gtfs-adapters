// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * polyline — per-stop projection onto a GTFS route shape.
 *
 * The pure geometry primitives (`haversineMeters`, `projectOnPolyline`)
 * live in `@n3ary/gtfs-spec/shape` (shared with the orchestrator's
 * GTFS worker + the `neary` runtime). This module re-exports them and
 * adds one composition helper — `cumulativeShapeDistances` — that
 * turns a stop sequence + a polyline into monotonic per-stop
 * cumulative distances with haversine fallback for off-shape stops.
 * That fallback is adapter-specific (the 200 m threshold + the
 * `max(..., previous + 1)` monotonicity rule are reconciliation
 * choices, not GTFS invariants).
 *
 * Used by `lib/timing.ts` to walk each trip's `stop_sequence` along
 * its `shape_id` polyline so stop-to-stop distances reflect the
 * road, not crow-flight haversine.
 */

import { haversineMeters, projectOnPolyline } from '@n3ary/gtfs-spec/shape';

export { haversineMeters, projectOnPolyline };

/**
 * Project each stop in `stops` onto the polyline and return their
 * cumulative distances along the shape, in input order.
 *
 * To prevent a stop that projects slightly upstream of its
 * predecessor (e.g. when two adjacent stops both lie near the same
 * polyline kink) from producing a negative segment length, the
 * returned values are monotonically non-decreasing — each entry is
 * `max(projection, previous + 1)`.
 *
 * Falls back to haversine-between-adjacent-stops when the polyline
 * is missing / too short / when a stop's perpendicular distance
 * exceeds `maxPerpDistM` (the stop isn't on this shape). The
 * fallback also seeds the cumulative distance with the projection
 * for stops that DID project well, so a single off-shape stop
 * doesn't poison the whole trip.
 *
 * @param {Array<{lat:number,lon:number}>} stops  ordered by stop_sequence
 * @param {Array<{lat:number,lon:number}>} polyline  may be empty
 * @param {number} maxPerpDistM  threshold above which a projection is rejected
 * @returns {number[]}  cumulative distance per stop, in meters
 */
export function cumulativeShapeDistances(stops, polyline, maxPerpDistM = 200) {
  const n = stops.length;
  if (n === 0) return [];
  const usable = Array.isArray(polyline) && polyline.length >= 2;
  const out = new Array(n);
  if (!usable) {
    out[0] = 0;
    for (let i = 1; i < n; i++) {
      out[i] = out[i - 1] + haversineMeters(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const { distAlongM, perpDistM } = projectOnPolyline(stops[i], polyline);
    const fallback = i === 0
      ? 0
      : out[i - 1] + haversineMeters(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
    let chosen = perpDistM > maxPerpDistM ? fallback : distAlongM;
    if (i > 0 && chosen <= out[i - 1]) chosen = out[i - 1] + 1;
    out[i] = chosen;
  }
  return out;
}
