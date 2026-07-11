/**
 * Cluj RT quirk — recover `direction_id` and `start_time` from the
 * upstream's `<route>_<dir>_<service>_<run>_<HHMM>`-encoded
 * `trip_id`. See n3ary/app#161 for the full context.
 *
 * Canonical source for the per-feed quirk. The generic gtfs-rt
 * proxy (`n3ary/gtfs-publisher/packages/gtfs-rt/src/quirks/`)
 * imports it from `@n3ary/gtfs-adapter-cluj-napoca/rt` —
 * finishing step 4 of n3ary/gtfs-publisher#67. See
 * n3ary/gtfs-publisher#91 for the orchestrator-side redirect.
 *
 * Encoding (from the upstream):
 *   <route_id>_<dir_id>_<service_id>_<run>_<HHMM>
 *     e.g. "38_0_weekday_2_1430"
 *           route=38, dir=0, service=weekday, run=2, start=14:30
 *     e.g. "23_1_S_80_2138"   (live RT upstream, service id in upper case)
 *           route=23, dir=1, service=S, run=80, start=21:38
 *
 * The `service_id` segment is matched case-insensitively: the static
 * GTFS feed (which the original fixtures came from) uses lowercase
 * ids like `weekday`, but the live RT feed at
 * `https://cluj-rt-feed.gtfs.ro/vehiclePositions` uses uppercase
 * ids (e.g. `S`). Forgetting this made the quirk silently no-op on
 * 100% of live entities - see n3ary/gtfs-publisher#74 and
 * n3ary/gtfs-publisher#36.
 *
 * If a trip_id doesn't match this pattern, it's left as-is - we'd
 * rather pass through an unknown case than guess and mis-attribute.
 */
import type GtfsRealtimeBindings from 'gtfs-realtime-bindings';

type FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;

/** Quirk function shape - matches the generic proxy's `Quirk` type. */
export type ClujQuirk = (feedMessage: FeedMessage) => FeedMessage;

// Service-id segment is `[A-Za-z0-9]+` to cover both the static
// feed's lowercase ids (e.g. `weekday`) and the live RT feed's
// uppercase ids (e.g. `S`). See file header.
const PATTERN = /^(\d+)_(\d)_([A-Za-z0-9]+)_(\d+)_(\d{4})$/;

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

export const clujQuirk: ClujQuirk = (feedMessage) => {
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
