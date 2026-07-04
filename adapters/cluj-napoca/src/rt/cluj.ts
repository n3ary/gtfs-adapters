/**
 * Cluj RT quirk — recover `direction_id` and `start_time` from the
 * upstream's `<route>_<dir>_<service>_<run>_<HHMM>`-encoded
 * `trip_id`. See n3ary/app#161 for the full context.
 *
 * Originally lived in `n3ary/gtfs/packages/gtfs-rt/src/quirks/cluj.ts`
 * — moved here as part of the per-feed-knowledge extraction
 * (n3ary/gtfs#67). The generic gtfs-rt proxy loads this quirk at
 * startup; the consumer (n3ary/app) stays strictly feed-agnostic.
 *
 * Encoding (from the upstream):
 *   <route_id>_<dir_id>_<service_id>_<run>_<HHMM>
 *     e.g. "38_0_weekday_2_1430"
 *           route=38, dir=0, service=weekday, run=2, start=14:30
 *
 * If a trip_id doesn't match this pattern, it's left as-is — we'd
 * rather pass through an unknown case than guess and mis-attribute.
 */
import type GtfsRealtimeBindings from 'gtfs-realtime-bindings';

type FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;

/** Quirk function shape — matches the generic proxy's `Quirk` type. */
export type ClujQuirk = (feedMessage: FeedMessage) => FeedMessage;

const PATTERN = /^(\d+)_(\d)_([a-z0-9]+)_(\d+)_(\d{4})$/;

export function parseClujTripId(
  tripId: string,
): { routeId: string; dirId: number; serviceId: string; run: number; startTime: string } | null {
  const m = PATTERN.exec(tripId);
  if (!m) return null;
  const routeId = m[1] ?? '';
  const dir = m[2] ?? '';
  const serviceId = m[3] ?? '';
  const run = m[4] ?? '';
  const hhmm = m[5] ?? '';
  return {
    routeId,
    dirId: Number(dir),
    serviceId,
    run: Number(run),
    startTime: `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00`,
  };
}

export const clujRtQuirk: ClujQuirk = (feedMessage) => {
  for (const entity of feedMessage.entity) {
    if (!entity.vehicle) continue;
    const trip = entity.vehicle.trip;
    if (!trip || !trip.tripId) continue;

    const dirIsZero = trip.directionId === 0;
    const startTimeEmpty = !trip.startTime || trip.startTime === '';
    if (!dirIsZero && !startTimeEmpty) continue;

    const parsed = parseClujTripId(trip.tripId);
    if (!parsed) continue;

    if (dirIsZero) trip.directionId = parsed.dirId;
    if (startTimeEmpty) trip.startTime = parsed.startTime;
  }
  return feedMessage;
};
