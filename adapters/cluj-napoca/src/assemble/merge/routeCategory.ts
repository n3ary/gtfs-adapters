// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
import { type RouteRow } from '@n3ary/gtfs-spec/spec';
/**
 * Route category classification + long_name cleanup.
 *
 * Single source of truth for which network each route belongs to and how
 * to clean up Tranzy's messy `route_long_name` into start-end format.
 */

import { terminalNamesMatch, normalizeStopName } from '../emit/trips';

/**
 * The classifier runs once at assemble time; consumers (neary) just read
 * the structured fields from `routes.txt` + `networks.txt` +
 * `route_networks.txt` and don't have to parse free-text signals.
 *
 * **Background**: see neary#125 for the design discussion. Briefly:
 *
 * - Tranzy exposes only basic route fields (no service-class column),
 *   so category info is buried as patterns in `route_short_name` (TE*,
 *   *N, *U, M*, CS, etc.) and trailing parentheticals in
 *   `route_long_name` / `route_desc` ("(untold)", "(traseu M21)").
 * - The adapter parses those patterns once here, writes the result as
 *   standard GTFS fields (`route_desc` for the human label,
 *   `networks.txt` + `route_networks.txt` for the structured mapping),
 *   and emits cleaned `route_long_name` in start-end format (with a
 *   stop_times-based fallback for routes where cleaning leaves it empty).
 * - `route_short_name` keeps Tranzy's value verbatim — the operator's
 *   chosen rider-facing identifier (e.g. `25N`, `TE1`, `M76A`) is the
 *   GTFS-spec way to carry service-class info, and we don't munge it.
 *
 * **Classification**: 1:1 with priority. Most-specific category wins.
 * `TE1` and `25N` are unambiguous (school / night respectively). Edge
 * cases (e.g. `M76A` whose `long_name` starts with `TE2 Floresti`) are
 * resolved by the school pattern's checks across all three fields.
 *
 * **Calendar windows** (school-year-only, festival-only) are *not*
 * tracked here — they're a property of the schedule view, orthogonal to
 * the route's category. See neary#129 for the ingestion work.
 */

/**
 * Categories, ordered most-specific first. First match wins.
 *
 * Each entry: `{ id, label, match(s, l, d) }` where
 *   - `id` is the network_id (machine-readable, kebab-case-ish)
 *   - `label` is the human-readable string that goes into `route_desc`
 *     AND into `networks.txt` `network_name`. Keeping these aligned
 *     means consumers reading `route_desc` directly get the same string
 *     they'd get from joining `route_networks.txt` → `networks.txt`.
 *     Labels are in Romanian to match the operator's terminology
 *     ("Noapte", "Metropolitan" — Cluj-CTP's own term for the
 *     suburban bus network is "Metropolitan" per ctpcj.ro).
 *   - `match` is a predicate over (route_short_name, route_long_name,
 *     route_desc). We check all three because Tranzy sometimes carries
 *     the signal in just one — e.g. "(untold)" annotation lands in
 *     route_desc for festival routes, "Transport Elevi X" lands in
 *     long_name for school buses. Case-insensitive substring matching
 *     on long_name and route_desc so operator-named variants work.
 *
 * Add new categories at the END of this list so existing priorities stay
 * stable. Bumping a category earlier = behavior change for routes that
 * match multiple patterns.
 *
 * **`commuter` was removed**: D51 (the only `D*`-prefixed route) is not
 * a commuter rail service — per ctpcj.ro it's an employee-only /
 * convention transport route, not a public commuter pattern. If a
 * future feed has a genuine commuter service, it can be re-added here
 * with a more specific pattern.
 */
