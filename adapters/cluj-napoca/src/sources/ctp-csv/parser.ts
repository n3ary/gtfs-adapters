// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * CTP CSV timetable parser.
 *
 * Pure CSV → CtpCsvSchedule conversion. No network. No filesystem.
 * Easy to unit-test by passing in fixture CSV bodies.
 *
 * CTP CSV format (5 metadata rows then `HH:MM,HH:MM` data):
 *   row 0: route_long_name,"..."
 *   row 1: service_name,"..."
 *   row 2: service_start,"..."
 *   row 3: in_stop_name,"..."
 *   row 4: out_stop_name,"..."
 *   row 5+: HH:MM,HH:MM   (one row per departure-pair, 2 cols = 2 dirs)
 *
 * Cells can be:
 *   - HH:MM (specific time) — emit as departure
 *   - *HH:MM, HH:MM*, **HH:MM (annotations) — emit as departure, preserve marker
 *   - HH:MM-HH:MM (range) — frequency annotation, NOT a departure
 *   - 10-20min / 10-20 / 10min (headway) — frequency annotation, NOT a departure
 *   - "Nu circulă" / "In lucru" / "Suspendat" — suspended cell, NOT a departure
 *   - unknown — emit as warning so #15 fix can extend classifyCell()
 */

/**
 * @typedef {{
 *   routeLongName: string,
 *   serviceName: string,
 *   serviceStart: string,
 *   inStopName: string,
 *   outStopName: string,
 *   departures: { dir0: string[], dir1: string[] },
 *   frequencyAnnotations: {
 *     dir0: { ranges: Array<{start: string, end: string}>, headways: Array<{minSec: number, maxSec: number|null, avgSec: number}> },
 *     dir1: { ranges: Array<{start: string, end: string}>, headways: Array<{minSec: number, maxSec: number|null, avgSec: number}> },
 *   },
 *   suspended: Array<{col: number, reason: string}>,
 *   annotations: Array<{col: number, value: string, time: string, annotation: string}>,
 *   suspendedAllCells: boolean,
 *   warnings: Array<{row: number, col: number, value: string, reason: string}>,
 * }} CtpCsvSchedule
 */

/**
 * @param {string} text  raw CSV body
 * @returns {CtpCsvSchedule | null}
 */
