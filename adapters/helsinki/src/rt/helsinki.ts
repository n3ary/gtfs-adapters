/**
 * Helsinki RT quirk — HSL's GTFS-RT feeds have two quirks the
 * generic proxy can't handle:
 *
 *   1. **Trip IDs are not available.** HSL's real-time feed
 *      does NOT include `trip_id` on VehiclePosition or
 *      TripUpdate entities. The unique trip identifier is
 *      the COMPOSITE of `route_id + start_date + start_time +
 *      direction_id` (per https://hsldevcom.github.io/gtfs_rt/,
 *      "Trip updates" + "Vehicle positions" sections).
 *
 *      The static GTFS does have trip_ids, but HSL's static
 *      feed regenerates trip_ids on every publish, so they
 *      are not stable across static-GTFS rebuilds. Matching
 *      an RT vehicle to a static trip therefore has to go
 *      through the composite, not the trip_id directly.
 *
 *      For the n3ary app, the simplest workable surrogate is
 *      a synthetic `trip_id` synthesized from the composite.
 *      We use the format `hsl:<route_id>:<start_date>:
 *      <start_time>:<direction_id>`. This is what the RT
 *      app's `quircContext` reports the upstream `url` for,
 *      and the static pipeline can do the same synthesis on
 *      its end (in the static ExtensionContext) to build a
 *      matching key. See the README for the full matching
 *      plan.
 *
 *   2. **Vehicle IDs are composite.** Per HSL's RT spec, the
 *      `vehicle.id` field is `<operator_id>/<vehicle_id>`.
 *      Operators are HSL, HRT (Helsinki Regional Transit --
 *      the regional bus operator), or third-party contractors
 *      (Nobina, Transdev, etc.). The app wants the bare
 *      vehicle number for the chip, so we expose
 *      `vehicle.vehicle.label = <vehicle_id>` (the post-slash
 *      portion) and leave `vehicle.id` as the full composite
 *      so consumers that want to filter by operator can.
 *
 *   3. **Current_status only meaningful with HFP events.**
 *      HSL docs say vehicles WITH HFP events (DUE, ARS, etc.)
 *      cycle through IN_TRANSIT_TO -> INCOMING_AT -> STOPPED_AT.
 *      Vehicles WITHOUT HFP events only ever get IN_TRANSIT_TO
 *      or STOPPED_AT. The RT app doesn't currently use
 *      current_status, so this quirk is informational -- the
 *      pass-through is the right behaviour.
 *
 * The Quirk is intentionally additive: we only set fields that
 * are missing or that we know are wrong for the HSL upstream.
 * If a future HSL release starts shipping trip_ids (or changes
 * the vehicle_id format), our pass-through is the right
 * default.
 */

import type GtfsRealtimeBindings from 'gtfs-realtime-bindings';

type FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;

export type HelsinkiQuirk = (
  feedMessage: FeedMessage,
) => FeedMessage;

/**
 * Build the synthetic trip_id that lets an RT entity be matched
 * to a static trip without going through the (regenerated-on-
 * every-publish) trip_id from the static feed. Pure function,
 * exported for tests.
 *
 * Format: `hsl:<route_id>:<start_date>:<start_time>:<direction_id>`
 *  - `route_id`    : HSL route_id, e.g. "1003" (a tram) or
 *                    "HSL:1003" depending on agency prefix.
 *  - `start_date`  : YYYYMMDD, the service day. HSL's RT
 *                    feed carries this on TripUpdate.
 *  - `start_time`  : HH:MM:SS in agency-local time. HSL is
 *                    Europe/Helsinki; we don't convert here
 *                    (the matcher downstream treats it as a
 *                    string key).
 *  - `direction_id`: 0 or 1.
 *
 * The `hsl:` prefix avoids collisions with any actual
 * `trip_id` HSL might one day ship. Returns null on missing
 * fields -- a non-passable combination is left as-is (no
 * synthetic key, the matcher can decide what to do).
 */
export function syntheticHslTripId(args: {
  routeId: string;
  startDate: string;
  startTime: string;
  directionId: number;
}): string | null {
  if (!args.routeId || !args.startDate || !args.startTime) return null;
  if (args.directionId !== 0 && args.directionId !== 1) return null;
  return `hsl:${args.routeId}:${args.startDate}:${args.startTime}:${args.directionId}`;
}

