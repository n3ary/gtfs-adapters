// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
import { TripRowSchema, StopTimeRowSchema, ShapeRowSchema, serializeRows, type TripRow, type StopTimeRow, type ShapeRow } from '@n3ary/gtfs-spec/spec';
/**
 * Trips + stop_times reconciliation.
 *
 * For each CSV departure `HH:MM` on a `(route, dir, service)` pattern:
 *   1. Resolve the pattern (seed → Tranzy → null; see `patterns.js`)
 *   2. Generate a canonical CTP-format trip_id
 *   3. Emit trips.txt row
 *   4. For each stop in the pattern, call `computeStopTimes()` to get
 *      arrival/departure seconds, then emit stop_times.txt row.
 *
 * Trip ID format (canonical CTP — matches `cluj-rt-feed.gtfs.ro`):
 *   `${route_id}_${dir}_${serviceId}_${seq}_${HHMMDigits}`
 *   e.g. `45_1_LV_9_0721`  (route 45, dir 1, LV service, 9th departure, 07:21)
 */

import { computeStopTimes } from '../../lib/timing.ts';
import { info, warnMsg } from '../../lib/log-severity.ts';
import { canonicalShortName } from '../../sources/ctp-csv/shortname-aliases.ts';

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
 * @typedef {{
 *   byRouteService: Map<string, Map<string, {
 *     departures: { dir0: string[], dir1: string[] },
 *     inStopName: string,
 *     outStopName: string,
 *     routeLongName: string,
 *     warnings: any[],
 *   }>>,
 *   routesByRouteId: Map<string, Pick<TripRow, 'route_id' | 'route_short_name' | 'route_long_name'>>,
 *   stopsByStopId: Map<string, Pick<TripRow, 'stop_id' | 'stop_lat' | 'stop_lon' | 'stop_name'>>,
 *   seedPatterns: Map<string, { stops, shapeId, headsign, source }>,
 *   tranzyPatterns: Map<string, { stops, shapeId, headsign, source }>,
 *   shapesById: Map<string, ShapeRow[]>,
 *   warnings: string[],
 *   timing?: typeof DEFAULT_TIMING,
 * }} ReconcileTripsInput
 *
 * @typedef {{
 *   tripRows: Array<Pick<TripRow, 'route_id' | 'service_id' | 'trip_id' | 'trip_headsign' | 'direction_id' | 'shape_id'>>,
 *   stopTimeRows: Array<Pick<StopTimeRow, 'trip_id' | 'arrival_time' | 'departure_time' | 'stop_id' | 'stop_sequence' | 'shape_dist_traveled'>>,
 *   tripDiagnostics: Array<{route_id: string, direction_id: number, service_id: string, count: number, bucket: string, speed_kmh: number}>,
 * }} ReconcileTripsResult
 */
