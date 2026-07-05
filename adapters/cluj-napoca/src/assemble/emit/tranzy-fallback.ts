// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).

import { type RouteRow } from '@n3ary/gtfs-spec/spec';

// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Tranzy /trips + /stop_times fallback for routes with no CSV coverage.
 *
 * **Purpose**: Routes that exist in Tranzy but have no CTP CSV timetable
 * would otherwise appear in `routes.txt` with zero trips in `trips.txt`,
 * which is technically valid GTFS but unhelpful — consumers (notably the
 * neary PWA) treat a route-with-no-trips as "no service" and may hide it
 * from the map entirely.
 *
 * **Why this matters**: ~60 of Tranzy's 168 Cluj-Napoca routes are
 * Tranzy-only (not in the Transitous mirror). Without this fallback,
 * those routes drop out of the published feed even though Tranzy knows
 * the trip structure. The fix pulls trips directly from Tranzy's
 * `/trips` and `/stop_times` endpoints.
 *
 * **Trade-off**: Tranzy doesn't publish `arrival_time` or
 * `departure_time` (they only carry stop ordering). Per GTFS spec,
 * when `timepoint=0` (approximate), arrival/departure MUST be empty
 * strings. So we emit:
 *   - `arrival_time` = ''
 *   - `departure_time` = ''
 *   - `timepoint` = '0'
 *
 * Downstream consumers see "this trip operates but exact times unknown"
 * — the same UX as real Tranzy-only routes would have, since the
 * upstream data doesn't carry authoritative times either.
 *
 * **Trip_id format**: `${routeId}_${dir}_${serviceId}_NT${idx}`.
 * The `NT` (no-time) sentinel makes it clear to downstream parsers
 * (e.g. `neary`'s `parseLiveStartMin`) that this trip doesn't carry a
 * real start time and shouldn't be matched against live observations.
 *
 * **Service_id**: Tranzy's `/trips` has no `service_id`. We default
 * to all three (LV, S, D) per trip — over-scheduling is better than
 * under-scheduling (the "does this route run at all" question is
 * independent of which days it runs).
 *
 * **Scope**: Only runs for routes with **no CSV coverage** at all
 * (none of LV/S/D returned parseable data). If CSV exists but is
 * suspended for one service day, we don't add a Tranzy fallback for
 * that day — the route is still considered "served" by the other days.
 * See `docs/assemble-rules.md` priority table for the rationale.
 */

import { info, warnMsg } from '../../lib/log-severity.ts';

/**
 * @typedef {{
 *   route_id: string,
 *   trip_id: string,
 *   trip_headsign: string,
 *   direction_id: string,
 *   block_id?: string,
 *   shape_id?: string,
 * }} TripRow
 *
 * @typedef {{
 *   trip_id: string,
 *   arrival_time: string,
 *   departure_time: string,
 *   stop_id: string,
 *   stop_sequence: string,
 *   stop_headsign: string,
 *   pickup_type: string,
 *   drop_off_type: string,
 *   continuous_pickup: string,
 *   continuous_drop_off: string,
 *   shape_dist_traveled: string,
 *   timepoint: string,
 * }} StopTimeRow
 */

/**
 * Build trip + stop_time rows from Tranzy's /trips + /stop_times for
 * every route that has no CSV coverage.
 *
 * @param {{
 *   tranzy: { trips: any[], stopTimes?: any, stop_times?: any[] } | null,
 *   routesByRouteId: Map<string, Pick<RouteRow, 'route_id' | 'route_short_name'>>,
 *   byRouteService: Map<string, Map<string, any>>,
 *   stopsByStopId: Map<string, { stop_id: string }>,
 *   warnings: string[],
 *   options?: { serviceIds?: string[] },
 * }} input
 * @returns {{ tripRows: TripRow[], stopTimeRows: StopTimeRow[] }}
 */
export function reconcileTranzyFallback({
  tranzy,
  routesByRouteId,
  byRouteService,
  stopsByStopId,
  warnings,
  options = {},
}) {
  const serviceIds = options.serviceIds ?? ['LV', 'S', 'D'];
  /** @type {TripRow[]} */
  const tripRows = [];
  /** @type {StopTimeRow[]} */
  const stopTimeRows = [];

  if (!tranzy || !Array.isArray(tranzy.trips) || tranzy.trips.length === 0) {
    return { tripRows, stopTimeRows };
  }

  // Group Tranzy trips by route_id (we generate one trip per Tranzy
  // trip × service_id combination).
  /** @type {Map<string, any[]>} */
  const tranzyTripsByRoute = new Map();
  for (const t of tranzy.trips) {
    const routeId = t.route_id != null ? String(t.route_id) : null;
    if (!routeId) continue;
    if (!tranzyTripsByRoute.has(routeId)) tranzyTripsByRoute.set(routeId, []);
    tranzyTripsByRoute.get(routeId).push(t);
  }

  // Build per-trip stop sequence map once (used across all routes).
  const stopTimesByTrip = normalizeStopTimes(tranzy.stopTimes ?? tranzy.stop_times);

  let routesWithFallback = 0;
  let tripsEmitted = 0;
  let tripsSkippedNoStops = 0;
  let tripsSkippedInvalidStops = 0;

  for (const [routeId, tranzyTrips] of tranzyTripsByRoute.entries()) {
    // Only fall back when the route is in our output routes AND has no
    // CSV coverage at all. Routes with partial CSV coverage (e.g. only
    // LV) still get the CSV-driven trips and don't need fallback.
    const routeRow = routesByRouteId.get(routeId);
    if (!routeRow) continue;
    const shortName = routeRow.route_short_name;
    const csvServices = byRouteService.get(shortName);
    if (csvServices && csvServices.size > 0) continue;

    // This route needs the fallback. Emit one trip per Tranzy trip ×
    // service_id (default LV+S+D).
    routesWithFallback++;
    let idx = 0;
    for (const tranzyTrip of tranzyTrips) {
      const tripId = tranzyTrip.trip_id ?? tranzyTrip.tripId;
      const rawStops = stopTimesByTrip.get(tripId) ?? [];
      if (rawStops.length === 0) {
        tripsSkippedNoStops++;
        continue;
      }
      // Filter to stops we actually have in stops.txt (drop orphans —
      // rare but possible if Tranzy references a stop that didn't make
      // it into our reconciled stops map).
      const orderedStops = rawStops
        .filter((s) => stopsByStopId.has(String(s.stopId)))
        .map((s) => ({ stopId: String(s.stopId), sequence: Number(s.sequence) }))
        .sort((a, b) => a.sequence - b.sequence);
      if (orderedStops.length === 0) {
        tripsSkippedInvalidStops++;
        continue;
      }
      const dir = tranzyTrip.direction_id != null ? Number(tranzyTrip.direction_id) : 0;
      const shapeId = tranzyTrip.shape_id ?? '';
      const headsign = tranzyTrip.trip_headsign ?? '';
      const blockId = tranzyTrip.block_id != null ? String(tranzyTrip.block_id) : '';

      for (const serviceId of serviceIds) {
        idx++;
        const generatedTripId = `${routeId}_${dir}_${serviceId}_NT${String(idx).padStart(3, '0')}`;
        tripRows.push({
          route_id: routeId,
          service_id: serviceId,
          trip_id: generatedTripId,
          trip_headsign: headsign,
          direction_id: String(dir),
          block_id: blockId,
          shape_id: shapeId,
        });
        for (const s of orderedStops) {
          stopTimeRows.push({
            trip_id: generatedTripId,
            arrival_time: '',
            departure_time: '',
            stop_id: s.stopId,
            stop_sequence: String(s.sequence),
            stop_headsign: '',
            pickup_type: '',
            drop_off_type: '',
            continuous_pickup: '',
            continuous_drop_off: '',
            shape_dist_traveled: '',
            // '0' per GTFS spec: times are approximate / unknown.
            timepoint: '0',
          });
        }
        tripsEmitted++;
      }
    }
  }

  if (routesWithFallback > 0) {
    warnings.push(info(
      `routes: ${routesWithFallback} routes using Tranzy /trips fallback ` +
      `(no CSV coverage — times empty, timepoint=0, ${tripsEmitted} trips emitted, ` +
      `service_ids=${serviceIds.join('+')})`,
    ));
  }
  if (tripsSkippedNoStops > 0) {
    warnings.push(warnMsg(`Tranzy fallback: ${tripsSkippedNoStops} trips skipped (no stop_times in Tranzy)`));
  }
  if (tripsSkippedInvalidStops > 0) {
    warnings.push(warnMsg(`Tranzy fallback: ${tripsSkippedInvalidStops} trips skipped (all stops missing from reconciled stops.txt)`));
  }

  return { tripRows, stopTimeRows };
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