// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).

import { type StopTimeRow, type ShapeRow, FrequenciesRowSchema, serializeRows } from '@n3ary/gtfs-spec/spec';

// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Frequencies reconciliation — implements the v0.1 fix for `neary-gtfs#15`.
 *
 * When a CTP CSV cell carries a frequency annotation (e.g. "05:05-22:40"
 * for an operating-hours range, or "10-20min" for a headway range), we
 * emit a `frequencies.txt` row that schedules a synthetic "anchor trip"
 * to run repeatedly throughout the window. The anchor trip carries the
 * pattern's stop sequence (so consumers can render the route geometry),
 * and the frequencies.txt row tells them how often it runs.
 *
 * Trip-id format: `${route_id}_${dir}_${serviceId}_FREQ_${HHMM_START}`
 * The `_FREQ_` marker is the convention — distinct from regular trip
 * ids (which encode the dep time). The `HHMM_START` is the start
 * of the operating window without colons, so a M26 dir0 LV anchor that
 * starts at 05:05 is `M26_0_LV_FREQ_0505`.
 *
 * The window comes from range annotations (earliest start, latest end).
 * The headway comes from headway annotations (averaged across all
 * mentions). If only one of the two is present we fall back to a default
 * (`05:00–23:00` window or `15 min` headway respectively) and emit a
 * warning.
 */

import { computeStopTimes } from '../../lib/timing.ts';
import { info, warnMsg } from '../../lib/log-severity.ts';
import { canonicalShortName } from '../../sources/ctp-csv/shortname-aliases.ts';

const DEFAULT_WINDOW = { start: '05:00', end: '23:00' };
const DEFAULT_HEADWAY_SEC = 900; // 15 min — urban bus default

const DEFAULT_TIMING = {
  speedKmh: { peak: 14, offpeak: 22, night: 28 },
  peakWindows: [
    { from: '07:00', to: '09:30' },
    { from: '16:00', to: '19:00' },
  ],
  nightWindow: { from: '22:30', to: '05:30' },
  intermediateDwellSec: 20,
};

/**
 * @param {{
 *   byRouteService: Map<string, Map<string, {
 *     departures: { dir0: string[], dir1: string[] },
 *     frequencyAnnotations: {
 *       dir0: { ranges: Array<{start, end}>, headways: Array<{minSec, maxSec, avgSec}> },
 *       dir1: { ranges: Array<{start, end}>, headways: Array<{minSec, maxSec, avgSec}> },
 *     },
 *     inStopName: string,
 *     outStopName: string,
 *   }>>,
 *   routesByRouteId: Map<string, {route_id, route_short_name, route_long_name}>,
 *   stopsByStopId: Map<string, {stop_id, stop_lat, stop_lon, stop_name}>,
 *   seedPatterns: Map<string, {stops, shapeId, headsign, source}>,
 *   tranzyPatterns: Map<string, {stops, shapeId, headsign, source}>,
 *   shapesById: Map<string, ShapeRow[]>,
 *   warnings: string[],
 *   timing?: typeof DEFAULT_TIMING,
 * }} input
 * @returns {{
 *   tripRows: Array<{route_id, service_id, trip_id, trip_headsign, direction_id, shape_id}>,
 *   stopTimeRows: Array<Pick<StopTimeRow, 'trip_id' | 'arrival_time' | 'departure_time' | 'stop_id' | 'stop_sequence' | 'shape_dist_traveled'>>,
 *   frequencyRows: Array<{trip_id, start_time, end_time, headway_secs, exact_times}>,
 * }}
 */