export const CATEGORIES = [
  {
    id: 'special',
    label: 'Cursa Speciala',
    match: (s, l, d) =>
      s === 'CS' || /CURSA SPECIALA/i.test(l) || /CURSA SPECIALA/i.test(d),
  },
  {
    id: 'school',
    label: 'Transport Elevi',
    // School buses appear under two patterns in Tranzy:
    //   1. `TE*` short_name (urban: TE1..TE14, TE-OG)
    //   2. Any route whose short_name, long_name, or route_desc
    //      contains "elevi" case-insensitively — defensive against
    //      operator-named variants CTP may introduce later.
    //
    // Note: the M7x school-bus family (M75A..M79C) is metroline-shaped
    // (M* prefix). After PR review we dropped the M7x-specific short_name
    // regex — those routes fall through to `metroline` only. The "elevi"
    // substring check would catch them if their long_name ever explicitly
    // says "elevi"; until then they're classified as regular metroline
    // routes, which is also factually correct (they're Florești metroline
    // services that happen to also serve school destinations).
    match: (s, l, d) =>
      /^TE/i.test(s) ||
      /^TE/i.test(l) ||  // M7x school-bus family: long_name="TE1F",
                         // "TE1 Floresti", "TE2 Floresti" (Tranzy keeps
                         // the school designation as long_name even
                         // though short_name has the M* metroline prefix).
      /elevi/i.test(s) ||
      /elevi/i.test(l) ||
      /elevi/i.test(d),
  },
  {
    id: 'festival',
    label: 'Untold',
    // Festival services (Untold Music Festival in Cluj). The signal is
    // either:
    //   - `*U` suffix in short_name (`30U`, `M26U`)
    //   - "untold" substring in long_name or route_desc (Tranzy's
    //     parenthetical "(untold)" in long_name OR plain "Untold" in
    //     desc). Case-insensitive on both.
    match: (s, l, d) =>
      /U$/.test(s) ||
      /untold/i.test(l) ||
      /untold/i.test(d),
  },
  {
    id: 'night',
    label: 'Noapte',
    // Night services. Signal is `*N` suffix or "noapte" substring
    // (Romanian for "night"; Tranzy uses "Disp." prefix on headsigns
    // for depot-relative direction, but the long_name/desc sometimes
    // has "Noapte" explicitly).
    match: (s, l, d) =>
      /N$/.test(s) ||
      /noapte/i.test(l) ||
      /noapte/i.test(d),
  },
  {
    id: 'airport',
    label: 'Aeroport Expres',
    match: (s, l, d) =>
      /^A\d/.test(s) ||
      /aeroport/i.test(l) ||
      /aeroport/i.test(d),
  },
  {
    id: 'metroline',
    label: 'Metropolitan',
    // Cluj-CTP's own term for the suburban/metroline bus network is
    // "Metropolitan" (per ctpcj.ro). Used in the consumer-facing label
    // because that's what riders search for on the agency site.
    match: (s) => /^M\d/.test(s),
  },
];

/**
 * Classify a single route, returning all matching categories in
 * priority order (CATEGORIES declaration order). Empty array for
 * regular urban routes that match nothing.
 *
 * **1:many is intentional**: a route can belong to multiple networks.
 * The classic case is `M76A` — short_name is `M7[5-9][A-Z]?` (matches
 * school) AND starts with `M\d` (matches metroline). One route, two
 * networks. `route_networks.txt` carries the n:m mapping natively.
 *
 * @param {{ route_short_name?: string, route_long_name?: string, route_desc?: string }} row
 * @returns {Array<{ id: string, label: string }>}
 */
export function classifyRoute(row) {
  const s = (row.route_short_name ?? '').toString();
  const l = (row.route_long_name ?? '').toString();
  const d = (row.route_desc ?? '').toString();
  const matches = [];
  for (const cat of CATEGORIES) {
    if (cat.match(s, l, d)) {
      matches.push({ id: cat.id, label: cat.label });
    }
  }
  return matches;
}

/**
 * Apply the standard cleanup regex passes to a free-text value (long_name
 * OR desc). Shared between `cleanLongName` and `cleanDesc` so the two
 * fields stay in sync — if we strip a parenthetical on one, we strip it
 * on the other.
 *
 * Operations, in order:
 *
 *   1. CURSA SPECIALA (`CS`) → empty. No fixed endpoints — calling it
 *      "CURSA SPECIALA" is noise that consumers shouldn't have to
 *      special-case.
 *   2. Strip trailing parenthetical annotations: "(untold)", "(traseu
 *      M21)", "(traseu M21) (something else)". When `captureStripped`
 *      is true, the parenthetical CONTENTS are collected (e.g. "untold",
 *      "traseu M21") so the orchestrator can pipe them into `route_desc`
 *      as informational annotations on un-categorized routes.
 *   3. Strip "Transport Elevi -" / "Transport Elevi " prefix for school
 *      routes whose Tranzy data describes the service class rather than
 *      the endpoints ("Transport Elevi Manastur" → "Manastur"). For
 *      richer start-end extraction (e.g. "Primaverii - Onisifor Ghibu"
 *      for TE1) the CTP website source is required — tracked in
 *      neary#129.
 *   4. Strip "TE\d+ Floresti" prefix from Tranzy for the M7x school-bus
 *      family. MUST run BEFORE the generic TE-prefix strip below.
 *   5. Strip remaining "TE\d+" / "TE-OG" prefix noise.
 *
 * **Returns**: when `captureStripped` is true, `{ cleaned, stripped }`
 * where `stripped` is the array of parenthetical contents (each trimmed,
 * in original order, deduped within a single call). When false, just
 * the cleaned string (for callers that don't need the captured
 * content). May be empty for CS, annotation-only values, or empty inputs.
 *
 * @param {{ route_short_name?: string }} row
 * @param {string} value  the field to clean (long_name OR desc text)
 * @param {boolean} [captureStripped=false]
 * @returns {string | { cleaned: string, stripped: string[] }}
 */
