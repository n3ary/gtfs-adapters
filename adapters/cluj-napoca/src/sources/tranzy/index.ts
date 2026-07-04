/**
 * Tranzy.ai source — high-level entry point.
 *
 * Composes the network client and the transform layer into a single
 * `loadTranzyData(opts)` call that returns a fully indexed GTFS-shaped
 * structure ready for reconciliation.
 *
 *   loadTranzyData({ apiKey, agencyId }) →
 *     { routes, stops, trips, shapes, stop_times, calendar,
 *       byRouteId, byStopId }
 *
 * For tests, swap the client with a mock by importing
 * `./client.js` directly and feeding raw arrays into `./transform.js`.
 */

export { TranzyClient, TranzyError, TranzyAuthError, TranzyRateLimitError } from './client';
export { transformTranzyData } from './transform';

import { TranzyClient } from './client';
import { transformTranzyData } from './transform';

/**
 * Fetch every Tranzy endpoint and transform into a GTFS-shaped structure.
 *
 * @param {ConstructorParameters<typeof TranzyClient>[0]} opts
 */
export async function loadTranzyData(opts: ConstructorParameters<typeof TranzyClient>[0]) {
  const client = new TranzyClient(opts);
  const raw = await client.fetchAll();
  return transformTranzyData(raw);
}
