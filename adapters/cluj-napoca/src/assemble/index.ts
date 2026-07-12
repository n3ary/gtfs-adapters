// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Assembler orchestrator. Pulls the three sources together into the
 * final in-memory GTFS structure, ready for the zip writer.
 *
 * Pipeline:
 *   1. seedPatterns  (src/sources/transitous/index.js)
 *   2. tranzyPatterns (this module's Tranzy-pattern extraction)
 *   3. routes        (src/assemble/merge/routes.js)
 *   4. stops         (src/assemble/merge/stops.js)
 *   5. shapes        (src/assemble/merge/shapes.js)
 *   6. trips+stop_times  (src/assemble/emit/trips.js)
 *   7. calendar      (src/assemble/derive/calendar.js)
 *   8. data quality  (src/assemble/check/data-quality.js)
 *
 * Returns everything the zip writer needs in `src/gtfs.js`.
 */

import { reconcileRoutes, routesToTxt } from './merge/routes.ts';
import { reconcileStops, stopsToTxt } from './merge/stops.ts';
import { reconcileShapes, shapesToTxt } from './merge/shapes.ts';
import { reconcileTripsAndStopTimes, tripsToTxt, stopTimesToTxt } from './emit/trips.ts';
import { reconcileFrequencies, frequenciesToTxt } from './derive/frequencies.ts';
import { reconcileCalendar, calendarToTxt } from './derive/calendar.ts';
import { runDataQualityChecks } from './check/data-quality.ts';
import { tranzyPatternsByRouteDir, seedPatternsByRouteDir } from './derive/patterns.ts';
import { reconcileTranzyFallback } from './emit/tranzy-fallback.ts';
import { buildNetworks, formatNetworkUsageSummary } from './emit/networks.ts';
import { applyRouteCategory } from './merge/routeCategory.ts';
import { warnMsg, info } from '../lib/log-severity.ts';

/**
 * @param {{
 *   seed: { agencyTxt: string, routes: any[], stops: any[], trips: any[], stopTimes: Map<string, any>, shapesById: Map<string, any> },
 *   tranzy: { routes: any[], stops: any[], trips: any[], shapes: any[], stop_times: any[] } | null,
 *   csv: { byRouteService: Map<string, Map<string, any>>, warnings: string[] },
 *   options?: { calendarDays?: number, buildDate?: Date, timing?: object },
 * }} input
 * @returns {{
 *   files: {
 *     'agency.txt': string,
 *     'routes.txt': string,
 *     'stops.txt': string,
 *     'shapes.txt': string,
 *     'trips.txt': string,
 *     'stop_times.txt': string,
 *     'calendar.txt': string,
 *     'feed_info.txt': string,
 *   },
 *   warnings: string[],
 *   stats: object,
 * }}
 */
export async function reconcile({ seed, tranzy, csv, options = {} }) {
  const warnings = [];

  const { routes, byRouteId: routesByRouteId } = reconcileRoutes({ seed, tranzy, warnings });
  const { stops, byStopId: stopsByStopId, transitousToTranzy } = reconcileStops({ seed, tranzy, warnings });
  const { shapesById, rows: shapeRows } = reconcileShapes({ seed, tranzy, warnings });
  const seedPatterns = extractSeedPatterns(seed);
  const tranzyPatterns = tranzyPatternsByRouteDir(tranzy);
  const { tripRows, stopTimeRows, tripDiagnostics } = reconcileTripsAndStopTimes({
    byRouteService: csv.byRouteService,
    routesByRouteId,
    stopsByStopId,
    transitousToTranzy,
    seedPatterns,
    tranzyPatterns,
    shapesById,
    warnings,
    timing: options.timing,
  });

  // Frequencies — implements #15 fix for CSV annotations like "05:05-22:40"
  // and "10-20min". Emits anchor trips + frequencies.txt rows.
  const {
    tripRows: freqTripRows,
    stopTimeRows: freqStopTimeRows,
    frequencyRows,
  } = reconcileFrequencies({
    byRouteService: csv.byRouteService,
    routesByRouteId,
    stopsByStopId,
    seedPatterns,
    tranzyPatterns,
    shapesById,
    warnings,
    timing: options.timing,
  });

  // Tranzy /trips fallback — for routes with no CSV coverage at all
  // (typically the 60 Tranzy-only metropolitan lines that CTP doesn't
  // publish CSVs for). Emits trip rows with empty times + timepoint=0
  // so consumers see "this route exists with these trips" instead of
  // "no service". See `src/assemble/emit/tranzy-fallback.js` for rationale.
  const { tripRows: fallbackTripRows, stopTimeRows: fallbackStopTimeRows } =
    reconcileTranzyFallback({
      tranzy,
      routesByRouteId,
      byRouteService: csv.byRouteService,
      stopsByStopId,
      warnings,
    });

  // Calendar: derive from service_ids we actually generated trips for.
  const serviceIds = new Set([
    ...tripRows.map((t) => t.service_id),
    ...fallbackTripRows.map((t) => t.service_id),
  ]);
  const { rows: calendarRows, unknownServiceIds } = reconcileCalendar({
    serviceIds,
    daysAhead: options.calendarDays ?? 180,
    buildDate: options.buildDate ?? new Date(),
  });
  if (unknownServiceIds.length > 0) {
    warnings.push(warnMsg(`Unknown service_ids encountered: ${unknownServiceIds.join(', ')}`));
  }
  // (Was: emitted unconditionally even when empty, leaving a trailing
  // colon in the build log. Now guarded by the length check above.)

  // Trip count per route (for data-quality check + phantom-route filter).
  // Counts across all three trip sources — CSV-driven, frequency-anchor,
  // and Tranzy /trips fallback — so phantom detection isn't fooled by
  // routes that only have Tranzy fallback rows.
  const tripCountByRouteId = new Map();
  for (const t of [...tripRows, ...freqTripRows, ...fallbackTripRows]) {
    tripCountByRouteId.set(t.route_id, (tripCountByRouteId.get(t.route_id) ?? 0) + 1);
  }

  // Drop phantom routes. These are routes that appear in Tranzy's
  // /routes catalog but have zero trips across all three sources — i.e.
  // no CSV timetable, no frequency-anchor CSV, and no Tranzy /trips or
  // /stop_times entries to back them up. Without trips, the route is
  // useless to consumers (the Tranzy-fallback comment in
  // `tranzy-fallback.js` already explains why we emit fallback rows for
  // routes that DO have Tranzy trip data). Surfacing these as a WARN so
  // the build log catches new phantom entries from Tranzy catalog drift
  // instead of silently publishing hollow rows.
  const phantomRoutes = routes.filter((r) => !tripCountByRouteId.has(r.route_id));
  if (phantomRoutes.length > 0) {
    for (const phantom of phantomRoutes) {
      routesByRouteId.delete(phantom.route_id);
    }
    const phantomDetails = phantomRoutes
      .map((r) => `${r.route_short_name || '(unnamed)'} (route_id=${r.route_id})`)
      .join(', ');
    warnings.push(warnMsg(
      `routes: ${phantomRoutes.length} phantom route(s) dropped ` +
      `(in Tranzy /routes but no trips anywhere) — ${phantomDetails}`,
    ));
  }
  // Rebuild the in-memory routes array excluding phantoms. Mutating in
  // place keeps downstream `routesToTxt(routes)` and `stats.routes`
  // referring to the same list.
  if (phantomRoutes.length > 0) {
    routes.length = 0;
    routes.push(...routesByRouteId.values());
  }

  const agencyTxt = ensureAgencyTimezone(seed.agencyTxt, options.timezone ?? 'Europe/Bucharest');
  const allTripRows = [...tripRows, ...freqTripRows, ...fallbackTripRows];
  const allStopTimeRows = [...stopTimeRows, ...freqStopTimeRows, ...fallbackStopTimeRows];

  // Route category classification + `route_long_name` cleanup + stop_times
  // fallback. Runs AFTER phantom filtering (so we don't classify routes
  // we're about to drop) and AFTER trip generation (so the stop_times
  // fallback in `routeCategory.js` has the data it needs). See
  // `src/assemble/merge/routeCategory.js` for the pattern table and
  // `deriveLongNameFromStops()` for the fallback logic.
  const tripToRoute = new Map();
  for (const t of allTripRows) tripToRoute.set(String(t.trip_id), String(t.route_id));
  // Route taxonomy classification (per gtfs-adapters#26):
  //   - `routeNetworks` -- Map<route_id, {id, label}> for the
  //     `networks.txt` + `route_networks.txt` 1:1 surface. Exactly
  //     one entry per route: `school` (TE* short_name) or `normal`
  //     (everything else).
  //   - `routeTags` -- Map<route_id, [{id, label, priority}]> for
  //     the `route_desc` comma-joined label list. The 1:many surface
  //     (a route can carry multiple tags).
  // The orchestrator consumes the maps directly; no `route_desc`
  // roundtrip needed.
  const { routeNetworks, networkCounts } = applyRouteCategory({
    routes,
    allStopTimeRows,
    tripToRoute,
    stopsByStopId,
    warnings,
  });

  // Data-quality checks (now sees classified routes).
  runDataQualityChecks({
    agencyTxt: seed.agencyTxt,
    routes,
    csvByRoute: csv.byRouteService,
    tripCountByRouteId,
    warnings,
  });

  // Networks + route_networks — derived from the structured
  // `routeNetworks` map that `applyRouteCategory` just populated.
  // See `src/assemble/emit/networks.js` for emission rules.
  const { networksTxt, routeNetworksTxt, networkUsage } = buildNetworks(routes, routeNetworks);
  if (networkUsage.size > 0) {
    warnings.push(info(`networks: ${formatNetworkUsageSummary(networkUsage)}`));
  }

  // All `*ToTxt` writers are async since they go through the spec's
  // serializeRows helper (which dynamic-imports csv-stringify/sync).
  // Promise.all keeps the writes concurrent — each writer hits a
  // tiny csv-stringify import that's cached after the first call,
  // so the dynamic-import overhead is amortised across all 6.
  const files = {
    'agency.txt': agencyTxt,
    'routes.txt': await routesToTxt(routes),
    'stops.txt': await stopsToTxt(stops),
    'shapes.txt': shapeRows.length === 0 ? '' : await shapesToTxt(shapeRows),
    'trips.txt': await tripsToTxt(allTripRows),
    'stop_times.txt': await stopTimesToTxt(allStopTimeRows),
    'calendar.txt': await calendarToTxt(calendarRows),
    'frequencies.txt': await frequenciesToTxt(frequencyRows),
    'networks.txt': networksTxt,
    'route_networks.txt': routeNetworksTxt,
    'feed_info.txt': feedInfoTxt({
      buildDate: options.buildDate ?? new Date(),
      startDate: calendarRows[0]?.start_date,
      endDate: calendarRows[0]?.end_date,
    }),
  };

  // Drop empty optional files.
  for (const [k, v] of Object.entries(files)) {
    if (!v) delete files[k];
  }

  const stats = {
    routes: routes.length,
    stops: stops.length,
    shapes: shapeRows.length === 0 ? 0 : new Set(shapeRows.map((r) => r.shape_id)).size,
    trips: allTripRows.length,
    stopTimes: allStopTimeRows.length,
    frequencyAnchors: frequencyRows.length,
    calendarServices: calendarRows.length,
    networks: networkUsage.size,
    tripDiagnostics,
  };

  return { files, warnings, stats };
}

function extractSeedPatterns(seed) {
  // Re-export the canonical seed-pattern builder from `patterns.js`
  // (single source of truth — see `src/assemble/derive/patterns.js
  // seedPatternsByRouteDir` for the implementation). Both this alias
  // and `patterns.js` use the same function so URL/option conventions
  // can't drift.
  return seedPatternsByRouteDir(seed);
}

function ensureAgencyTimezone(seedAgencyTxt, tz) {
  // If the seed has an agency_timezone column, override to our config value.
  // GTFS agency.txt header: agency_id,agency_name,agency_url,agency_timezone,...
  const lines = seedAgencyTxt.split(/\r?\n/);
  if (lines.length < 2) return seedAgencyTxt;
  const header = lines[0].split(',').map((h) => h.trim());
  const tzIdx = header.indexOf('agency_timezone');
  if (tzIdx === -1) return seedAgencyTxt;
  // Filter out blank lines (the seed CSV almost always ends with a
  // trailing \n, which splits to an empty string at lines[lines.length-1]).
  // Without this, the empty line gets padded with empty cells up to
  // `header.length`, then has agency_timezone overwritten — yielding a
  // row like `,,,Europe/Bucharest,,,` that SQLite's NOT NULL +
  // PRIMARY KEY on agency_id would reject. The PR #84 hardening in
  // the orchestrator (CHECK + FK constraints, hard-fail INSERT) makes
  // this bug loud; before that, INSERT OR IGNORE silently dropped it.
  const dataLines = lines.slice(1)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cols = line.split(',');
      while (cols.length < header.length) cols.push('');
      cols[tzIdx] = tz;
      return cols.join(',');
    });
  return [lines[0], ...dataLines].join('\n');
}

function feedInfoTxt({ buildDate, startDate, endDate }) {
  const yyyymmdd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const version = yyyymmdd(buildDate);
  return [
    'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version',
    `cluj-napoca-gtfs-adapter,https://github.com/n3ary/gtfs-adapters/tree/main/adapters/cluj-napoca,ro,${startDate ?? version},${endDate ?? version},${version}`,
  ].join('\n') + '\n';
}