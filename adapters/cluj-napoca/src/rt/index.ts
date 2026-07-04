/**
 * RT surface of the Cluj adapter.
 *
 * Exports the per-feed quirks to register with the generic gtfs-rt
 * proxy. The generic proxy exposes a `registerRtQuirks(quirkFor)`
 * call; we hand it a function that returns our quirk for the
 * `cluj-napoca` feed and undefined for everything else.
 */
import { clujRtQuirk, parseClujTripId } from './cluj';
import type { ClujQuirk } from './cluj';

export { clujRtQuirk, parseClujTripId };
export type { ClujQuirk };

/**
 * Adapter hook for the generic proxy. Returns the quirk for our
 * feed IDs, undefined for others. The proxy loads this at startup.
 *
 *   const quirks = new Map<string, ClujQuirk>();
 *   registerRtQuirks((feedId) => feedId === 'cluj-napoca' ? clujRtQuirk : undefined);
 *   const q = quirks.get('cluj-napoca')!;  // our quirk
 */
export function registerRtQuirks(register: (quirkFor: (feedId: string) => ClujQuirk | undefined) => void): void {
  const CLUJ_FEED_ID = 'cluj-napoca';
  register((feedId) => (feedId === CLUJ_FEED_ID ? clujRtQuirk : undefined));
}