/**
 * Split HSL's `<operator_id>/<vehicle_id>` vehicle id into its
 * parts. Returns the bare vehicle number as the second tuple
 * element, or the original string when no `/` is present.
 *
 *  - HSL:            "HSL/1234"         -> ["HSL", "1234"]
 *  - HRT:            "HRT/5678"         -> ["HRT", "5678"]
 *  - Operator not set: "1234"           -> [null, "1234"]
 */
export function splitHslVehicleId(
  vehicleId: string,
): { operator: string | null; vehicleNumber: string } {
  const slash = vehicleId.indexOf('/');
  if (slash < 0) return { operator: null, vehicleNumber: vehicleId };
  return {
    operator: vehicleId.slice(0, slash) || null,
    vehicleNumber: vehicleId.slice(slash + 1) || vehicleId,
  };
}

export const helsinkiQuirk: HelsinkiQuirk = (feedMessage) => {
  for (const entity of feedMessage.entity) {
    // --- VehiclePosition: synthesize trip_id, split vehicle id ---
    if (entity.vehicle) {
      const v = entity.vehicle;
      // Synthesize a trip_id when the upstream omits it but the
      // composite is present. We do NOT clobber an upstream
      // trip_id if HSL ever starts sending one -- the composite
      // is an HSL-specific convention, the trip_id is the spec
      // field that the matcher upstream would prefer.
      if (!v.trip?.tripId && v.trip?.routeId) {
        const startDate = v.trip?.startDate ?? '';
        const startTime = v.trip?.startTime ?? '';
        const directionId =
          typeof v.trip?.directionId === 'number' ? v.trip.directionId : -1;
        const synth = syntheticHslTripId({
          routeId: v.trip.routeId,
          startDate,
          startTime,
          directionId,
        });
        if (synth && v.trip) {
          v.trip.tripId = synth;
        }
      }
      // Split vehicle.id. We set `vehicle.vehicle.label` to the
      // bare vehicle number so the app's chip can show just the
      // number. `vehicle.id` stays as the full composite.
      if (v.vehicle?.id && !v.vehicle.label) {
        const { vehicleNumber } = splitHslVehicleId(v.vehicle.id);
        if (v.vehicle) v.vehicle.label = vehicleNumber;
      }
    }

    // --- TripUpdate: synthesize trip_id if missing ---
    if (entity.tripUpdate) {
      const t = entity.tripUpdate;
      if (!t.trip?.tripId && t.trip?.routeId) {
        const startDate = t.trip?.startDate ?? '';
        const startTime = t.trip?.startTime ?? '';
        const directionId =
          typeof t.trip?.directionId === 'number' ? t.trip.directionId : -1;
        const synth = syntheticHslTripId({
          routeId: t.trip.routeId,
          startDate,
          startTime,
          directionId,
        });
        if (synth && t.trip) {
          t.trip.tripId = synth;
        }
      }
    }

    // --- VehicleDescriptor in TripUpdate.StopTimeUpdate ---
    // The StopTimeUpdate carries a nested VehicleDescriptor (the
    // vehicle that will serve / is serving the updated stop).
    // HSL populates this on TripUpdate entities. Apply the same
    // vehicle_id split there.
    //
    // The `vehicle` field is part of the GTFS-RT protobuf
    // (transit_realtime.proto's `StopTimeUpdate.vehicle` field,
    // type VehicleDescriptor) but isn't exposed in the
    // gtfs-realtime-bindings@1.1.1 TypeScript declarations. We
    // cast through `unknown` to access the runtime field without
    // pulling a newer bindings version.
    if (entity.tripUpdate?.stopTimeUpdate) {
      for (const stu of entity.tripUpdate.stopTimeUpdate as unknown as Array<{
        vehicle?: { id?: string; label?: string };
      }>) {
        if (stu.vehicle?.id && !stu.vehicle.label) {
          const { vehicleNumber } = splitHslVehicleId(stu.vehicle.id);
          if (stu.vehicle) stu.vehicle.label = vehicleNumber;
        }
      }
    }
  }
  return feedMessage;
};