export function parseCtpCsv(text) {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter((l) => l);
  if (lines.length < 6) return null;
  const routeLongName = lines[0].split(',').slice(1).join(',').replace(/"/g, '');
  const serviceName = lines[1].split(',').slice(1).join(',').replace(/"/g, '');
  const serviceStart = lines[2].split(',').slice(1).join(',').replace(/"/g, '');
  const inStopName = lines[3].split(',').slice(1).join(',').replace(/"/g, '');
  const outStopName = lines[4].split(',').slice(1).join(',').replace(/"/g, '');

  /** @type {{dir0: string[], dir1: string[]}} */
  const departures = { dir0: [], dir1: [] };
  const frequencyAnnotations = {
    dir0: { ranges: [], headways: [] },
    dir1: { ranges: [], headways: [] },
  };
  /** @type {Array<{row: number, col: number, value: string, reason: string}>} */
  const warnings = [];
  /** @type {Array<{col: number, reason: string}>} */
  const suspended = [];
  /** @type {Array<{col: number, value: string, time: string, annotation: string}>} */
  const annotations = [];
  let suspendedAllCells = false;

  for (let i = 5; i < lines.length; i++) {
    const parts = lines[i].split(',').map((p) => p.trim());
    for (const [colIdx, colKey] of [[0, 'dir0'], [1, 'dir1']]) {
      const cell = parts[colIdx];
      if (!cell) continue;
      const cls = classifyCell(cell);
      if (cls.type === 'time') {
        departures[colKey].push(cls.value);
        // Surface operator-specific annotations (`*`/`**`) for build-log
        // visibility. The trip is still emitted — see classifyCell comment
        // for why we keep these runs in the schedule.
        if (cls.annotation) {
          annotations.push({ col: colIdx, value: cell, time: cls.value, annotation: cls.annotation });
        }
      } else if (cls.type === 'range') {
        frequencyAnnotations[colKey].ranges.push({ start: cls.start, end: cls.end });
      } else if (cls.type === 'headway') {
        frequencyAnnotations[colKey].headways.push({
          minSec: cls.minSec,
          maxSec: cls.maxSec,
          avgSec: cls.avgSec,
        });
      } else if (cls.type === 'suspended') {
        suspended.push({ col: colIdx, reason: cls.reason });
      } else {
        warnings.push({
          row: i,
          col: colIdx,
          value: cell,
          reason: 'unrecognized cell format (neither HH:MM, range, nor headway)',
        });
      }
    }
  }
  fixPostMidnight(departures.dir0);
  fixPostMidnight(departures.dir1);

  // If EVERY non-empty cell was suspended, the route doesn't run at all
  // that service day. Flag it so downstream code can skip without
  // emitting "0 trips" warnings.
  const totalNonEmpty =
    departures.dir0.length + departures.dir1.length +
    frequencyAnnotations.dir0.ranges.length + frequencyAnnotations.dir0.headways.length +
    frequencyAnnotations.dir1.ranges.length + frequencyAnnotations.dir1.headways.length +
    suspended.length + annotations.length;
  if (totalNonEmpty > 0 && suspended.length === totalNonEmpty) {
    suspendedAllCells = true;
  }

  return {
    routeLongName, serviceName, serviceStart,
    inStopName, outStopName,
    departures, frequencyAnnotations,
    suspended,
    annotations,
    suspendedAllCells,
    warnings,
  };
}

/**
 * Classify a single CSV cell value.
 * @param {string} value
 * @returns {{type: 'time', value: string, annotation?: string}
 *           | {type: 'range', start: string, end: string}
 *           | {type: 'headway', minSec: number, maxSec: number|null, avgSec: number}
 *           | {type: 'suspended', reason: string}
 *           | {type: 'unknown'}}
 */
export function classifyCell(value) {
  // Asterisk annotations on times: `*HH:MM`, `HH:MM*`, `HH:MM**`. CTP
  // uses these as route-specific annotations whose meaning is documented
  // per-line on the HTML legend page — verified examples (2026-06-29):
  //   M23 LV: `*04:40`, `*22:30`         → shared-run with M81 (the bus
  //                                        at M23's terminal is registered
  //                                        as M81, not M23)
  //   M23 S:  `*22:25`, `22:50*`         → shared-run with M22
  //   M39 S:  `*07:25`, `*14:30`         → trip extends past terminus
  //                                        to Sânmartin (M39 stops earlier)
  //          `07:55**`                    → trip skips the Cluj Due segment
  //
  // We keep these trips in the schedule — they're part of the operator's
  // published timetable, so passengers see them as scheduled runs. In the
  // neary PWA the live GPS lookup simply won't match (the physical vehicle
  // is registered under a different route_id), which is fine: users see
  // the scheduled time and the "no live GPS" indicator. The annotation is
  // preserved on the returned object so the parser can surface it in the
  // build log without polluting the smoke test's unrecognized-cell count.
  const annMatch = value.toString().match(/^\*+|\*+$/g);
  if (annMatch) {
    const stripped = value.toString().replace(/^\*+|\*+$/g, '');
    if (/^\d{1,2}:\d{2}$/.test(stripped)) {
      return { type: 'time', value: stripped, annotation: annMatch.join('') };
    }
  }
  // Specific time: HH:MM
  if (/^\d{1,2}:\d{2}$/.test(value)) {
    return { type: 'time', value };
  }
  // Range: HH:MM-HH:MM  (e.g. "05:05-22:40")
  const rangeMatch = value.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (rangeMatch) {
    return { type: 'range', start: rangeMatch[1], end: rangeMatch[2] };
  }
  // Headway with range: "10-20min", "5min", "30-40min", "10-20"
  const rangeMinMatch = value.match(/^(\d{1,2})-(\d{1,2})min$/);
  if (rangeMinMatch) {
    const lo = parseInt(rangeMinMatch[1], 10);
    const hi = parseInt(rangeMinMatch[2], 10);
    return { type: 'headway', minSec: lo * 60, maxSec: hi * 60, avgSec: Math.round((lo + hi) / 2 * 60) };
  }
  const singleMinMatch = value.match(/^(\d{1,2})min$/);
  if (singleMinMatch) {
    const lo = parseInt(singleMinMatch[1], 10);
    return { type: 'headway', minSec: lo * 60, maxSec: null, avgSec: lo * 60 };
  }
  const rangeNoUnit = value.match(/^(\d{1,2})-(\d{1,2})$/);
  if (rangeNoUnit) {
    const lo = parseInt(rangeNoUnit[1], 10);
    const hi = parseInt(rangeNoUnit[2], 10);
    // Plausibility guard: minutes go up to ~120. Anything above is suspicious.
    if (lo <= 120 && hi <= 120 && lo < hi) {
      return { type: 'headway', minSec: lo * 60, maxSec: hi * 60, avgSec: Math.round((lo + hi) / 2 * 60) };
    }
  }
  // Suspended / not running — Romanian operators use various markers. The
  // CSV publishes these as cell content when a route (or direction) doesn't
  // run that service day. Per neary-gtfs#1 taxonomy: school transport
  // (off-season), night routes (different naming), suspended routes
  // (CTP-published), and seasonal/event routes all publish cells like
  // these. Treat as a known skip — emit a soft warning, NOT a parse error.
  const trimmed = value.toString().trim();
  if (/^(nu circul[ăa]|in lucru|suspendat|suspended|nu functioneaza|nu merge)$/i.test(trimmed)) {
    return { type: 'suspended', reason: trimmed };
  }
  return { type: 'unknown' };
}

/**
 * Rewrite post-midnight times as HH+24 so they're monotonically
 * increasing within a single service day.
 *
 * Two cases:
 *   - Sequence has at least one late-evening time (>= 20:00) and a
 *     subsequent jump back: wrap the post-midnight entries.
 *     e.g. `[..., 23:55, 00:20, 00:45]` → `[..., 23:55, 24:20, 24:45]`
 *   - Entire sequence is early morning (max < 04:00): assume all entries
 *     are post-midnight of the previous day, wrap them all.
 *     e.g. `[00:20, 00:45]` → `[24:20, 24:45]`
 *
 * The `prevMinutes > 20 * 60` (20:00) guard in the first case prevents
 * the wrap from triggering when the operator genuinely has a backwards
 * jump in the schedule (rare but possible — early-morning routes with
 * intentional ordering changes).
 */
function fixPostMidnight(times) {
  if (times.length === 0) return;
  // Find the max time. If it's in the early morning (< 04:00), the entire
  // list is post-midnight.
  let maxMin = -1;
  for (const t of times) {
    const [h, m] = t.split(':').map(Number);
    const min = h * 60 + m;
    if (min > maxMin) maxMin = min;
  }
  if (maxMin < 4 * 60) {
    for (let i = 0; i < times.length; i++) {
      const [h, m] = times[i].split(':').map(Number);
      times[i] = `${h + 24}:${String(m).padStart(2, '0')}`;
    }
    return;
  }
  // Otherwise, wrap any backward jump from a late-evening time.
  let prevMinutes = -1;
  for (let i = 0; i < times.length; i++) {
    const [h, m] = times[i].split(':').map(Number);
    const minutes = h * 60 + m;
    if (minutes < prevMinutes && prevMinutes > 20 * 60) {
      times[i] = `${h + 24}:${String(m).padStart(2, '0')}`;
    }
    const [effH, effM] = times[i].split(':').map(Number);
    prevMinutes = effH * 60 + effM;
  }
}