function cleanText(row, value, captureStripped = false) {
  const s = (row?.route_short_name ?? '').toString();
  let t = (value ?? '').toString().trim();

  if (s === 'CS') {
    return captureStripped ? { cleaned: '', stripped: [] } : '';
  }

  /** @type {string[]} */
  const stripped = [];

  // Strip trailing parentheticals. Greedy on the right edge so that
  // "Foo (a) (b)" strips both → "Foo" and captures ["a", "b"].
  if (captureStripped) {
    t = t.replace(/\s*\(([^)]*)\)\s*$/g, (_match, content) => {
      const c = content.trim();
      if (c) stripped.push(c);
      return '';
    }).trim();
  } else {
    t = t.replace(/\s*\([^)]*\)\s*$/g, '').trim();
  }

  // "Transport Elevi -" / "Transport Elevi " prefix.
  t = t.replace(/^Transport Elevi[- ]+/i, '');

  // "TE\d+ Floresti" prefix (M7x school-bus family).
  //   "TE2 Floresti str. Somesului..." → "str. Somesului..."
  t = t.replace(/^TE\d+\s+Floresti\s*/i, '');

  // "TE\d+" / "TE-OG" leftover prefix.
  //   "TE1 Manastur" → "Manastur"
  //   "TE-OG Sala Sporturilor" → "Sala Sporturilor"
  t = t.replace(/^TE-?[A-Z0-9]+[- ]+/i, '');

  const cleaned = t.trim();
  if (!captureStripped) return cleaned;

  // Dedup captured parenthetical content within this single call (the
  // same string appearing in both long_name AND desc is captured
  // twice; the orchestrator pipes one list per field).
  const seen = new Set();
  const dedupedStripped = [];
  for (const s of stripped) {
    if (!seen.has(s)) {
      seen.add(s);
      dedupedStripped.push(s);
    }
  }
  return { cleaned, stripped: dedupedStripped };
}

/**
 * Clean `route_long_name` into "Start - End" format via regex passes.
 * Thin wrapper around `cleanText` that pulls the value off the row.
 *
 * **Note**: this function may return an empty string for routes like CS,
 * routes that were just annotations ("(untold)"), or routes where
 * Tranzy never published a long_name. The orchestrator should fall back
 * to `deriveLongNameFromStops()` in those cases.
 *
 * @param {{ route_short_name?: string, route_long_name?: string }} row
 * @returns {string} cleaned long_name (may be empty — see note above)
 */
export function cleanLongName(row) {
  return cleanText(row, row?.route_long_name ?? '');
}

/**
 * Clean `route_desc` with the same regex passes as `cleanLongName`.
 *
 * Tranzy's `route_desc` carries the same kind of free-text noise as
 * `route_long_name` does — parenthetical annotations, "Transport Elevi"
 * prefixes, etc. Cleaning it symmetrically means:
 *
 *   - For un-categorized routes (no category match), `route_desc` keeps
 *     the descriptive text Tranzy published (D51's "P-ta Mihai Viteazu -
 *     Gilau" survives; CS's empty desc stays empty).
 *   - For categorized routes, `route_desc` is overwritten with the
 *     comma-separated category labels (the canonical structured
 *     representation), so the desc-fallback case for un-categorized
 *     routes doesn't get mixed in.
 *
 * @param {{ route_short_name?: string, route_desc?: string }} row
 * @returns {string} cleaned desc (may be empty)
 */
export function cleanDesc(row) {
  return cleanText(row, row?.route_desc ?? '');
}

