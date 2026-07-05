// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Transitous source — high-level entry point.
 *
 * Composes the network client and the transform layer into a single
 * `loadTransitousData(opts)` call that returns a stamped GTFS-shaped
 * structure with derived patterns ready for reconciliation.
 *
 *   loadTransitousData({ url }) →
 *     { routes, stops, trips, stopTimes, agencyTxt, shapesById,
 *       seedDir, source }
 *
 * For tests, swap the client by importing `./client.js` directly and
 * feeding raw seed arrays into `./transform.js`.
 */

export { loadTransitousSeed, TRANSITOUS_SEED_URL } from './client.ts';
export { seedPatternsByRouteDir, transformTransitousSeed } from './transform.ts';

import { loadTransitousSeed } from './client.ts';
import { transformTransitousSeed } from './transform.ts';

/**
 * Fetch the Transitous seed and transform into a stamped GTFS-shaped
 * structure with derived patterns.
 *
 * @param {Parameters<typeof loadTransitousSeed>[0]} opts
 */
export async function loadTransitousData(opts) {
  const raw = await loadTransitousSeed(opts);
  const transformed = transformTransitousSeed(raw);
  return {
    ...transformed,
    patternsByRouteDir: seedPatternsByRouteDir(transformed),
  };
}