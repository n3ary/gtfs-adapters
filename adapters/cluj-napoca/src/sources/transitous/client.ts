// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Transitous seed fetcher.
 *
 * Thin wrapper around `loadSeed` from `src/lib/seed.js` (which does the
 * actual zip download + parse). Returns the parsed seed as-is so the
 * transform layer can build derived indexes.
 *
 * Transitous serves feeds as `<iso>_<name>.gtfs.zip` where:
 *   - `<iso>` is the lowercased country ISO-3166-1 alpha-2 (`ro`)
 *   - `<name>` is the Transitous catalogue name (`Cluj-Napoca`)
 *
 * Source: https://github.com/public-transit/transitous
 * Catalog: `ro_Cluj-Napoca` → mdb-2121 (Mobility Database mirror)
 */

import { loadSeed } from '../../lib/seed';

const DEFAULT_SEED_URL = 'https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip';

/**
 * @param {object} [opts]
 * @param {string} [opts.url]       override the seed URL (for tests)
 * @param {string} [opts.userAgent] override the HTTP UA (for tests)
 */
export async function loadTransitousSeed({ url = DEFAULT_SEED_URL, userAgent } = {}) {
  console.log(`[transitous] loading seed from ${url}`);
  const seed = await loadSeed(url, { userAgent });
  console.log(
    `[transitous] seed loaded: ${seed.routes.length} routes, ` +
    `${seed.stops.length} stops, ${seed.trips.length} trips`,
  );
  return { ...seed, source: url };
}

export const TRANSITOUS_SEED_URL = DEFAULT_SEED_URL;