/**
 * Derive a "First stop - Last stop" `route_long_name` from stop_times
 * data. Used as the fallback when `cleanLongName()` leaves the field
 * empty (CS special-cases, annotation-only routes, routes Tranzy never
 * published a long_name for).
 *
 * Picks the **longest trip** for the route (most stop_times) so the
 * fallback reflects the canonical full-haul variant, not a truncated
 * short-turn service.
 *
 * @param {{
 *   routeId: string,
 *   allStopTimeRows: Array<{ trip_id: string, stop_id: string, stop_sequence: string|number }>,
 *   tripToRoute: Map<string, string>,
 *   stopsByStopId: Map<string, { stop_name?: string }>,
 * }} input
 * @returns {string} "<first stop name> - <last stop name>", or '' if no data
 */
export function deriveLongNameFromStops({ routeId, allStopTimeRows, tripToRoute, stopsByStopId }) {
  if (!allStopTimeRows || !tripToRoute || !stopsByStopId) return '';

  // Group stop_times by trip for this route.
  /** @type {Map<string, Array<{ stop_id: string, stop_sequence: number }>>} */
  const byTrip = new Map();
  for (const st of allStopTimeRows) {
    if (tripToRoute.get(String(st.trip_id)) !== routeId) continue;
    if (!byTrip.has(String(st.trip_id))) byTrip.set(String(st.trip_id), []);
    byTrip.get(String(st.trip_id)).push({
      stop_id: String(st.stop_id),
      stop_sequence: Number(st.stop_sequence),
    });
  }
  if (byTrip.size === 0) return '';

  // Pick the longest trip (most stop_times) — the canonical variant.
  let bestTrip = null;
  let bestCount = -1;
  for (const [tripId, sts] of byTrip) {
    if (sts.length > bestCount) {
      bestCount = sts.length;
      bestTrip = tripId;
    }
  }
  if (!bestTrip) return '';
  const sts = byTrip.get(bestTrip).sort((a, b) => a.stop_sequence - b.stop_sequence);
  if (sts.length < 2) return '';

  const first = stopsByStopId.get(String(sts[0].stop_id));
  const last = stopsByStopId.get(String(sts[sts.length - 1].stop_id));
  if (!first?.stop_name || !last?.stop_name) return '';

  // Avoid emitting "Same stop - Same stop" for circular / single-stop
  // services — those cases deserve a manually-curated long_name.
  if (first.stop_name === last.stop_name) return '';

  return `${first.stop_name} - ${last.stop_name}`;
}

/**
 * Title-case a free-text annotation. Used to format parenthetical
 * content stripped during cleanup — "(untold)" → "Untold",
 * "(traseu M21)" → "Traseu M21", "(via X)" → "Via X".
 *
 * Capitalizes the first letter of each whitespace-separated token;
 * preserves the rest of the string verbatim (Romanian diacritics,
 * digits, mixed case stay as-is).
 *
 * @param {string} s
 * @returns {string}
 */
