/**
 * CTP CSV source — high-level entry point.
 *
 * Re-exports the public API. Consumers should import from this folder:
 *
 *   import { fetchCtpCsv, parseCtpCsv, buildCtpCsvUrl, ... } from '../sources/ctp-csv/index.ts';
 *
 * For tests, swap the client by importing `./client.js` directly and
 * feeding raw CSV bodies into `./parser.js`.
 */

export {
  // client
  fetchCtpCsv,
  fetchAllCsvSchedules,
  buildCtpCsvUrl,
  normalizeShortNameForCtpUrl,
  canonicalShortName,
  CSV_BASE_URL,
  CSV_SERVICE_KEYS,
  CSV_SERVICE_ID_MAP,
  // aliases (re-exported so smoke/build can debug 404s by checking the map)
  TRANZY_TO_CTP_SHORTNAME,
  // parser (re-exported for convenience)
  parseCtpCsv,
  classifyCell,
} from './client.ts';