export function reconcileTripsAndStopTimes(input) {
  const timing = input.timing ?? DEFAULT_TIMING;
  const tripRows = [];
  const stopTimeRows = [];
  const tripDiagnostics = [];
  /** @type {string[]} */
  const localWarnings = [];

// Aggregate "no pattern" diagnostics by category for a single
  // summary line at the end of the build (instead of one line per
  // (route, dir, service-day) — that would be hundreds of lines for
  // the full network and drown the build log).
  // Also count fuzzy origin-matches for the build-log summary — high
  // numbers mean the upstream sources use different naming conventions
  // and we should ask the operators to align them.
  let fuzzyMatchCount = 0;
  let rewrittenLongNames = 0;
  const noPatternStats = {
    bothDirsTranzyMissing: new Set(),   // route: no pattern in Tranzy
    bothDirsSeedMissing: new Set(),     // route: Tranzy has, but seed missing
    bothDirsBothMissing: new Set(),     // route: both Tranzy and seed missing
    oneDirTranzyMissing: new Set(),     // route: 1 dir missing in Tranzy
    oneDirSeedMissing: new Set(),       // route: 1 dir missing in seed (Tranzy has it)
    oneDirBothMissing: new Set(),       // route: 1 dir missing in both
  };

  for (const [routeShortName, byService] of input.byRouteService.entries()) {
    // Find the route row matching this short name (CSV uses short name; rows use route_id).
    const routeRow = findRouteByShortName(input.routesByRouteId, routeShortName);
    if (!routeRow) {
      localWarnings.push(warnMsg(`CSV for route_short_name "${routeShortName}" but no route in seed/Tranzy; skipping`));
      continue;
    }
    const routeId = routeRow.route_id;

    // Headers (in/out_stop_name) are per-route, not per-service-day —
    // every CSV for the same route publishes the same two stop labels.
    // Pick the first non-empty CSV for the origin-validation pass so
    // we don't emit the warning once per service day (LV+S+D would
    // otherwise triple-print the same mismatch).
    let headersCsv = null;
    for (const csv of byService.values()) {
      if (csv) { headersCsv = csv; break; }
    }
    if (!headersCsv) continue;

    // Pre-compute the per-direction "plan" (pattern + orderedStops +
    // origin-validation result) ONCE, then reuse for every service day.
    // `plan[dir]` is null when the route has no pattern for that dir
    // (warnings are already emitted).
    //
    // Origin-validation tier (per CTP CSV convention):
    //   - in_stop_name  = origin of col 0 buses  = first stop of dir 0
    //   - out_stop_name = origin of col 1 buses  = first stop of dir 1
    //
    // Tiers (best → worst, same-direction match):
    //   1. exact-both : both directions exactly match. Silent.
    //   2. exact-one  : at least one exact, the other is fuzzy/no-match.
    //                   We know one direction's column is correct, so
    //                   we trust the convention for the other. Warn
    //                   but still use CSV labels.
    //   3. fuzzy-both : both directions fuzzy-match. Trust convention.
    //                   Warn but still use CSV labels.
    //   4. fuzzy-one  : only one direction fuzzy-matches. Heavier warn.
    //   5. no-match   : neither exact nor fuzzy match on either side.
    //                   Strongest warning — catalog and CSV are
    //                   disagreeing about the terminals entirely. Still
    //                   use the CSV (operator-published data wins for
    //                   trip times), but skip CSV labels as headsign
    //                   fallback since we can't trust them.
    //
    // Cross-direction tier (only triggered when same-direction tiers
    // 1-4 fail):
    //   5b. swap-detected : CSV's column-to-direction mapping is FLIPPED
    //                     relative to the catalog. CSV col 0 ("in_stop")
    //                     actually contains the origin of CATALOG dir 1
    //                     buses, and CSV col 1 ("out_stop") actually
    //                     contains the origin of CATALOG dir 0 buses.
    //
    //                     When detected, we emit trips with FLIPPED
    //                     direction_id (csv col 0 → physical dir 1, csv
    //                     col 1 → physical dir 0) so that each trip's
    //                     first stop in its pattern matches the CSV's
    //                     published origin label. The side-channel
    //                     warning carries `directionReversed: true` in
    //                     its meta so downstream consumers can flag the
    //                     route as having a non-canonical direction
    //                     mapping.
    //
    //                     Sub-tiers:
    //                       - swap-exact-both : both cross-pairs exact
    //                         (info — fully resolved)
    //                       - swap-fuzzy-both : both cross-pairs fuzzy
    //                         (warn — names differ in spelling)
    //                       - swap-partial    : one cross-pair exact,
    //                         the other fuzzy or no-match (warn)
    //
    // The tier is per-(route, dir) but we emit ONE summary warning
    // per route (not per service-day × per direction) so the build
    // log stays readable.
    const inLabel = headersCsv.inStopName;
    const outLabel = headersCsv.outStopName;
    const dir0FirstStop = null; // will be filled when plan[0] resolves
    const dir1FirstStop = null;
    /** @type {Map<number, any>} */
    const plans = new Map();
    /** @type {Array<{dir: number, exact: boolean, fuzzy: boolean}>} */
    const perDirMatch = [];
    for (const dir of [0, 1]) {
      const key = `${routeId}|${dir}`;
      const seedPattern = input.seedPatterns.get(key);
      const tranzyPattern = input.tranzyPatterns.get(key);
      const pattern = tranzyPattern ?? seedPattern;
      if (!pattern || pattern.stops.length === 0) {
        plans.set(dir, { pattern: null, orderedStops: null, csvOriginTrustable: false, headsign: null });
        // Track for the summary — Tranzy vs seed missing tells the
        // user which source to chase. Routes with no pattern in
        // EITHER source can only be fixed upstream.
        const tranzyMissing = !tranzyPattern;
        const seedMissing = !seedPattern;
        const both = tranzyMissing && seedMissing;
        // Decide which bucket (filled in below once we know both dirs).
        plans.set(dir, Object.assign(plans.get(dir) ?? {}, { _tranzyMissing: tranzyMissing, _seedMissing: seedMissing, _bothMissing: both }));
        continue;
      }
      const orderedStops = pattern.stops
        .map((s) => {
          // byStopId is keyed by Tranzy's stop_id (Tranzy primary).
          // Patterns from Tranzy resolve directly. Patterns from the
          // Transitous seed use Transitous's stop_ids, which differ
          // from Tranzy's for the same physical stop — translate via
          // the Transitous→Tranzy map built by reconcileStops.
          let stopId = String(s.stopId);
          let stop = input.stopsByStopId.get(stopId);
          if (!stop && input.transitousToTranzy) {
            const translated = input.transitousToTranzy.get(stopId);
            if (translated) {
              stop = input.stopsByStopId.get(translated);
              if (stop) stopId = translated; // canonicalize for downstream
            }
          }
          if (!stop) return null;
          const lat = parseFloat(stop.stop_lat);
          const lon = parseFloat(stop.stop_lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          // Preserve the source's stop_sequence — it's the authoritative
          // value from the upstream GTFS source (Transitous seed or
          // Tranzy). Re-numbering with a sequential index would discard
          // any non-contiguous numbering the operator uses (e.g. gaps
          // for dwell-only stops, odd-numbered extras).
          return { stopId: stop.stop_id, sequence: s.sequence, lat, lon, name: stop.stop_name };
        })
        .filter(Boolean);
      if (orderedStops.length === 0) {
        plans.set(dir, { pattern: null, orderedStops: null, csvOriginTrustable: false, headsign: null });
        continue;
      }
      if (orderedStops.length === 0) {
        plans.set(dir, { pattern: null, orderedStops: null, csvOriginTrustable: false, headsign: null });
        continue;
      }
      const csvOriginName = dir === 0 ? inLabel : outLabel;
      // Traverse the FULL pattern (not just position 0) for the match.
      // Returns { position, exact, fuzzy, stopName } or null when no
      // stop in the pattern matches the CSV origin label.
      const sameDirMatch = findLabelInPattern(csvOriginName, orderedStops);
      const exact = !!sameDirMatch?.exact;
      const fuzzy = !!sameDirMatch?.fuzzy;
      perDirMatch.push({
        dir,
        exact,
        fuzzy,
        position: sameDirMatch?.position ?? null,
        matchedStop: sameDirMatch?.stopName ?? null,
      });
      // Track fuzzy matches (not exact) for the build-log summary.
      // Operators want to know how much of the catalog ↔ CSV alignment
      // is being salvaged by fuzzy token matching — high numbers mean
      // the upstream sources use different naming conventions and we
      // should ask the operators to align them.
      if (fuzzy && !exact) fuzzyMatchCount++;
      const csvOriginTrustable = exact || fuzzy;
      const csvHeadsign = dir === 0 ? outLabel : inLabel;
      const headsign = pattern.headsign
        || (csvOriginTrustable ? csvHeadsign : null)
        || routeRow.route_long_name
        || routeShortName;
      const shape = (pattern.shapeId && input.shapesById.get(pattern.shapeId)) || [];
      plans.set(dir, { pattern, orderedStops, csvOriginTrustable, headsign, shape });
    }

    // Cross-direction (swap) detection — only meaningful when BOTH dirs
    // resolved a pattern (otherwise we have nothing to compare). Try
    // matching CSV col 0 against catalog dir 1 origin, and CSV col 1
    // against catalog dir 0 origin. If that pairing fits better than the
    // same-direction pairing, the operator's CSV columns are flipped
    // relative to the catalog.
    const plan0 = plans.get(0);
    const plan1 = plans.get(1);
    // Side-channel flag — when true, the trip emission loop below flips
    // which CSV column feeds which physical direction. Default false;
    // set to true only when tier 5 swap detection fires.
    let directionReversed = false;
    const swapCandidate = !!(plan0 && plan0.orderedStops && plan1 && plan1.orderedStops);
    /** @type {{swap0Exact: boolean, swap1Exact: boolean, swap0Fuzzy: boolean, swap1Fuzzy: boolean} | null} */
    let swapTest = null;
    if (swapCandidate) {
      // CSV col 0 ↔ catalog dir 1 — traverse the FULL dir 1 pattern.
      const swap0Match = findLabelInPattern(inLabel, plan1.orderedStops);
      // CSV col 1 ↔ catalog dir 0 — traverse the FULL dir 0 pattern.
      const swap1Match = findLabelInPattern(outLabel, plan0.orderedStops);
      swapTest = {
        swap0Exact: !!swap0Match?.exact,
        swap1Exact: !!swap1Match?.exact,
        swap0Fuzzy: !!swap0Match?.fuzzy,
        swap1Fuzzy: !!swap1Match?.fuzzy,
        swap0Position: swap0Match?.position ?? null,
        swap1Position: swap1Match?.position ?? null,
      };
    }

    // Bucket the route by how many of its directions lack a pattern,
    // and which source(s) are missing. Used by the aggregate
    // summary at the end of the function — saves emitting one line
    // per (route, dir, service-day) which would be hundreds of lines.
    const dir0Missing = plan0 && plan0._bothMissing !== undefined;
    const dir1Missing = plan1 && plan1._bothMissing !== undefined;
    const d0TranzyMissing = !!(plan0 && plan0._tranzyMissing);
    const d0SeedMissing = !!(plan0 && plan0._seedMissing);
    const d0BothMissing = !!(plan0 && plan0._bothMissing);
    const d1TranzyMissing = !!(plan1 && plan1._tranzyMissing);
    const d1SeedMissing = !!(plan1 && plan1._seedMissing);
    const d1BothMissing = !!(plan1 && plan1._bothMissing);
    if (dir0Missing && dir1Missing) {
      if (d0BothMissing && d1BothMissing) noPatternStats.bothDirsBothMissing.add(routeShortName);
      else if (d0TranzyMissing && d1TranzyMissing) noPatternStats.bothDirsTranzyMissing.add(routeShortName);
      else if (d0SeedMissing && d1SeedMissing) noPatternStats.bothDirsSeedMissing.add(routeShortName);
      // Mixed sources across dirs — fall back to "one dir" buckets per direction.
      else if (d0TranzyMissing || d1TranzyMissing) noPatternStats.oneDirTranzyMissing.add(routeShortName);
      else noPatternStats.oneDirBothMissing.add(routeShortName);
    } else if (dir0Missing || dir1Missing) {
      if ((dir0Missing && d0BothMissing) || (dir1Missing && d1BothMissing)) {
        noPatternStats.oneDirBothMissing.add(routeShortName);
      } else if ((dir0Missing && d0TranzyMissing) || (dir1Missing && d1TranzyMissing)) {
        noPatternStats.oneDirTranzyMissing.add(routeShortName);
      } else {
        noPatternStats.oneDirSeedMissing.add(routeShortName);
      }
    }

    // Compute the tier + emit ONE summary warning per route (not per
    // service-day × direction, which would triple-print for LV+S+D).
    // The warning tells you WHAT the catalog said (pattern first stop
    // + which source it came from) so you can decide whether to
    // trust the CSV column-convention assignment.
    if (perDirMatch.length > 0) {
      const dir0 = perDirMatch.find((m) => m.dir === 0);
      const dir1 = perDirMatch.find((m) => m.dir === 1);
      const d0 = dir0 ?? { exact: false, fuzzy: false };
      const d1 = dir1 ?? { exact: false, fuzzy: false };
      const bothExact = d0.exact && d1.exact;
      const anyExact = d0.exact || d1.exact;
      const bothFuzzy = d0.fuzzy && d1.fuzzy;
      const anyFuzzy = d0.fuzzy || d1.fuzzy;
      // Capture catalog first-stop name + source for each dir so the
      // warning can show what we expected, not just what the CSV said.
      const catalogInfo = (dir) => {
        const p = plans.get(dir);
        if (!p || !p.pattern) return { name: '(no pattern)', source: '—' };
        return {
          name: p.orderedStops[0]?.name ?? '(unknown)',
          source: p.pattern.source ?? (input.tranzyPatterns.get(`${routeId}|${dir}`) ? 'tranzy' : 'seed'),
        };
      };
      const cat0 = catalogInfo(0);
      const cat1 = catalogInfo(1);
      let tier;
      /** @type {{severity: 'info' | 'warn', message: string} | null} */
      let summary = null;
      // tierMatched guards against the no-match fallback firing when a
      // tier fired silently (e.g. tier 1 exact-both sets tier but no
      // summary). Without this flag, a silent tier-1 match would
      // spuriously fall through to the no-match branch below.
      let tierMatched = false;
      if (bothExact) {
        tier = 'exact-both';
        tierMatched = true;
        // Silent — perfect alignment between catalog and CSV.
      } else if (anyExact) {
        tier = 'exact-one';
        tierMatched = true;
        const exactDir = d0.exact ? 0 : 1;
        const fuzzyDir = exactDir === 0 ? 1 : 0;
        const exactLabel = exactDir === 0 ? inLabel : outLabel;
        const fuzzyLabel = fuzzyDir === 0 ? inLabel : outLabel;
        const exactCat = exactDir === 0 ? cat0 : cat1;
        const fuzzyCat = fuzzyDir === 0 ? cat0 : cat1;
        summary = info(
          `CSV origin label partial match for route_short_name "${routeShortName}": ` +
          `dir=${exactDir} matches: catalog="${exactCat.name}" (from ${exactCat.source}) == csv="${exactLabel}". ` +
          `dir=${fuzzyDir} mismatches: catalog="${fuzzyCat.name}" (from ${fuzzyCat.source}) vs csv="${fuzzyLabel}". ` +
          `Trusting column convention for the unmatched direction.`,
        );
      } else if (bothFuzzy) {
        tier = 'fuzzy-both';
        tierMatched = true;
        summary = info(
          `CSV origin labels fuzzy-matched for route_short_name "${routeShortName}": ` +
          `dir=0 catalog="${cat0.name}" (from ${cat0.source}) ≈ csv="${inLabel}"; ` +
          `dir=1 catalog="${cat1.name}" (from ${cat1.source}) ≈ csv="${outLabel}". ` +
          `Catalog and CSV use different precision/spelling for the same stops.`,
        );
      } else if (anyFuzzy) {
        tier = 'fuzzy-one';
        tierMatched = true;
        const fuzzyDir = d0.fuzzy ? 0 : 1;
        const noMatchDir = fuzzyDir === 0 ? 1 : 0;
        const fuzzyLabel = fuzzyDir === 0 ? inLabel : outLabel;
        const noMatchLabel = noMatchDir === 0 ? inLabel : outLabel;
        const fuzzyCat = fuzzyDir === 0 ? cat0 : cat1;
        const noMatchCat = noMatchDir === 0 ? cat0 : cat1;
        summary = info(
          `CSV origin label mismatch for route_short_name "${routeShortName}": ` +
          `dir=${fuzzyDir} fuzzy-matched: catalog="${fuzzyCat.name}" (from ${fuzzyCat.source}) ≈ csv="${fuzzyLabel}". ` +
          `dir=${noMatchDir} doesn't match: catalog="${noMatchCat.name}" (from ${noMatchCat.source}) vs csv="${noMatchLabel}". ` +
          `Trusting column convention; headsign for the unmatched direction falls back to route_long_name.`,
        );
      } else if (swapTest) {
        // Tier 5: same-direction matching all failed, but cross-direction
        // (swap) matching works. The CSV's col 0/col 1 labels are
        // flipped relative to the catalog. Emit trips with FLIPPED
        // direction_id so each trip's first stop matches the CSV's
        // published origin label.
        directionReversed = true;
        const s = swapTest;
        const swap0Exact = s.swap0Exact, swap1Exact = s.swap1Exact;
        const swap0Fuzzy = s.swap0Fuzzy, swap1Fuzzy = s.swap1Fuzzy;
        const swapBothExact = swap0Exact && swap1Exact;
        const swapBothFuzzy = swap0Fuzzy && swap1Fuzzy;
        const swapAnyExact = swap0Exact || swap1Exact;
        const swapAnyFuzzy = swap0Fuzzy || swap1Fuzzy;
        const swapMeta = { route: routeShortName, directionReversed: true };
        if (swapBothExact) {
          tier = 'swap-exact-both';
          tierMatched = true;
          summary = info(
            `CSV direction reversed for route_short_name "${routeShortName}": ` +
            `csv col 0 origin "${inLabel}" matches catalog dir 1 origin "${cat1.name}" (from ${cat1.source}); ` +
            `csv col 1 origin "${outLabel}" matches catalog dir 0 origin "${cat0.name}" (from ${cat0.source}). ` +
            `CSV column-to-direction mapping is flipped relative to the catalog; trips emitted with direction_id swapped.`,
            swapMeta,
          );
        } else if (swapBothFuzzy) {
          tier = 'swap-fuzzy-both';
          tierMatched = true;
          // INFO: trips emitted with the correct physical direction via
          // the swap. The fuzzy match means the operator's spelling differs
          // (e.g. "Alverna" vs "Disp. Alverna") but the swap itself is
          // unambiguous — both cross-pairs matched. Cosmetic difference,
          // not data loss.
          summary = info(
            `CSV direction reversed (fuzzy) for route_short_name "${routeShortName}": ` +
            `csv col 0 origin "${inLabel}" ≈ catalog dir 1 origin "${cat1.name}" (from ${cat1.source}); ` +
            `csv col 1 origin "${outLabel}" ≈ catalog dir 0 origin "${cat0.name}" (from ${cat0.source}). ` +
            `Names differ in precision/spelling; CSV column-to-direction mapping is flipped relative to the catalog.`,
            swapMeta,
          );
        } else if (swapAnyExact || swapAnyFuzzy) {
          // Tier 5 partial — only one cross-pair matched. Still better
          // than no-match (which gives us nothing) so we use the swap
          // and warn loudly about the asymmetry.
          tier = 'swap-partial';
          tierMatched = true;
          const exactDir = swap0Exact ? 0 : (swap1Exact ? 1 : null);
          const noMatchDir = exactDir === 0 ? 1 : 0;
          summary = warnMsg(
            `CSV direction reversed (partial) for route_short_name "${routeShortName}": ` +
            (exactDir === 0
              ? `csv col 0 origin "${inLabel}" matches catalog dir 1 origin "${cat1.name}" (from ${cat1.source}); `
              : `csv col 1 origin "${outLabel}" matches catalog dir 0 origin "${cat0.name}" (from ${cat0.source}); `) +
            (exactDir === 0
              ? `csv col 1 origin "${outLabel}" does NOT match catalog dir 0 origin "${cat0.name}" (from ${cat0.source}). `
              : `csv col 0 origin "${inLabel}" does NOT match catalog dir 1 origin "${cat1.name}" (from ${cat1.source}). `) +
            `Asymmetric — assuming operator swapped the columns but one terminal is renamed/missing. ` +
            `Headsign for the unmatched direction falls back to catalog.`,
            swapMeta,
          );
        } else {
          // swapTest was non-null but every cross-pair failed to match.
          // Fall through to no-match below by unsetting directionReversed.
          directionReversed = false;
        }
      }
      if (!tierMatched) {
        tier = 'no-match';
        // Categorize the no-match so the build-log reader knows whether
        // the operator needs to push Tranzy, fix their CSV, or both.
        // Heuristics (cheap; we're already past the cheap tiers):
        //   - catalog-out-of-date: at least one CSV label looks like a
        //     real stop (≥4-char tokens that don't match route_long_name
        //     as a substring) but doesn't appear in any pattern.
        //   - csv-placeholder: a CSV label appears as a substring of the
        //     catalog's route_long_name (likely a generic term the
        //     operator used as a placeholder) OR has no tokens ≥4 chars.
        //   - no-match-asymmetric: patterns exist for both dirs but
        //     their endpoint pairs differ — the catalog itself is the
        //     broken source here, no CSV label could reconcile it.
        const realStopTokenLen = (s) => {
          if (!s) return false;
          const norm = normalizeStopName(s);
          const tokens = (norm.match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 4);
          return tokens.length > 0;
        };
        // Use the CSV's own route_long_name (not the catalog's) for the
        // substring check — the CSV is self-consistent if its terminals
        // appear in its own metadata. The catalog's long_name might be
        // from Tranzy/Transitous and not match the CSV's view.
        const csvRouteLongName = headersCsv?.routeLongName ?? '';
        const csvLongLower = csvRouteLongName.toLowerCase();
        const inIsPlaceholder = !realStopTokenLen(inLabel)
          || (csvRouteLongName && inLabel
              && csvLongLower.includes(inLabel.toLowerCase()));
        const outIsPlaceholder = !realStopTokenLen(outLabel)
          || (csvRouteLongName && outLabel
              && csvLongLower.includes(outLabel.toLowerCase()));
        const bothPatternsExist = !!(plan0?.pattern && plan1?.pattern);
        const patternsAsymmetric = bothPatternsExist && (
          cat0.name !== '(no pattern)'
          && cat1.name !== '(no pattern)'
          && cat0.name !== cat1.name  // different first stops
        );

        let subtype;
        let actionableHint;
        if (inIsPlaceholder || outIsPlaceholder) {
          subtype = 'csv-placeholder';
          actionableHint = 'one or both CSV origin labels look like a generic term (matches the CSV\'s own route_long_name substring, or has no real stop name). Operator should fix the CSV.';
        } else if (patternsAsymmetric) {
          subtype = 'no-match-asymmetric';
          actionableHint = 'catalog patterns for the two directions have different first stops; the catalog itself is out of sync. Operator should ask Tranzy to realign.';
        } else {
          subtype = 'catalog-out-of-date';
          actionableHint = 'CSV terminals look like real stops but neither catalog pattern contains them. Operator should ask Tranzy to update the stops for this route.';
        }

        summary = warnMsg(
          `CSV origin labels DO NOT MATCH catalog [${subtype}] for route_short_name "${routeShortName}": ` +
          `dir=0 catalog="${cat0.name}" (from ${cat0.source}) vs csv="${inLabel}"; ` +
          `dir=1 catalog="${cat1.name}" (from ${cat1.source}) vs csv="${outLabel}". ` +
          `${actionableHint} ` +
          `CSV trip times are still used but no headsign is derived from CSV terminal names. ` +
          `See docs/quirks-and-rules.md#origin-label-matching.`,
          { route: routeShortName, subtype, inIsPlaceholder, outIsPlaceholder, patternsAsymmetric },
        );
      }
      // After all tier resolution (exact-both, exact-one, fuzzy-*,
      // swap-*, no-match): always rewrite `route_long_name` from CSV
      // in/out when BOTH labels are present. The CSV is the operator's
      // authoritative source for terminal labels — Tranzy's catalog
      // field is often stale (route 19: Tranzy says "P-ta M. Viteazul -
      // Str. E. Quinet" but the actual stops are Pod Traian → E.Quinet
      // Sud, per CSV) or uses depot-relative origins ("Disp. X") that
      // confuse riders. CSV labels reflect what the operator publishes
      // in their timetable headers.
      //
      // Direction order follows CTP's column convention (col 0 = origin
      // of dir 0 buses = start; col 1 = origin of dir 1 buses = end).
      // Tranzy's direction_id mapping is authoritative (dir 0 vs dir 1
      // stays Tranzy's contract for downstream consumers — including
      // the GTFS-RT feed, which keys on Tranzy's ids). When a swap is
      // detected (CSV col 0 actually matches catalog dir 1's first
      // stop), reverse the label order so the output still describes
      // the line in the dir 0 → dir 1 convention.
      //
      // No tier filter — fire for any CSV (including no-match cases
      // where neither Tranzy nor Transitous's pattern contains the CSV
      // terminals, e.g. route 19, route 42). For those, the CSV is the
      // only authoritative source and the swap-detection fallback to
      // "no swap" is the CTP convention. No symmetry check either —
      // CSV priority means trusting the operator's labels even when the
      // catalog has 4 distinct terminal names (the route 30 hypothetical
      // where dir 0 and dir 1 patterns don't connect).
      if (inLabel && outLabel) {
        const rewritten = directionReversed
          ? `${outLabel} - ${inLabel}`
          : `${inLabel} - ${outLabel}`;
        if (routeRow.route_long_name !== rewritten) {
          routeRow.route_long_name = rewritten;
          rewrittenLongNames++;
        }
      }
      if (summary) localWarnings.push(summary);
    }

    // Tier 5's `directionReversed` flag is INFORMATIONAL ONLY — it
    // carries the warning through the side-channel meta field but does
    // NOT change trip emission. Direction_id in trips.txt is always
    // the catalog (Tranzy) value: dir 0 trips use the catalog's dir 0
    // pattern, dir 1 trips use the catalog's dir 1 pattern. Even when
    // the operator's CSV columns are reversed relative to the catalog
    // (which tier 5 flags), we keep Tranzy's direction_id mapping for
    // downstream stability — consumers depend on Tranzy's id↔direction
    // contract. The CSV times are mapped by column index (col 0 → dir 0,
    // col 1 → dir 1); headsign still falls back to the catalog when
    // the CSV origin labels don't match.
    for (const [serviceId, csv] of byService.entries()) {
      const dirs = [
        { dir: 0, departures: csv.departures.dir0 },
        { dir: 1, departures: csv.departures.dir1 },
      ];
      for (const { dir, departures } of dirs) {
        if (!departures || departures.length === 0) continue;
        const plan = plans.get(dir);
        if (!plan || !plan.pattern) {
          // Don't emit per-iteration — the no-pattern summary is computed at the
          // end of the function. (Was: one warning per (route, dir, service-day)
          // = hundreds of lines for the full network.)
          continue;
        }
        const { pattern, orderedStops, shape, headsign } = plan;

        for (let i = 0; i < departures.length; i++) {
          const depTime = departures[i];
          const tripId = makeTripId(routeId, dir, serviceId, depTime);
          const shapeId = pattern.shapeId || `${routeId}_${dir}`;
          tripRows.push({
            route_id: routeId,
            service_id: serviceId,
            trip_id: tripId,
            trip_headsign: headsign,
            direction_id: String(dir),
            shape_id: shapeId,
          });

          const startSec = hhmmToSeconds(depTime);
          const { arrivals, departures: stopDeps, shapeDistTraveledM, bucket, speedKmh } = computeStopTimes({
            startSec,
            stops: orderedStops,
            shape,
            timing,
          });
          for (let k = 0; k < orderedStops.length; k++) {
            stopTimeRows.push({
              trip_id: tripId,
              arrival_time: formatGtfsTime(arrivals[k]),
              departure_time: formatGtfsTime(stopDeps[k]),
              stop_id: orderedStops[k].stopId,
              // Use the upstream source's stop_sequence (Transitous
              // seed or Tranzy) — not a re-numbered index. See comment
              // on orderedStops above.
              stop_sequence: String(orderedStops[k].sequence ?? k),
              shape_dist_traveled: shapeDistTraveledM[k] != null ? String(shapeDistTraveledM[k]) : '',
            });
          }

          if (i === 0) {
            tripDiagnostics.push({
              route_id: routeId,
              direction_id: dir,
              service_id: serviceId,
              count: departures.length,
              bucket,
              speed_kmh: speedKmh,
              pattern_source: pattern.source ?? 'seed',
            });
          }
        }
      }
    }
  }

  // Aggregate "no pattern" summary — one line per category instead of
  // one per (route, dir, service-day). Tells the user how many routes
  // lost trip generation because Tranzy/seed patterns were missing,
  // and which source is to blame.
  if (fuzzyMatchCount > 0) {
    localWarnings.push(info(
      `origin validation: ${fuzzyMatchCount} (route, dir) pair(s) used fuzzy word-token matching to align catalog ↔ CSV origin labels ` +
      `(not exact match). See docs/quirks-and-rules.md#fuzzy-origin-matching.`,
    ));
  }
  if (rewrittenLongNames > 0) {
    localWarnings.push(info(
      `routes: ${rewrittenLongNames} route_long_name(s) rewritten from CSV in/out (catalog was stale — pattern traversal found a clean resolution, ` +
      `CSV terminals are more accurate). See docs/quirks-and-rules.md#route-long-name-rewrite-from-csv.`,
    ));
  }
  const totalRoutes = noPatternStats.bothDirsBothMissing.size
    + noPatternStats.bothDirsTranzyMissing.size
    + noPatternStats.bothDirsSeedMissing.size
    + noPatternStats.oneDirBothMissing.size
    + noPatternStats.oneDirTranzyMissing.size
    + noPatternStats.oneDirSeedMissing.size;
  if (totalRoutes > 0) {
    const parts = [];
    if (noPatternStats.bothDirsBothMissing.size > 0) {
      parts.push(`${noPatternStats.bothDirsBothMissing.size} routes (both directions) — missing in Tranzy AND Transitous seed`);
    }
    if (noPatternStats.bothDirsTranzyMissing.size > 0) {
      parts.push(`${noPatternStats.bothDirsTranzyMissing.size} routes (both directions) — missing in Tranzy`);
    }
    if (noPatternStats.bothDirsSeedMissing.size > 0) {
      parts.push(`${noPatternStats.bothDirsSeedMissing.size} routes (both directions) — missing in Transitous seed`);
    }
    if (noPatternStats.oneDirBothMissing.size > 0) {
      parts.push(`${noPatternStats.oneDirBothMissing.size} routes (one direction) — missing in both sources`);
    }
    if (noPatternStats.oneDirTranzyMissing.size > 0) {
      parts.push(`${noPatternStats.oneDirTranzyMissing.size} routes (one direction) — missing in Tranzy`);
    }
    if (noPatternStats.oneDirSeedMissing.size > 0) {
      parts.push(`${noPatternStats.oneDirSeedMissing.size} routes (one direction) — missing in Transitous seed`);
    }
    localWarnings.push(warnMsg(`trips: ${totalRoutes} routes have no usable pattern — ${parts.join('; ')}. Trips for these (route, dir) are dropped.`));
  }

  input.warnings.push(...localWarnings);
  return { tripRows, stopTimeRows, tripDiagnostics };
}

function findRouteByShortName(routesByRouteId, shortName) {
  // shortName is already canonical (URL form). Routes in the map carry
  // catalog-side names, so canonicalize each row's route_short_name for
  // the compare — that way `39 CREIC` (Trans) and `39C` (Tranzy) both
  // resolve to the same row that matches `39CREIC`.
  const target = canonicalShortName(shortName);
  for (const r of routesByRouteId.values()) {
    if (canonicalShortName(r.route_short_name) === target) return r;
  }
  return null;
}

/**
 * Trip ID for this adapter's static feed.
 *
 * Format: `${routeId}_${dir}_${serviceId}_${HHMM}` — e.g. `M26_0_LV_0721`.
 *
 * Why this format (and why NOT the full `route_dir_service_run_HHMM`):
 *
 *   - **The reconciler in `neary` does NOT use trip_id for the JOIN.**
 *     `neary/src/lib/domain/reconcile.ts` matches live observations to
 *     scheduled trips by `(routeId, directionId, tripStartMin)` with
 *     adaptive tolerance — explicitly noting that static and GTFS-RT
 *     trip_ids drift ~23% of the time because Transitous, Tranzy, and
 *     the GTFS-RT feed each generate trip_ids from independent
 *     dispatch databases. See that file's header comment for context.
 *
 *   - **Neary's `parseLiveStartMin` does extract HHMM from trip_id
 *     tails** as a fallback when `TripDescriptor.start_time` is
 *     missing — `_(\d{3,4})$` regex on the suffix. So our static
 *     trip_ids ending in `_HHMM` lets neary's fallback work if it
 *     ever runs against our zip directly. The HHMM tail is the only
 *     structural requirement we have to satisfy.
 *
 *   - **Neary's `resolveDirectionId` parses direction from RT trip_ids**
 *     via `/^\d+_(\d)_/`. Our static trip_ids DON'T need to satisfy
 *     this — neary doesn't try to extract direction from static IDs.
 *
 *   - **No "matches cluj-rt-feed" claim.** The RT feed uses Tranzy's
 *     internal route_ids (e.g. `45` for route 45, `92` for M26) while
 *     our static feed uses Transitous's IDs (the same `45` for route
 *     45, but `M26` for M26). So even the same trip will have a
 *     different prefix in static vs RT — by design.
 *
 * The `${seq}` (run number) we used to include was never consumed by
 * anyone — dropped to keep trip_ids short and readable.
 *
 * @param {string} routeId
 * @param {number} dir
 * @param {string} serviceId
 * @param {string} depTime  "HH:MM" or "HH:MM:SS" or "HH+24:MM"
 */
export function makeTripId(routeId, dir, serviceId, depTime) {
  // depTime is "HH:MM" or "HH:MM:SS" (possibly "HH+24:MM" from post-midnight
  // wrap). Strip colons; strip the "+24" infix so 25:30 doesn't double up.
  const hhmm = depTime.replace(':', '').replace('+24', '');
  return `${routeId}_${dir}_${serviceId}_${hhmm}`;
}

function hhmmToSeconds(hhmm) {
  const parts = hhmm.split(':').map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  return h * 3600 + m * 60;
}

/**
 * Loose terminal-name match for CSV direction validation.
 *
 * CTP's CSV terminal names sometimes differ in casing, punctuation, or
 * a trailing "Statie"/"Piața" vs the seed's "Stația"/"Piața". We
 * normalize both to lowercase + digits only, then exact-match.
 *
 * Returns `true` when at least one side is empty (can't validate either
 * way — caller should treat the CSV terminal as "trustable enough").
 */
export function normalizeStopName(s) {
  if (!s) return '';
  return s.toString().toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș/g, 's').replace(/ț/g, 't')
    // Collapse punctuation followed by whitespace ("E. Quinet" vs
    // "E.Quinet") so labels that differ only in spacing after a
    // period compare equal. Route 19's CSV "E. Quinet Sud" and
    // Tranzy's "E.Quinet Sud" hit this — without normalization, the
    // tier fell back to "exact-one" (whitespace mismatch) and the
    // route_long_name rewrite never fired.
    .replace(/([.,;:])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function terminalNamesMatch(a, b) {
  if (!a || !b) return true;
  // Word-based token matching. After diacritic + case normalization,
  // we split each name into words (separators: spaces, hyphens, parens,
  // punctuation). Two stops match if EITHER:
  //   - they share ≥2 significant words (length >= 4), OR
  //   - they share a single significant word of length ≥6.
  //
  // The stricter "≥2 or one of length ≥6" rule prevents false-positive
  // matches on common transit prefixes like "Disp." (4 chars,
  // abbreviation for "Dispecerat" = depot). Without it, "Disp.
  // Grigorescu" would falsely match "Disp. IRA" because both share
  // "disp" — but those are different physical depots.
  //
  // Working cases that the rule still accepts:
  //   - "P-ta Garii" vs "P-ța Gării Nord" → share "pta", "garii" (2)
  //   - "M Pensiunea Dalia Gilau Sud" vs "M-Motel Dalia Gilau Nord"
  //     → share "dalia", "gilau" (2)
  //   - "Str. Unirii" vs "Disp. Unirii" → share "unirii" (6 chars, ≥6)
  //   - "Baisoara" vs "Băișoara" → share "baisoara" (≥6 after norm)
  //
  // Single-character tokens ("M" prefix for metropolitan lines) are
  // ignored to avoid false positives.
  const tokenize = (s) => {
    const normalized = s.toString().toLowerCase()
      .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
      .replace(/ș/g, 's').replace(/ț/g, 't');
    return (normalized.match(/[a-z0-9]+/g) ?? [])
      .filter((t) => t.length >= 4);
  };
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.length === 0 || tokensB.length === 0) return true;
  let sharedCount = 0;
  for (const t of tokensB) {
    if (tokensA.includes(t)) {
      sharedCount++;
      if (t.length >= 6) return true;
    }
  }
  return sharedCount >= 2;
}

/**
 * (Removed: patternsShareEndpoint — was used as the symmetry guard
 * for cross-direction CSV rewrites. Dropped when the rewrite rule was
 * changed to "always use CSV when available, swap-detection handles
 * direction" — CSV priority trumps the 4-distinct-terminals edge case.
 * Kept here as a placeholder comment so future readers don't grep for
 * a function that no longer exists.)
 */

/**
 * Find the first stop in `pattern` whose name matches `label` (exact or
 * fuzzy via `terminalNamesMatch`). Searches every position, not just
 * position 0 — needed because CTP's CSV sometimes publishes an origin
 * that's mid-pattern (M24: catalog dir 0 starts at "Taberei" but the
 * CSV says col 0 origin is "Calea Floresti" at position 1).
 *
 * @returns {{position: number, exact: boolean, fuzzy: boolean, stopName: string} | null}
 */
function findLabelInPattern(label, pattern) {
  if (!label || !Array.isArray(pattern) || pattern.length === 0) return null;
  const normLabel = normalizeStopName(label);
  // Exact pass first — diacritic-insensitive so "P-ța Gării Sud" matches
  // "P-ta Garii Sud" (the common CTP transliteration case).
  for (let i = 0; i < pattern.length; i++) {
    const stopName = pattern[i]?.name;
    if (stopName && normalizeStopName(stopName) === normLabel) {
      return { position: i, exact: true, fuzzy: true, stopName };
    }
  }
  // Fuzzy pass — token overlap (catches "P-ta Garii" vs "P-ța Gării Nord" etc.).
  for (let i = 0; i < pattern.length; i++) {
    const stopName = pattern[i]?.name;
    if (stopName && terminalNamesMatch(label, stopName)) {
      return { position: i, exact: false, fuzzy: true, stopName };
    }
  }
  return null;
}

function formatGtfsTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function tripsToTxt(tripRows) {
  // Spec-driven serializer — same pattern as stopsToTxt/routesToTxt.
  return serializeRows(TripRowSchema, tripRows);
}

export async function stopTimesToTxt(stopTimeRows) {
  // Spec-driven serializer. The `timepoint: '0'` value (approximate,
  // synthesized by computeStopTimes() rather than authoritative — see
  // https://gtfs.org/schedule/reference/#stop_timestxt) is set on each
  // row by the caller before this function sees it.
  return serializeRows(StopTimeRowSchema, stopTimeRows);
}