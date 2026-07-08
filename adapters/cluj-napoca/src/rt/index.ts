/**
 * RT surface of the Cluj adapter.
 *
 * Two responsibilities:
 *   1. Per-feed Quirk for the rt app (recovering direction_id +
 *      start_time from the upstream's `<route>_<dir>_<svc>_<run>_<HHMM>`
 *      tripId encoding). The rt app dynamic-imports this subpath and
 *      calls the Quirk per fetched FeedMessage.
 *   2. Additional vehicle_positions URLs the operator has set up
 *      beyond the canonical CTP endpoint. Empty today; if CTP ever
 *      publishes a mirror, this is the one place that knows.
 *      Consumed by the static pipeline at build time.
 *
 * Note: the canonical `vehicle_positions` / `trip_updates` /
 * `service_alerts` URLs are NOT exported here. They are
 * "official-data" owned either by the per-feed authored config
 * (`feeds/<id>/config.json`) or by the MDB catalog lookup -- not
 * by the adapter.
 */
import { clujQuirk, parseClujTripId } from './cluj.ts';
import type { ClujQuirk } from './cluj.ts';
import { extraVehiclePositions } from './extras.ts';

export { clujQuirk, parseClujTripId, extraVehiclePositions };
export type { ClujQuirk };

/**
 * Adapter hook for the generic proxy. Returns the quirk for our
 * feed IDs, undefined for others. The proxy loads this at startup.
 *
 *   const quirks = new Map<string, ClujQuirk>();
 *   registerRtQuirks((feedId) => feedId === 'cluj-napoca' ? clujQuirk : undefined);
 *   const q = quirks.get('cluj-napoca')!;  // our quirk
 */
export function registerRtQuirks(register: (quirkFor: (feedId: string) => ClujQuirk | undefined) => void): void {
  const CLUJ_FEED_ID = 'cluj-napoca';
  register((feedId) => (feedId === CLUJ_FEED_ID ? clujQuirk : undefined));
}
