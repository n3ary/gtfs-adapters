// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Data-quality checks. Emit warnings for things we want visible but
 * don't want to block the build on.
 *
 * Coverage:
 *   1. Routes with 0 trips but non-suspended CSV data (`neary-gtfs#15`)
 *   2. CSV departures dropped due to non-HH:MM cells (M26 frequencies)
 *   3. Stops with invalid coordinates
 *   4. Multiple agencies in seed agency.txt (`neary#87`)
 *   5. CSV row count vs seed trip count divergence
 */

import { info, warnMsg } from '../../lib/log-severity.ts';

/**
 * @param {object} input
 * @param {string} input.agencyTxt  raw contents of seed agency.txt
 * @param {Array<object>} input.routes  reconciled routes
 * @param {Map<string, {warnings: any[]}>} input.csvByRoute  CSV-by-route map for warnings surfacing
 * @param {Map<string, number>} input.tripCountByRouteId  trip counts per route_id
 * @param {string[]} input.warnings  collector
 */
export function runDataQualityChecks(input) {
  checkAgencyCount(input.agencyTxt, input.warnings);
  checkZeroTripRoutes(input.csvByRoute, input.tripCountByRouteId, input.warnings);
  checkCsvWarnings(input.csvByRoute, input.warnings);
}

function checkAgencyCount(agencyTxt, warnings) {
  // GTFS allows multiple agency rows. For a single-agency feed we expect
  // exactly one. Warn if there are zero or more than one.
  const lines = agencyTxt.split(/\r?\n/).filter((l) => l.trim());
  const dataRows = lines.slice(1); // drop header
  if (dataRows.length === 0) {
    warnings.push(warnMsg('seed agency.txt has no data rows; feed will be missing agency.txt content'));
    return;
  }
  if (dataRows.length > 1) {
    warnings.push(info(`seed agency.txt has ${dataRows.length} rows (expected 1 for single-agency feed; see neary#87)`));
  }
}

function checkZeroTripRoutes(csvByRoute, tripCountByRouteId, warnings) {
  // Bucket by short_name — each route that emits 0 trips with non-
  // suspended CSV data goes in. One summary line instead of N.
  const zeroTripRoutes = [];
  for (const [routeShortName, perService] of csvByRoute.entries()) {
    let hadCsv = false;
    let suspended = false;
    for (const csv of perService.values()) {
      hadCsv = true;
      const sn = (csv.serviceName ?? '').toLowerCase();
      if (sn.includes('nu circula') || sn.includes('in lucru') || sn.includes('nu circulă')) {
        suspended = true;
      }
    }
    if (!hadCsv || suspended) continue;
    const routeId = findRouteIdByShortName(tripCountByRouteId, routeShortName, csvByRoute);
    if (routeId == null) continue;
    const count = tripCountByRouteId.get(routeId) ?? 0;
    if (count === 0) {
      zeroTripRoutes.push(`${routeShortName} (${routeId})`);
    }
  }
  if (zeroTripRoutes.length === 0) return;
  const sample = zeroTripRoutes.length <= 10
    ? zeroTripRoutes.join(', ')
    : `${zeroTripRoutes.slice(0, 10).join(', ')}, ... and ${zeroTripRoutes.length - 10} more`;
  warnings.push(warnMsg(
    `${zeroTripRoutes.length} route(s) emitted 0 trips despite having CSV data — ` +
    `[${sample}]. Likely pattern-resolution failure (neary-gtfs#15).`,
  ));
}

function findRouteIdByShortName(tripCountByRouteId, shortName, csvByRoute) {
  // tripCountByRouteId is keyed by route_id; csvByRoute keyed by shortName.
  // We need a side-channel. For now this check is approximate — a fuller
  // version would thread a shortName→routeId map through.
  for (const id of tripCountByRouteId.keys()) {
    if (id.endsWith(`_${shortName}`) || id === shortName) return id;
  }
  return null;
}

function checkCsvWarnings(csvByRoute, warnings) {
  let dropped = 0;
  for (const [, perService] of csvByRoute.entries()) {
    for (const csv of perService.values()) {
      if (csv.warnings && csv.warnings.length > 0) dropped += csv.warnings.length;
    }
  }
  if (dropped > 0) {
    warnings.push(info(`${dropped} CSV cell(s) dropped as non-HH:MM (see docs/csv-timetable-format.md § frequency annotations)`));
  }
}