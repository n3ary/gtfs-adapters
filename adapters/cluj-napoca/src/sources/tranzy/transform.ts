// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Tranzy data → GTFS-shaped structure with derived indexes.
 *
 * Tranzy's REST API already returns JSON in GTFS field names (route_id,
 * stop_lat, shape_pt_sequence, etc.). The transform layer's job is to:
 *   1. Pass through the raw arrays so existing consumers iterate them
 *      the same way they did before.
 *   2. Build lookup indexes (byRouteId, byStopId) for O(1) access — saves
 *      downstream modules from rebuilding these per-route.
 *   3. Stamp every row with `source: 'tranzy'` so the reconciler can
 *      attribute each contribution in the build log.
 *
 * This is intentionally a pure function — no network, no side effects.
 * Easy to unit-test by passing in fixture arrays.
 */

/**
 * @param {{
 *   routes?: Array<object>,
 *   stops?: Array<object>,
 *   trips?: Array<object>,
 *   shapes?: Array<object>,
 *   stop_times?: Array<object>,
 *   calendar?: Array<object>,
 * }} raw - output of TranzyClient.fetchAll()
 * @returns {{
 *   routes: Array<object>,
 *   stops: Array<object>,
 *   trips: Array<object>,
 *   shapes: Array<object>,
 *   stop_times: Array<object>,
 *   calendar: Array<object>,
 *   byRouteId: Map<string, object>,
 *   byStopId: Map<string, object>,
 * }}
 */
type TranzyRaw = {
  routes?: unknown[];
  stops?: unknown[];
  trips?: unknown[];
  shapes?: unknown[];
  stop_times?: unknown[];
  calendar?: unknown[];
};

type Stamped = { source?: string } & Record<string, unknown>;

export function transformTranzyData(raw: TranzyRaw) {
  const routes = stampSource(raw.routes ?? [], 'tranzy');
  const stops = stampSource(raw.stops ?? [], 'tranzy');
  const trips = stampSource(raw.trips ?? [], 'tranzy');
  const shapes = stampSource(raw.shapes ?? [], 'tranzy');
  const stopTimes = stampSource(raw.stop_times ?? [], 'tranzy');
  const calendar = stampSource(raw.calendar ?? [], 'tranzy');

  const byRouteId = new Map(routes.map((r) => [String(r.route_id), r]));
  const byStopId = new Map(stops.map((s) => [String(s.stop_id), s]));

  return {
    routes,
    stops,
    trips,
    shapes,
    stop_times: stopTimes,
    calendar,
    byRouteId,
    byStopId,
  };
}

function stampSource(rows: unknown[], source: string): Stamped[] {
  const out: Stamped[] = [];
  for (const row of rows) {
    if (row && typeof row === 'object' && (row as Stamped).source === undefined) {
      (row as Stamped).source = source;
    }
    out.push(row as Stamped);
  }
  return out;
}