function titleCaseAnnotation(s) {
  return s.split(/\s+/).map((w) => w ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
}

/**
 * Token-overlap check with strict empty-tokens handling. Unlike
 * terminalNamesMatch, returns false (no match) when either side has
 * no substantial tokens (length ≥4 chars). The empty-tokens → true
 * fallback in terminalNamesMatch is wrong for structural validation —
 * "EMERSON" would falsely "match" "C.U.G" because the latter has no
 * tokens ≥4 (just "cug" which is 3 chars after tokenize).
 */
function tokenOverlap(a, b) {
  const tokenize = (s) => {
    const norm = (s || '').toString().toLowerCase()
      .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
      .replace(/ș/g, 's').replace(/ț/g, 't');
    return new Set((norm.match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 4));
  };
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  for (const t of tokensA) {
    if (tokensB.has(t)) return true;
  }
  return false;
}

/**
 * Get the set of stop names that appear on a route's canonical pattern
 * (longest trip). Used to validate whether a desc-terminal actually
 * belongs to the route — if not, the desc's terminal is stale.
 *
 * @returns {Set<string> | null} Set of stop names, or null if no data
 *   available (route has no trips in stop_times).
 */
function getRouteStopNames({ routeId, allStopTimeRows, tripToRoute, stopsByStopId }) {
  if (!allStopTimeRows || !tripToRoute || !stopsByStopId) return null;

  /** @type {Map<string, Array<{ stop_id: string, stop_sequence: number }>>} */
  const byTrip = new Map();
  for (const st of allStopTimeRows) {
    if (tripToRoute.get(String(st.trip_id)) !== routeId) continue;
    if (!byTrip.has(String(st.trip_id))) byTrip.set(String(st.trip_id), []);
    byTrip.get(String(st.trip_id)).push({
      stop_id: String(st.stop_id),
      stop_sequence: Number(st.stop_sequence),
    });
  }
  if (byTrip.size === 0) return null;

  // Pick the longest trip (canonical variant) — same heuristic as
  // deriveLongNameFromStops.
  let bestTrip = null;
  let bestCount = -1;
  for (const [tripId, sts] of byTrip) {
    if (sts.length > bestCount) {
      bestCount = sts.length;
      bestTrip = tripId;
    }
  }
  if (!bestTrip) return null;
  const sts = byTrip.get(bestTrip).sort((a, b) => a.stop_sequence - b.stop_sequence);

  const names = new Set();
  for (const st of sts) {
    const stop = stopsByStopId.get(String(st.stop_id));
    if (stop?.stop_name) names.add(stop.stop_name);
  }
  return names.size > 0 ? names : null;
}

/**
 * Detect when Tranzy's `route_desc` is just a stale long_name variant —
 * a string in "X - Y" format where X matches `route_long_name`'s
 * first terminal and Y does NOT appear in the route's actual stop
 * pattern. Treats the desc as not worth surfacing.
 *
 * Why: live Tranzy data shows ~50 routes where Tranzy publishes a
 * `route_desc` whose terminal pair differs from `route_long_name`
 * (the line was restructured and only one of the two got updated).
 * Without this check, applyRouteCategory's `descHasUniqueInfo`
 * branch preserves the stale desc as "unique info" — surfacing
 * contradictory terminals to consumers (e.g. route 23 shows
 * `route_long_name="P-ta M. Viteazul - C.U.G"` AND
 * `route_desc="P-ta M. Viteazul - EMERSON"`, confusing riders).
 *
 * The strongest possible check is structural: does the desc's
 * second terminal appear as a stop on this route? If it does, the
 * operator intentionally references that stop (maybe as a different
 * service variant / historical headsign) and we should keep the desc.
 * If it doesn't, the desc's destination is stale and we drop it.
 *
 * Returns true (stale) when EITHER terminal is not on this route's
 * pattern — the desc is referencing a stop the line doesn't serve.
 *
 * Returns false (keep) when BOTH terminals appear on the route's
 * pattern — the operator intentionally references real stops.
 */
function isStaleLongNameVariant(cleanedDesc, cleanedLong, routeStopNames) {
  if (!cleanedDesc || !cleanedLong) return false;
  if (!cleanedDesc.includes(' - ') || !cleanedLong.includes(' - ')) return false;
  if (/[()]/.test(cleanedDesc)) return false;

  const descParts = cleanedDesc.split(' - ');
  if (descParts.length < 2) return false;
  const [descFirst, descSecond] = descParts;

  // Structural check: BOTH desc terminals must appear on this route's
  // pattern. We previously required descFirst to fuzzy-match longFirst
  // (the "same line?" check) AND descSecond to be on the route — but
  // that misses the "completely different line" case where Tranzy's
  // desc has neither terminal on this route. e.g. route 42's desc
  // "P-ta M. Viteazul - Str. Campului" — "P-ta M. Viteazul" isn't on
  // route 42 at all (it's "P-ța M.Viteazu Sosire", different token),
  // yet the previous heuristic kept the desc because the first-terminal
  // fuzzy-match happened to fail and we treated "fail" as "not stale".
  //
  // If we have no pattern data (routeStopNames is null/undefined),
  // fall back to "treat as stale" — the safer default.
  if (!routeStopNames) return true;
  let firstOnRoute = false;
  let secondOnRoute = false;
  for (const stopName of routeStopNames) {
    if (tokenOverlap(descFirst, stopName)) firstOnRoute = true;
    if (tokenOverlap(descSecond, stopName)) secondOnRoute = true;
  }
  return !(firstOnRoute && secondOnRoute);
}

/**
 * Apply classification + cleanup + fallback to all route rows in
 * place. Single orchestrator-facing entry point.
 *
 * **Order matters** (and is intentional, not arbitrary):
 *
 *   1. **Classify** against the ORIGINAL Tranzy values, BEFORE cleanup.
 *      Why: `M76A`'s long_name `"TE2 Floresti str. Somesului - Liceul D.
 *      Tautan"` carries the school-bus signal (the `^TE\d+\s+Floresti`
 *      substring). After cleanup strips that prefix, the signal is gone.
 *      So classify first.
 *
 *   2. **Cleanup long_name** via `cleanText()` with `captureStripped`
 *      so we can later pipe parenthetical content into `route_desc`.
 *
 *   3. **Cleanup desc** via `cleanText()` with `captureStripped`,
 *      symmetric with long_name.
 *
 *   4. **route_long_name fallback chain**: cleaned long_name → cleaned
 *      desc (when long_name ended up empty after cleanup but desc has
 *      data) → `<first stop> - <last stop>` from stop_times.
 *
 *   5. **route_desc strategy** (Marius's "all useful information in
 *      Description" rule):
 *      - Stripped parenthetical content (title-cased) is computed once
 *        as a shared pool, with anything matching a category label
 *        filtered out (so we don't redundantly surface "Untold" when
 *        the route is already classified as festival).
 *      - If classified (≥1 category): `route_desc` is the comma-joined
 *        category labels (`"Transport Elevi, Metropolitan"` for 1:many).
 *        If the parenthetical pool has non-redundant content, it's
 *        appended via " | " — e.g. TE routes whose desc ends in
 *        "(Floresti)" → `"Transport Elevi | Floresti"`, so riders see
 *        which commune the school bus serves.
 *      - Else if cleaned desc has data: `route_desc` is the cleaned
 *        desc, possibly combined with stripped parenthetical content
 *        (title-cased) that provides additional info beyond the
 *        cleaned desc.
 *
 * **1:many semantics** live in `route_networks.txt` — one row per
 * (network_id, route_id) so consumers see the n:m mapping natively.
 * Comma-separated labels in `route_desc` are the consumer-side
 * fallback for tools that don't read networks.txt.
 *
 * @param {{
 *   routes: Array<Pick<RouteRow, 'route_id' | 'route_short_name' | 'route_long_name' | 'route_desc'>>,
 *   allStopTimeRows?: Array<{ trip_id: string, stop_id: string, stop_sequence: string|number }>,
 *   tripToRoute?: Map<string, string>,
 *   stopsByStopId?: Map<string, { stop_name?: string }>,
 *   warnings: Array<{ severity: string, message: string }>,
 * }} input
 * @returns {{
 *   classifiedCount: number,
 *   multiNetworkCount: number,
 *   longNameCleanedCount: number,
 *   longNameDerivedCount: number,
 *   longNameUnresolvedCount: number,
 *   descCleanedCount: number,
 *   descFromCleanedCount: number,
 *   descFromStrippedCount: number,
 * }}
 */
export function applyRouteCategory({ routes, allStopTimeRows = [], tripToRoute, stopsByStopId, warnings }) {
  let classifiedCount = 0;
  let multiNetworkCount = 0;
  let longNameCleanedCount = 0;
  let longNameDerivedCount = 0;
  let longNameUnresolvedCount = 0;
  let descCleanedCount = 0;
  let descFromCleanedCount = 0;
  let preservedButSuspiciousCount = 0;
  let descFromStrippedCount = 0;

  for (const row of routes) {
    // 1. Classify against the ORIGINAL row (pre-cleanup).
    const categories = classifyRoute(row);
    if (categories.length > 0) classifiedCount++;
    if (categories.length > 1) multiNetworkCount++;

    // 2. Cleanup long_name (capturing stripped parenthetical content).
    const originalLongName = row.route_long_name ?? '';
    const longResult = cleanText(row, row.route_long_name, true);
    const cleanedLong = longResult.cleaned;
    const strippedLong = longResult.stripped;
    if (cleanedLong !== originalLongName) longNameCleanedCount++;

    // 3. Cleanup desc (capturing stripped parenthetical content).
    const originalDesc = row.route_desc ?? '';
    const descResult = cleanText(row, row.route_desc, true);
    const cleanedDesc = descResult.cleaned;
    const strippedDesc = descResult.stripped;
    if (cleanedDesc !== originalDesc) descCleanedCount++;

    // 4. route_long_name fallback chain: long_name → cleaned desc → stops.
    let resolvedLong = cleanedLong;
    if (!resolvedLong && cleanedDesc) {
      resolvedLong = cleanedDesc;
      longNameDerivedCount++;
    }
    if (!resolvedLong) {
      const derived = deriveLongNameFromStops({
        routeId: row.route_id,
        allStopTimeRows,
        tripToRoute,
        stopsByStopId,
      });
      if (derived) {
        resolvedLong = derived;
        longNameDerivedCount++;
      } else {
        longNameUnresolvedCount++;
      }
    }
    row.route_long_name = resolvedLong;

    // 5. route_desc strategy.
    //
    // Build a unified pool of "useful" parenthetical content — captured
    // from long_name and/or desc cleanup, title-cased, with anything that
    // matches a category label filtered out (so we don't redundantly
    // surface "Untold" when the route is already classified as festival).
    // Dedupe since the same parenthetical often appears in both fields.
    //
    // This pool feeds BOTH branches below:
    //   - Categorized: appended to category labels via " | " (e.g. TE
    //     routes whose desc ends in "(Floresti)" → "Transport Elevi |
    //     Floresti", so riders see which commune the school bus serves).
    //   - Un-categorized: appended to cleaned desc when both contribute
    //     unique info, or used as the desc when cleanedDesc mirrors
    //     cleanedLong (the 88A case).
    const usefulStripped = [...strippedLong, ...strippedDesc]
      .filter((s) => s.length > 0)
      .filter((s) => !CATEGORIES.some((c) => c.label.toLowerCase() === s.toLowerCase()))
      .map(titleCaseAnnotation);

    const seen = new Set();
    const dedupedStripped = usefulStripped.filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });

    if (categories.length > 0) {
      // Categorized. Base = comma-joined category labels (the primary
      // signal for tools that don't read networks.txt). Append captured
      // parenthetical content when it provides non-redundant info.
      const base = categories.map((c) => c.label).join(', ');
      if (dedupedStripped.length > 0) {
        row.route_desc = `${base} | ${dedupedStripped.join(', ')}`;
        descFromStrippedCount++;
      } else {
        row.route_desc = base;
      }
    } else {
      // Un-categorized. Build desc from three sources, in priority order:
      //
      //   a) Stripped parenthetical content (title-cased) — the "exact
      //      mirror" Marius wants. When the long_name had "(traseu M21)"
      //      appended and Tranzy duplicated the same content in desc,
      //      after cleanup both fields have the same "Start - End"
      //      text. The parenthetical content is the only signal that's
      //      NOT in long_name, so it goes to desc.
      //
      //   b) Cleaned desc — if Tranzy's desc had unique info beyond
      //      what was in long_name (e.g. D51's "P-ta Mihai Viteazu -
      //      Gilau"), use it. Combined with stripped content via " | "
      //      when both contribute unique info.
      //
      //   c) Fallback mirror — when neither (a) nor (b) has unique
      //      info, desc = cleanedDesc (which equals cleanedLongName).
      //      Mostly cosmetic; preserves the "desc is a mirror of
      //      long_name" behavior for routes where Tranzy duplicated
      //      the same string in both fields.
      // Structural check: get the route's actual stop names so the stale
      // variant detector can verify the desc's terminal actually
      // appears on this route's pattern (not just "trustable enough"
      // via format matching). Cheaper than it looks — getRouteStopNames
      // picks the longest trip and returns its stop_name set.
      const routeStopNames = getRouteStopNames({
        routeId: row.route_id,
        allStopTimeRows,
        tripToRoute,
        stopsByStopId,
      });
      const descHasUniqueInfo = cleanedDesc && cleanedDesc !== cleanedLong
        && !isStaleLongNameVariant(cleanedDesc, cleanedLong, routeStopNames);

      if (descHasUniqueInfo) {
        // cleaned desc has info not in long_name.
        if (dedupedStripped.length > 0) {
          row.route_desc = `${cleanedDesc} | ${dedupedStripped.join(', ')}`;
          descFromCleanedCount++;
          descFromStrippedCount++;
        } else {
          row.route_desc = cleanedDesc;
          descFromCleanedCount++;
        }
      } else if (dedupedStripped.length > 0) {
        // cleaned desc is just a mirror of long_name (or a stale
        // long_name variant) — surface the parenthetical content as
        // the unique signal.
        row.route_desc = dedupedStripped.join(', ');
        descFromStrippedCount++;
      } else {
        // cleaned desc mirrors long_name and there's no parenthetical
        // content to surface — leave route_desc empty. Marius's
        // PR feedback: a desc that's just a copy of long_name is
        // noise for the consumer (neary, OTP, Google Maps), not info.
        // This also covers stale long_name variants (Tranzy's desc
        // carries a different terminal pair than long_name — e.g.
        // route 23's "P-ta M. Viteazul - EMERSON" vs long_name
        // "P-ta M. Viteazul - C.U.G"; without the stale-variant check
        // we'd surface the contradictory terminal to consumers).
        row.route_desc = '';
      }

      // Operator-visibility log: desc was preserved (terminal IS on
      // the route's pattern) but doesn't match long_name's published
      // destination. Operator may have intentionally referenced a
      // landmark the bus passes through, or it may be partial stale
      // data. Surface per-route as INFO so it's visible in the build
      // log without losing the data.
      //
      // Match threshold for "doesn't match longLast" is exact equality
      // (after normalization), NOT fuzzy — otherwise "P-ta Garii" vs
      // "P-ta Garii Noi" would be treated as matching (shared "garii")
      // and we'd silently swallow the "Noi" qualifier mismatch.
      if (cleanedDesc && cleanedDesc !== cleanedLong && routeStopNames) {
        const descParts = cleanedDesc.split(' - ');
        const longParts = cleanedLong.split(' - ');
        if (descParts.length >= 2 && longParts.length >= 2) {
          const descFirst = descParts[0];
          const descSecond = descParts[1];
          const longFirst = longParts[0];
          const longLast = longParts[1];
          const descFirstMatches = tokenOverlap(descFirst, longFirst);
          const descSecondExactMatches = normalizeStopName(descSecond)
            === normalizeStopName(longLast);
          if (descFirstMatches && !descSecondExactMatches) {
            // Same-line desc, but destination differs from long_name.
            // Verify the terminal is on the route pattern (otherwise
            // it'd already have been dropped by the stale check).
            for (const stopName of routeStopNames) {
              if (tokenOverlap(descSecond, stopName)) {
                preservedButSuspiciousCount++;
                warnings.push({
                  severity: 'info',
                  message:
                    `route_short_name "${row.route_short_name}": desc preserved but terminal differs from long_name's destination. ` +
                    `desc="${cleanedDesc}" long_name="${cleanedLong}". ` +
                    `Terminal is on the route's pattern (likely a landmark the bus passes through) but doesn't match the published endpoint. ` +
                    `Operator: confirm whether the desc is intentional or stale. ` +
                    `See docs/quirks-and-rules.md#stale-route_desc-vs-route_long_name.`,
                  meta: { route: row.route_short_name, kind: 'preserved-but-suspicious' },
                });
                break;
              }
            }
          }
        }
      }
    }
  }

