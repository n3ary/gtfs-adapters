/**
 * RT surface of the Helsinki adapter.
 *
 * Two responsibilities (same shape as the cluj adapter):
 *   1. Per-feed Quirk for the rt app (HSL-specific: synthesize
 *      trip_id from the route_id+start_date+start_time+
 *      direction_id composite that HSL ships instead of
 *      trip_id, and split the operator/vehicle id). The rt
 *      app dynamic-imports this subpath and calls the Quirk
 *      per fetched FeedMessage.
 *   2. Additional vehicle_positions URLs the operator has
 *      set up beyond the canonical HSL endpoint. Currently
 *      empty; the HSL realtime.hsl.fi service is the single
 *      source of truth for vehicle positions. Consumed by
 *      the static pipeline at build time.
 *
 * Note: the canonical `vehicle_positions` / `trip_updates` /
 * `service_alerts` URLs are NOT exported here. They are
 * "official-data" owned either by the per-feed authored
 * config (`feeds/<id>/config.json`) or by the MDB catalog
 * lookup -- not by the adapter.
 */
import { helsinkiQuirk, syntheticHslTripId, splitHslVehicleId } from './helsinki.ts';

export { helsinkiQuirk, syntheticHslTripId, splitHslVehicleId };

/**
 * Adapter-level "extras" for the static pipeline at build time.
 * The HSL realtime.hsl.fi service is the single source of
 * truth; no mirrors to declare. If HSL ever sets up a
 * failover URL (e.g. for the metro line outage), add it here.
 */
export const extraVehiclePositions: ReadonlyArray<string> = [];