export function reconcileFrequencies(input) {
  const timing = input.timing ?? DEFAULT_TIMING;
  const tripRows = [];
  const stopTimeRows = [];
  const frequencyRows = [];

  for (const [routeShortName, byService] of input.byRouteService.entries()) {
    const routeRow = findRouteByShortName(input.routesByRouteId, routeShortName);
    if (!routeRow) continue;
    const routeId = routeRow.route_id;

    for (const [serviceId, csv] of byService.entries()) {
      for (const dir of [0, 1]) {
        const ann = dir === 0 ? csv.frequencyAnnotations.dir0 : csv.frequencyAnnotations.dir1;
        if (!ann) continue;
        if (ann.ranges.length === 0 && ann.headways.length === 0) continue;

        // 1. Derive the operating window (use ranges, fallback to default).
        const window = deriveWindow(ann.ranges, routeShortName, dir, serviceId, input.warnings);
        // 2. Derive the headway (use headways, fallback to default).
        const headway = deriveHeadway(ann.headways, routeShortName, dir, serviceId, input.warnings);
        if (!window || !headway) continue;

        // 3. Resolve the pattern (seed → Tranzy fallback).
        const key = `${routeId}|${dir}`;
        const pattern = input.seedPatterns.get(key) ?? input.tranzyPatterns.get(key);
        if (!pattern || pattern.stops.length === 0) {
          input.warnings.push(warnMsg(`frequency anchor skipped: ${routeShortName} dir=${dir} ${serviceId} — no pattern`));
          continue;
        }

        // 4. Build the anchor trip.
        const orderedStops = pattern.stops
          .map((s) => {
            const stop = input.stopsByStopId.get(s.stopId);
            if (!stop) return null;
            const lat = parseFloat(stop.stop_lat);
            const lon = parseFloat(stop.stop_lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
            // Preserve the upstream's stop_sequence — see trips.js for
            // why we don't re-number with a sequential index.
            return { stopId: stop.stop_id, sequence: s.sequence, lat, lon, name: stop.stop_name };
          })
          .filter(Boolean);
        if (orderedStops.length === 0) {
          input.warnings.push(warnMsg(`frequency anchor skipped: ${routeShortName} dir=${dir} — stops missing coords`));
          continue;
        }
        const shape = (pattern.shapeId && input.shapesById.get(pattern.shapeId)) || [];
        const headsign = pattern.headsign
          || (dir === 0 ? csv.outStopName : csv.inStopName)
          || routeRow.route_long_name
          || routeShortName;

        const anchorTripId = `${routeId}_${dir}_${serviceId}_FREQ_${window.start.replace(':', '')}`;
        const shapeId = pattern.shapeId || `${routeId}_${dir}`;
        tripRows.push({
          route_id: routeId,
          service_id: serviceId,
          trip_id: anchorTripId,
          trip_headsign: headsign,
          direction_id: String(dir),
          shape_id: shapeId,
        });

        // 5. Anchor stop_times at start of window.
        const startSec = window.startSec;
        const { arrivals, departures: stopDeps, shapeDistTraveledM } = computeStopTimes({
          startSec,
          stops: orderedStops,
          shape,
          timing,
        });
        for (let k = 0; k < orderedStops.length; k++) {
          stopTimeRows.push({
            trip_id: anchorTripId,
            arrival_time: formatTime(arrivals[k]),
            departure_time: formatTime(stopDeps[k]),
            stop_id: orderedStops[k].stopId,
            // Upstream's stop_sequence, not re-numbered — see trips.js.
            stop_sequence: String(orderedStops[k].sequence ?? k),
            shape_dist_traveled: shapeDistTraveledM[k] != null ? String(shapeDistTraveledM[k]) : '',
          });
        }

        // 6. frequencies.txt row.
        frequencyRows.push({
          trip_id: anchorTripId,
          start_time: formatTime(window.startSec),
          end_time: formatTime(window.endSec),
          headway_secs: String(headway.avgSec),
          exact_times: '0',
        });

        input.warnings.push(info(
          `frequency anchor: ${routeShortName} dir=${dir} ${serviceId} ${window.start}-${window.end} every ${(headway.avgSec / 60).toFixed(0)}min (avg)`,
        ));
      }
    }
  }

  return { tripRows, stopTimeRows, frequencyRows };
}

function deriveWindow(ranges, routeShortName, dir, serviceId, warnings) {
  if (ranges.length === 0) {
    warnings.push(info(`frequency anchor ${routeShortName} dir=${dir} ${serviceId}: no range, using default ${DEFAULT_WINDOW.start}-${DEFAULT_WINDOW.end}`));
    return {
      start: DEFAULT_WINDOW.start,
      end: DEFAULT_WINDOW.end,
      startSec: hhmmToSeconds(DEFAULT_WINDOW.start),
      endSec: hhmmToSeconds(DEFAULT_WINDOW.end),
    };
  }
  let earliestStart = Infinity;
  let latestEnd = -Infinity;
  for (const r of ranges) {
    const startSec = hhmmToSeconds(r.start);
    const endSec = hhmmToSeconds(r.end);
    if (startSec < earliestStart) earliestStart = startSec;
    if (endSec > latestEnd) latestEnd = endSec;
  }
  return {
    start: secondsToHHMM(earliestStart),
    end: secondsToHHMM(latestEnd),
    startSec: earliestStart,
    endSec: latestEnd,
  };
}

function deriveHeadway(headways, routeShortName, dir, serviceId, warnings) {
  if (headways.length === 0) {
    warnings.push(info(`frequency anchor ${routeShortName} dir=${dir} ${serviceId}: no headway, using default ${DEFAULT_HEADWAY_SEC}s`));
    return { minSec: DEFAULT_HEADWAY_SEC, maxSec: DEFAULT_HEADWAY_SEC, avgSec: DEFAULT_HEADWAY_SEC };
  }
  let minSec = Infinity;
  let maxSec = -Infinity;
  for (const h of headways) {
    if (h.minSec < minSec) minSec = h.minSec;
    if (h.maxSec != null && h.maxSec > maxSec) maxSec = h.maxSec;
  }
  if (maxSec === -Infinity) maxSec = minSec;
  return { minSec, maxSec, avgSec: Math.round((minSec + maxSec) / 2) };
}

function hhmmToSeconds(hhmm) {
  const parts = hhmm.split(':').map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  return h * 3600 + m * 60;
}

function secondsToHHMM(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function findRouteByShortName(routesByRouteId, shortName) {
  // shortName is canonical (URL form); routes carry catalog-side names.
  // See the matching helper in src/assemble/emit/trips.js for the
  // rationale — single compare rule keeps CSV-IO keys in agreement.
  const target = canonicalShortName(shortName);
  for (const r of routesByRouteId.values()) {
    if (canonicalShortName(r.route_short_name) === target) return r;
  }
  return null;
}

export async function frequenciesToTxt(rows) {
  if (rows.length === 0) return '';
  // Spec-driven serializer — added @n3ary/gtfs-spec 0.4.0 to bring
  // frequencies.txt in line with the other writers. Column order
  // comes from `Object.keys(FrequenciesRowSchema.shape)`.
  return serializeRows(FrequenciesRowSchema, rows);
}