// Build-log INFO summary. Per-row detail is in routes.txt + networks.txt;
    // this is the one-liner for the human reading the build log.
    if (
      classifiedCount > 0 ||
      longNameCleanedCount > 0 ||
      longNameDerivedCount > 0 ||
      longNameUnresolvedCount > 0 ||
      descCleanedCount > 0 ||
      descFromCleanedCount > 0 ||
      descFromStrippedCount > 0
    ) {
      warnings.push({
        severity: 'info',
        message:
          `routes: classified ${classifiedCount} route(s), ${multiNetworkCount} with multiple networks, ` +
          `cleaned ${longNameCleanedCount} long_name + ${descCleanedCount} desc, ` +
          `derived ${longNameDerivedCount} long_name(s) (desc or stops fallback)` +
          (longNameUnresolvedCount > 0 ? `, ${longNameUnresolvedCount} unresolved` : '') +
          `, surfaced ${descFromCleanedCount} cleaned desc + ${descFromStrippedCount} parenthetical(s) (both categorized + un-categorized)` +
          (preservedButSuspiciousCount > 0
            ? `, ${preservedButSuspiciousCount} preserved-but-suspicious desc(s) — operator review recommended`
            : '') +
          ' — see networks.txt + route_networks.txt',
      });
    }

  return {
    classifiedCount,
    multiNetworkCount,
    longNameCleanedCount,
    longNameDerivedCount,
    longNameUnresolvedCount,
    descCleanedCount,
    descFromCleanedCount,
    descFromStrippedCount,
  };
}

/**
 * Get the canonical category list — for `networks.txt` emission in the
 * `emit/networks.js` module.
 */
export function getAllCategories() {
  return CATEGORIES.map(({ id, label }) => ({ id, label }));
}