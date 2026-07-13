// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
import { type RouteRow } from '@n3ary/gtfs-spec/spec';
/**
 * Route category classification + long_name cleanup.
 *
 * Single source of truth for which **network** each route belongs to,
 * which **tag** labels it earns, and how to clean up Tranzy's messy
 * `route_long_name` into start-end format.
 *
 * ## The network-vs-tag split (issue #26)
 *
 * Per the user-facing spec for this adapter (gtfs-adapters#26):
 *
 *   - **Networks** (`networks.txt` + `route_networks.txt`) carry the
 *     operator/service identity. Exactly **2** networks are emitted:
 *
 *       1. `school` (Transport Elevi) -- routes whose `route_short_name`
 *          starts with `TE` (TE1..TE14, TE-OG). Transport Elevi is a
 *          separate contracted operator for school transport.
 *       2. `normal` (Normal) -- every other route. Catch-all network.
 *
 *     The "1:1 by route_id" rule of the public GTFS spec is satisfied
 *     by construction: each route belongs to exactly one of the two
 *     networks.
 *
 *   - **Tags** (rendered as the comma-joined label list in `route_desc`)
 *     carry the service-class taxonomy. Exactly **5** tags exist:
 *
 *       1. `special` (Cursa Speciala)   -- CS / "CURSA SPECIALA"
 *       2. `festival` (Untold)          -- *U suffix / "untold"
 *       3. `night` (Noapte)             -- *N suffix / "noapte"
 *       4. `airport` (Aeroport Expres)  -- A\d short / "aeroport"
 *       5. `metroline` (Metropolitan)   -- M\d short_name
 *
 *     A route can carry multiple tags (1:many), e.g. M26U is both
 *     `festival` AND `metroline` -- `route_desc = "Untold, Metropolitan"`.
 *     The membership is exposed to consumers via `route_desc` only;
 *     no structured `route_networks.txt` row is emitted for tag matches.
 *
 *   - The **school** designation is "network only, no tag". A TE route
 *     is in the `school` network AND has no service-class tag (unless
 *     it also happens to match e.g. `metroline`, in which case it has
 *     the metroline tag -- but no "Transport Elevi" tag).
 *
 *   - The M7x metroline family (M75A..M79C) used to be partially tagged
 *     as `school` because their `route_long_name` starts with
 *     "TE\d+ Floresti". Under the new model, the overbroad long_name
 *     match for school is gone (school is network-only now), so the
 *     M7x family has just the `metroline` tag and lives in the
 *     `normal` network -- same operational semantics as before
 *     (Florești metroline services that happen to also serve school
 *     destinations), with a cleaner data shape.
 *
 * ## Why split networks from tags
 *
 *   - The public GTFS spec's `route_networks.txt` is 1:1 by `route_id`
 *     (PRIMARY KEY on `route_id`). Issue #4 fixed the previous
 *     1:many-violation. The tag membership is 1:many and has to live
 *     somewhere else -- `route_desc` is the simple, portable choice.
 *   - A future `_route_tags` extension (issue #25) can layer on top
 *     of this without changing the network surface.
 *
 * ## Background
 *
 * The classifier runs once at assemble time. Consumers just read the
 * structured fields from `routes.txt` + `networks.txt` +
 * `route_networks.txt` and don't parse free-text signals.
 *
 *   - Tranzy exposes only basic route fields (no service-class
 *     column), so tag info is buried as patterns in `route_short_name`
 *     (`*N`, `*U`, `M*`, `CS`, `TE*`, etc.) and trailing parentheticals
 *     in `route_long_name` / `route_desc` ("(untold)", "(traseu M21)").
 *   - The adapter parses those patterns once here, writes the result
 *     as standard GTFS fields (`route_desc` for tag labels,
 *     `networks.txt` + `route_networks.txt` for the network mapping),
 *     and emits cleaned `route_long_name` in start-end format (with
 *     a stop_times-based fallback for routes where cleaning leaves
 *     it empty).
 *   - `route_short_name` keeps Tranzy's value verbatim -- the
 *     operator's chosen rider-facing identifier (e.g. `25N`, `TE1`,
 *     `M76A`) is the GTFS-spec way to carry service-class info,
 *     and we don't munge it.
 *
 * **Calendar windows** (school-year-only, festival-only) are *not*
 * tracked here -- they're a property of the schedule view, orthogonal
 * to the route's tag. See neary#129 for the ingestion work.
 */

import { terminalNamesMatch, normalizeStopName } from '../emit/trips.ts';

/**
 * TAGS: route service-class taxonomy (1:many per route, drives
 * `route_desc` + the producer-extension `_route_tags` table).
 *
 * Each entry: `{ id, label, icon, color, match(s, l, d) }` where
 *
 *   - `id` is the machine-readable tag_id.
 *   - `label` is the human-readable string (one entry of the
 *     comma-joined `route_desc`).
 *   - `icon` is the lucide-svelte icon-name string the consumer
 *     renders in the tag chip. The adapter owns the icon-to-tag
 *     mapping (one place to update when a new tag ships); the app
 *     just looks the icon up in a registry keyed by this string.
 *     The names are the lucide slugs in `kebab-case` minus the
 *     `lucide-` brand prefix (e.g. `moon`, `map-pin`, `plane`,
 *     `music`, `zap`).
 *   - `color` is the 6-char uppercase hex (no leading `#`) the
 *     consumer renders as the tag chip background. Hand-picked per
 *     tag (NOT derived from route modal hue — tag color is brand
 *     identity, not aggregate signal). The night/airport split
 *     (very-dark-navy vs sky-blue) keeps the two blues perceptually
 *     distinct; the festival color sits in the brand-purple family
 *     deliberately so it reads as "Untold"; special gets burnt
 *     orange as a one-off accent. All 5 colors are dark enough for
 *     white text (`networkTextColor` returns `#000` only above L=0.6
 *     in `pickContrastingText`).
 *   - `match` is a predicate over `(route_short_name, route_long_name,
 *     route_desc)`. We check all three because Tranzy sometimes
 *     carries the signal in just one -- e.g. "(untold)" annotation
 *     lands in `route_desc` for festival routes.
 *
 * Declaration order matters for the comma-join in `route_desc` and
 * for the badge sort in the consumer UI. The position in the
 * array IS the priority (0-indexed, derived by `TAG_INDEX` below).
 *
 * Editorial choice: "everyday first, special-event overlays after".
 * The route's default identity is the lowest-priority tag, and the
 * rarer event-overlays come after. Live consumers (neary's map view
 * + favorites filter) sort by priority ASCENDING for badge display,
 * so the first tag in the list reads as the route's primary
 * identity. Current order:
 *
 *   night     = 0   (default identity for late-evening routes)
 *   metroline = 1   (the suburban/metroline bus network)
 *   airport   = 2
 *   festival  = 3
 *   special   = 4   (rarest; Cursa Speciala)
 *
 * Add new tags at the END so existing priorities stay stable.
 *
 * **`commuter` was removed**: D51 (the only `D*`-prefixed route) is
 * not a commuter rail service -- per ctpcj.ro it's an employee-only /
 * convention transport route, not a public commuter pattern. If a
 * future feed has a genuine commuter service, it can be re-added here
 * with a more specific pattern.
 *
 * The split between TAGS (1:many, optional, producer-extension for
 * the n:m membership) and NETWORKS (1:1, required, public GTFS
 * spec surface) is intentional -- the public GTFS spec's
 * `route_networks.txt` PK is `route_id` alone, so networks can't
 * carry 1:many membership on the public surface. The producer
 * extension `_route_tags` carries that n:m membership.
 */
export const TAGS = [
  {
    id: 'night',
    label: 'Noapte',
    icon: 'moon',
    color: '1A1F36',
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
    id: 'metroline',
    label: 'Metropolitan',
    icon: 'map-pin',
    color: '2E7D5B',
    // Cluj-CTP's own term for the suburban/metroline bus network is
    // "Metropolitan" (per ctpcj.ro). Used in the consumer-facing label
    // because that's what riders search for on the agency site.
    match: (s) => /^M\d/.test(s),
  },
  {
    id: 'airport',
    label: 'Aeroport Expres',
    icon: 'plane',
    color: '0EA5E9',
    match: (s, l, d) =>
      /^A\d/.test(s) ||
      /aeroport/i.test(l) ||
      /aeroport/i.test(d),
  },
  {
    id: 'festival',
    label: 'Untold',
    icon: 'music',
    color: '7B1FA2',
    // Festival services (Untold Music Festival in Cluj). The signal
    // is either:
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
    id: 'special',
    label: 'Cursa Speciala',
    icon: 'zap',
    color: 'C2410C',
    match: (s, l, d) =>
      s === 'CS' || /CURSA SPECIALA/i.test(l) || /CURSA SPECIALA/i.test(d),
  },
];

/**
 * `tag_id` -> position in the `TAGS` array. The canonical "priority"
 * consumers sort by for stable badge ordering. 0-indexed. Built
 * once at module load from the same source as `TAGS`, so a future
 * refactor that rebuilds one without the other throws a loud
 * invariant error in `classifyRoute` rather than shipping a
 * silent priority=0.
 */
const TAG_INDEX = new Map(TAGS.map((cat, i) => [cat.id, i]));

/**
 * NETWORKS: route service-identity taxonomy (1:1 per route, drives
 * the public GTFS `networks.txt` + `route_networks.txt`).
 *
 * Each entry: `{ id, label, match(s, l, d) }` where
 *
 *   - `id` is the machine-readable `network_id` (in `networks.txt`).
 *   - `label` is the human-readable `network_name`.
 *   - `match` is a predicate over `(route_short_name, route_long_name,
 *     route_desc)`. Same pattern as TAGS.
 *
 * Two and exactly two networks ship for cluj: `school` (TE-prefixed
 * Transport Elevi operator) + `normal` (the catch-all fallback for
 * every other route). The 1:1 constraint of the public GTFS spec's
 * `route_networks.txt` is satisfied by construction: each route
 * belongs to exactly one network, and the normal fallback fires
 * for every non-school match.
 *
 * Declaration order is the 1:1 priority-pick order: `classifyNetwork`
 * walks `NETWORKS` in array order; the first non-`normal` match
 * wins, and `normal` (the fallback) is returned when no pattern
 * matches. Putting `normal` second in the array is the convention;
 * the `classifyNetwork` loop explicitly skips it during the
 * pattern-walk phase and only returns it as the fallback.
 *
 * Networks deliberately have no `icon` field. The app renders
 * network chips as color + label only -- no icon. Tags carry the
 * icon; networks don't.
 */
export const NETWORKS = [
  {
    id: 'normal',
    label: 'Normal',
    // Catch-all network for routes that don't match `school`. The
    // `match` returns false by design -- normal is not a pattern, it's
    // the fallback. `classifyNetwork` explicitly skips this entry
    // during the pattern-walk phase and only returns it as the
    // fallback when no other network matches.
    match: () => false,
  },
  {
    id: 'school',
    label: 'Transport Elevi',
    // School-network routes are the Transport Elevi (TE) operator's
    // routes. The match is intentionally broad -- TE-prefixed
    // `route_short_name` (TE1..TE14, TE-OG), TE-prefixed `long_name`
    // (the M7x school-bus family: M76A with long_name "TE1 Floresti
    // ..." or "TE1F"), and the defensive `elevi` substring catch
    // across all 3 fields (catches operator-named variants CTP may
    // introduce later, e.g. "ELEVI-99" or a long_name with "Transport
    // Elevi -").
    //
    // School is a NETWORK, not a tag (gtfs-adapters#26). The M7x
    // family lands in the school network AND the metroline tag (M*
    // short_name) -- so 1 network + 1 tag. A defensive `elevi`
    // substring match in a route's long_name / route_desc puts the
    // route in the school network without surfacing a "Transport
    // Elevi" tag in route_desc (school isn't a tag).
    match: (s, l, d) =>
      /^TE/i.test(s) ||
      /^TE/i.test(l) ||  // M7x school-bus family: long_name="TE1F",
                         // "TE1 Floresti", "TE2 Floresti" (Tranzy
                         // keeps the school designation as long_name
                         // even though short_name has the M* metroline
                         // prefix).
      /elevi/i.test(s) ||
      /elevi/i.test(l) ||
      /elevi/i.test(d),
  },
];

/**
 * Classify a single route's tag list. Returns all matching tags in
 * `TAGS` declaration order. Empty array for regular urban routes
 * that match no tag.
 *
 * **1:many is intentional**: a route can carry multiple tags. The
 * classic case is `M26U` -- `*U` suffix (festival) AND `M*` prefix
 * (metroline). One route, two tags. `route_desc` carries the n:m
 * mapping natively as the comma-joined label list.
 *
 * **Does not include the route's network**. Network assignment is a
 * separate call (`classifyNetwork` / `applyRouteCategory`); the
 * network and tag surfaces are independent -- e.g. an M26U is in the
 * `normal` network and tagged as `festival, metroline`. The school
 * network is a network-only surface, not a tag.
 *
 * @param {{ route_short_name?: string, route_long_name?: string, route_desc?: string }} row
 * @returns {Array<{ id: string, label: string, priority: number, icon?: string, color?: string }>}
 */
export function classifyRoute(row) {
  const s = (row.route_short_name ?? '').toString();
  const l = (row.route_long_name ?? '').toString();
  const d = (row.route_desc ?? '').toString();
  const matches = [];
  for (const cat of TAGS) {
    if (cat.match(s, l, d)) {
      const priority = TAG_INDEX.get(cat.id);
      if (priority === undefined) {
        // Defensive: TAGS and TAG_INDEX are built from the same
        // source, so this can only happen if a future refactor
        // rebuilds one without the other. Surface the invariant
        // breach loudly so it doesn't ship as a silent priority=0.
        throw new Error(
          `classifyRoute: TAG_INDEX missing entry for ${cat.id}; ` +
          'TAGS and TAG_INDEX must stay in sync.',
        );
      }
      matches.push({ id: cat.id, label: cat.label, priority, icon: cat.icon, color: cat.color });
    }
  }
  return matches;
}

/**
 * Classify a single route's network. Returns exactly one network
 * entry: `school` (TE* short_name) or `normal` (the fallback for
 * everything else). The networks.txt schema enforces 1:1 by
 * `route_id`; this function guarantees the same.
 *
 * Exposed for tests + the orchestrator. The internal loop walks
 * `NETWORKS` in declaration order; `school` matches first when
 * the route has the TE pattern, and `normal` is the fallback for
 * everything else.
 *
 * @param {{ route_short_name?: string, route_long_name?: string, route_desc?: string }} row
 * @returns {{ id: string, label: string }}
 */
export function classifyNetwork(row) {
  const s = (row.route_short_name ?? '').toString();
  const l = (row.route_long_name ?? '').toString();
  const d = (row.route_desc ?? '').toString();
  for (const cat of NETWORKS) {
    if (cat.id === 'normal') continue; // normal is the fallback, not a pattern
    if (cat.match(s, l, d)) {
      return { id: cat.id, label: cat.label };
    }
  }
  const normal = NETWORKS.find((c) => c.id === 'normal');
  // `normal` is always in NETWORKS (declared first per the
  // convention). Defensive default if it ever gets removed.
  return normal
    ? { id: normal.id, label: normal.label }
    : { id: 'normal', label: 'Normal' };
}

/**
 * Apply the standard cleanup regex passes to a free-text value (long_name
 * OR desc). Shared between `cleanLongName` and `cleanDesc` so the two
 * fields stay in sync -- if we strip a parenthetical on one, we strip it
 * on the other.
 *
 * Operations, in order:
 *
 *   1. CURSA SPECIALA (`CS`) -> empty. No fixed endpoints -- calling it
 *      "CURSA SPECIALA" is noise that consumers shouldn't have to
 *      special-case.
 *   2. Strip trailing parenthetical annotations: "(untold)", "(traseu
 *      M21)", "(traseu M21) (something else)". When `captureStripped`
 *      is true, the parenthetical CONTENTS are collected (e.g. "untold",
 *      "traseu M21") so the orchestrator can pipe them into `route_desc`
 *      as informational annotations on un-tagged routes.
 *   3. Strip "Transport Elevi -" / "Transport Elevi " prefix for school
 *      routes whose Tranzy data describes the service class rather than
 *      the endpoints ("Transport Elevi Manastur" -> "Manastur"). For
 *      richer start-end extraction (e.g. "Primaverii - Onisifor Ghibu"
 *      for TE1) the CTP website source is required -- tracked in
 *      neary#129.
 *   4. Strip "TE\d+ Floresti" prefix from Tranzy for the M7x school-bus
 *      family. MUST run BEFORE the generic TE-prefix strip below.
 *      (Kept for the live data shape even though those routes are no
 *      longer classified as school; the M7x family still benefits from
 *      the cleanup.)
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
  // "Foo (a) (b)" strips both -> "Foo" and captures ["a", "b"].
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
  //   "TE2 Floresti str. Somesului..." -> "str. Somesului..."
  t = t.replace(/^TE\d+\s+Floresti\s*/i, '');

  // "TE\d+" / "TE-OG" leftover prefix.
  //   "TE1 Manastur" -> "Manastur"
  //   "TE-OG Sala Sporturilor" -> "Sala Sporturilor"
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
 * @returns {string} cleaned long_name (may be empty -- see note above)
 */
export function cleanLongName(row) {
  return cleanText(row, row?.route_long_name ?? '');
}

/**
 * Clean `route_desc` with the same regex passes as `cleanLongName`.
 *
 * Tranzy's `route_desc` carries the same kind of free-text noise as
 * `route_long_name` does -- parenthetical annotations, "Transport Elevi"
 * prefixes, etc. Cleaning it symmetrically means:
 *
 *   - For un-tagged routes (no tag match), `route_desc` keeps the
 *     descriptive text Tranzy published (D51's "P-ta Mihai Viteazu -
 *     Gilau" survives; CS's empty desc stays empty).
 *   - For tagged routes, `route_desc` is overwritten with the
 *     comma-separated tag labels (the canonical structured
 *     representation), so the desc-fallback case for un-tagged
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

  // Pick the longest trip (most stop_times) -- the canonical variant.
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
  // services -- those cases deserve a manually-curated long_name.
  if (first.stop_name === last.stop_name) return '';

  return `${first.stop_name} - ${last.stop_name}`;
}

/**
 * Title-case a free-text annotation. Used to format parenthetical
 * content stripped during cleanup -- "(untold)" -> "Untold",
 * "(traseu M21)" -> "Traseu M21", "(via X)" -> "Via X".
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
 * no substantial tokens (length >=4 chars). The empty-tokens -> true
 * fallback in terminalNamesMatch is wrong for structural validation --
 * "EMERSON" would falsely "match" "C.U.G" because the latter has no
 * tokens >=4 (just "cug" which is 3 chars after tokenize).
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
 * belongs to the route -- if not, the desc's terminal is stale.
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

  // Pick the longest trip (canonical variant) -- same heuristic as
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
 * Detect when Tranzy's `route_desc` is just a stale long_name variant --
 * a string in "X - Y" format where X matches `route_long_name`'s
 * first terminal and Y does NOT appear in the route's actual stop
 * pattern. Treats the desc as not worth surfacing.
 *
 * Why: live Tranzy data shows ~50 routes where Tranzy publishes a
 * `route_desc` whose terminal pair differs from `route_long_name`
 * (the line was restructured and only one of the two got updated).
 * Without this check, applyRouteCategory's `descHasUniqueInfo`
 * branch preserves the stale desc as "unique info" -- surfacing
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
 * pattern -- the desc is referencing a stop the line doesn't serve.
 *
 * Returns false (keep) when BOTH terminals appear on the route's
 * pattern -- the operator intentionally references real stops.
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
  // (the "same line?" check) AND descSecond to be on the route -- but
  // that misses the "completely different line" case where Tranzy's
  // desc has neither terminal on this route. e.g. route 42's desc
  // "P-ta M. Viteazul - Str. Campului" -- "P-ta M. Viteazul" isn't on
  // route 42 at all (it's "P-ța M.Viteazu Sosire", different token),
  // yet the previous heuristic kept the desc because the first-terminal
  // fuzzy-match happened to fail and we treated "fail" as "not stale".
  //
  // If we have no pattern data (routeStopNames is null/undefined),
  // fall back to "treat as stale" -- the safer default.
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
 * Get the set of tag labels whose string matches any `TAGS` label.
 * Used to filter the parenthetical-content pool: a stripped
 * "(untold)" would be redundant if the route is already tagged as
 * `festival` (label "Untold"). The match is case-insensitive.
 *
 * @returns {Set<string>} lowercased tag labels
 */
function tagLabelSetLower() {
  return new Set(TAGS.map((c) => c.label.toLowerCase()));
}

/**
 * Apply classification + cleanup + fallback to all route rows in
 * place. Single orchestrator-facing entry point.
 *
 * **Order matters** (and is intentional, not arbitrary):
 *
 *   1. **Classify tags + network** against the ORIGINAL Tranzy
 *      values, BEFORE cleanup. Why: `M76A`'s long_name
 *      `"TE2 Floresti str. Somesului - Liceul D. Tautan"` no longer
 *      carries a school signal under the new model (school is
 *      network-only), but the same principle applies for other
 *      signals: e.g. a parenthetical stripped by cleanup could
 *      carry a tag signal. So classify first.
 *
 *   2. **Cleanup long_name** via `cleanText()` with `captureStripped`
 *      so we can later pipe parenthetical content into `route_desc`.
 *
 *   3. **Cleanup desc** via `cleanText()` with `captureStripped`,
 *      symmetric with long_name.
 *
 *   4. **route_long_name fallback chain**: cleaned long_name -> cleaned
 *      desc (when long_name ended up empty after cleanup but desc has
 *      data) -> `<first stop> - <last stop>` from stop_times.
 *
 *   5. **route_desc strategy** ("don't override good data" + fallback):
 *      - Run the original "preserve good data" desc strategy: the
 *        route's existing desc content (cleaned desc with unique
 *        info, or stripped parenthetical content) takes priority.
 *        The new-model classification is an ADDITIVE surface -- it
 *        does NOT replace good data.
 *      - Tagged case: `route_desc` is the comma-joined tag labels
 *        (`"Untold, Metropolitan"` for an M26U). If the parenthetical
 *        pool adds non-redundant content, it's appended via " | "
 *        (e.g. M76A with desc "(Floresti)" -> "Metropolitan |
 *        Floresti"). School is NOT a tag, so a school-only route
 *        (TE1) falls through to the un-tagged branch.
 *      - Un-tagged case: `route_desc` is the cleaned desc (if unique
 *        info), or the parenthetical, or ''. As before.
 *      - **Empty-desc fallback**: if the original strategy produced
 *        an empty `route_desc` AND the route has a meaningful
 *        classification (school network, or any tag), fill it with
 *        the labels list (network + tag labels), omitting "Normal".
 *        This is what surfaces "Transport Elevi" for TE routes
 *        (school network, no tag, no cleaned desc, no parenthetical).
 *        Regular urban routes (no tag, normal network) get an empty
 *        desc -- the "Normal" label is omitted because it adds
 *        noise without information.
 *
 * **1:many semantics** live in `route_desc` (the comma-joined tag
 * label list). `route_networks.txt` is 1:1 by `route_id` per the
 * public GTFS spec.
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
 *   multiTagCount: number,
 *   networkCounts: Record<'school' | 'normal', number>,
 *   longNameCleanedCount: number,
 *   longNameDerivedCount: number,
 *   longNameUnresolvedCount: number,
 *   descCleanedCount: number,
 *   descFromCleanedCount: number,
 *   descFromStrippedCount: number,
 *   routeNetworks: Map<string, { id: string, label: string }>,
 *   routeTags: Map<string, Array<{ id: string, label: string, priority: number, icon?: string, color?: string }>>,
 * }}
 */
export function applyRouteCategory({ routes, allStopTimeRows = [], tripToRoute, stopsByStopId, warnings }) {
  let classifiedCount = 0;
  let multiTagCount = 0;
  let networkSchoolCount = 0;
  let networkNormalCount = 0;
  let longNameCleanedCount = 0;
  let longNameDerivedCount = 0;
  let longNameUnresolvedCount = 0;
  let descCleanedCount = 0;
  let descFromCleanedCount = 0;
  let preservedButSuspiciousCount = 0;
  let descFromStrippedCount = 0;

  /** @type {Map<string, { id: string, label: string }>} */
  const routeNetworks = new Map();
  /** @type {Map<string, Array<{ id: string, label: string, priority: number, icon?: string, color?: string }>>} */
  const routeTags = new Map();

  for (const row of routes) {
    // 1. Classify tags + network against the ORIGINAL row
    //    (pre-cleanup). The tag surface is what drives `route_desc`;
    //    the network surface is what drives `route_networks.txt`.
    const tags = classifyRoute(row);
    const network = classifyNetwork(row);

    if (tags.length > 0) classifiedCount++;
    if (tags.length > 1) multiTagCount++;
    if (network.id === 'school') networkSchoolCount++;
    else if (network.id === 'normal') networkNormalCount++;

    routeNetworks.set(row.route_id, network);
    if (tags.length > 0) {
      // `tags` already carries the TAGS-declaration index as
      // `priority` (set by `classifyRoute` from TAG_INDEX). The
      // 1:1 case now distinguishes tags: a 1:1 metroline route
      // is priority 1, a 1:1 festival route is priority 3, etc.
      // (1:many ordering is unchanged: `classifyRoute` walks
      // `TAGS` in declaration order, so the per-route array IS
      // in TAGS order and the priority values are already
      // ascending.)
      routeTags.set(row.route_id, tags);
    }

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

    // 4. route_long_name fallback chain: long_name -> cleaned desc -> stops.
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
    // Build a unified pool of "useful" parenthetical content -- captured
    // from long_name and/or desc cleanup, title-cased, with anything
    // that matches a tag label filtered out (so we don't redundantly
    // surface "Untold" when the route is already tagged as festival).
    // Dedupe since the same parenthetical often appears in both fields.
    //
    // This pool feeds BOTH branches below:
    //   - Tagged: appended to tag labels via " | " (e.g. M26U
    //     routes whose desc ends in "(Floresti)" -> "Metropolitan,
    //     Untold | Floresti", so riders see which commune the route
    //     serves).
    //   - Un-tagged: appended to cleaned desc when both contribute
    //     unique info, or used as the desc when cleanedDesc mirrors
    //     cleanedLong (the 88A case).
    const labelSetLower = tagLabelSetLower();
    const usefulStripped = [...strippedLong, ...strippedDesc]
      .filter((s) => s.length > 0)
      .filter((s) => !labelSetLower.has(s.toLowerCase()))
      .map(titleCaseAnnotation);

    const seen = new Set();
    const dedupedStripped = usefulStripped.filter((s) => {
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });

    // "Don't override good data" -- the original "preserve good data"
    // desc strategy takes priority. The new-model classification is
    // an ADDITIVE surface -- it only fills in route_desc when the
    // original strategy produced an empty string. The empty-desc
    // fallback (below) handles the "route has a classification but
    // no good desc to surface" case (TE1, ELEVI-99, ...).
    if (tags.length > 0) {
      // Tagged. Base = comma-joined tag labels (TAGS declaration
      // order). Append captured parenthetical content when it
      // provides non-redundant info. School is not a tag, so a
      // school-route with no tag falls through to the un-tagged
      // branch below.
      const base = tags.map((t) => t.label).join(', ');
      if (dedupedStripped.length > 0) {
        row.route_desc = `${base} | ${dedupedStripped.join(', ')}`;
        descFromStrippedCount++;
      } else {
        row.route_desc = base;
      }
    } else {
      // Un-tagged. Build desc from three sources, in priority order:
      //
      //   a) Stripped parenthetical content (title-cased) -- the "exact
      //      mirror" Marius wants. When the long_name had "(traseu M21)"
      //      appended and Tranzy duplicated the same content in desc,
      //      after cleanup both fields have the same "Start - End"
      //      text. The parenthetical content is the only signal that's
      //      NOT in long_name, so it goes to desc.
      //
      //   b) Cleaned desc -- if Tranzy's desc had unique info beyond
      //      what was in long_name (e.g. D51's "P-ta Mihai Viteazu -
      //      Gilau"), use it. Combined with stripped content via " | "
      //      when both contribute unique info.
      //
      //   c) Fallback mirror -- when neither (a) nor (b) has unique
      //      info, desc = cleanedDesc (which equals cleanedLongName).
      //      Mostly cosmetic; preserves the "desc is a mirror of
      //      long_name" behavior for routes where Tranzy duplicated
      //      the same string in both fields.
      // Structural check: get the route's actual stop names so the stale
      // variant detector can verify the desc's terminal actually
      // appears on this route's pattern (not just "trustable enough"
      // via format matching). Cheaper than it looks -- getRouteStopNames
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
        // long_name variant) -- surface the parenthetical content as
        // the unique signal.
        row.route_desc = dedupedStripped.join(', ');
        descFromStrippedCount++;
      } else {
        // cleaned desc mirrors long_name and there's no parenthetical
        // content to surface -- leave route_desc empty. The empty-
        // desc fallback (below) handles the "route has a
        // classification but no good desc" case.
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
      // (after normalization), NOT fuzzy -- otherwise "P-ta Garii" vs
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

    // Empty-desc fallback. If the original desc strategy above left
    // route_desc empty AND the route has a meaningful classification
    // (school network, or any tag), fill it with the labels list
    // (network + tag labels), omitting "Normal".
    //
    // Why this exists: a school-route like TE1 has tags=[] and no
    // cleaned desc / parenthetical to surface. The school designation
    // is in route_networks.txt (the structured join), but the human-
    // readable route_desc would otherwise be empty -- losing the
    // operator-identity signal. The fallback restores it.
    //
    // Why "omit Normal": the normal network is the catch-all for
    // un-classified routes. Surfacing "Normal" on every regular urban
    // route's route_desc would be noise without information (regular
    // urban routes are most of the feed). The fallback only fires
    // for routes with a real classification -- school, or any tag.
    if (!row.route_desc) {
      const labels = [network.label, ...tags.map((t) => t.label)];
      const filtered = labels.filter((l) => l !== 'Normal');
      if (filtered.length > 0) {
        row.route_desc = filtered.join(', ');
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
          `routes: tagged ${classifiedCount} route(s) (${multiTagCount} with multiple tags), ` +
          `networked ${networkSchoolCount} school + ${networkNormalCount} normal, ` +
          `cleaned ${longNameCleanedCount} long_name + ${descCleanedCount} desc, ` +
          `derived ${longNameDerivedCount} long_name(s) (desc or stops fallback)` +
          (longNameUnresolvedCount > 0 ? `, ${longNameUnresolvedCount} unresolved` : '') +
          `, surfaced ${descFromCleanedCount} cleaned desc + ${descFromStrippedCount} parenthetical(s) (both tagged + un-tagged)` +
          (preservedButSuspiciousCount > 0
            ? `, ${preservedButSuspiciousCount} preserved-but-suspicious desc(s) -- operator review recommended`
            : '') +
          ' -- see networks.txt + route_networks.txt',
      });
    }

  return {
    classifiedCount,
    multiTagCount,
    networkCounts: { school: networkSchoolCount, normal: networkNormalCount },
    longNameCleanedCount,
    longNameDerivedCount,
    longNameUnresolvedCount,
    descCleanedCount,
    descFromCleanedCount,
    descFromStrippedCount,
    routeNetworks,
    routeTags,
  };
}

/**
 * Get the canonical tag list -- used by consumers that need to know
 * which tag ids exist for the cluj adapter. For networks, use
 * `getAllNetworks` instead.
 *
 * @returns {Array<{ id: string, label: string, icon?: string, color?: string }>}
 */
export function getAllTags() {
  return TAGS.map(({ id, label, icon, color }) => ({ id, label, icon, color }));
}

/**
 * Get the canonical network list -- for `networks.txt` emission in
 * the `emit/networks.js` module. The list is in declaration order,
 * which is the order `networks.txt` will emit rows in.
 *
 * @returns {Array<{ id: string, label: string }>}
 */
export function getAllNetworks() {
  return NETWORKS.map(({ id, label }) => ({ id, label }));
}

/**
 * Back-compat shim: returns the unified tag + network list (the
 * consumers that imported `getAllCategories` get both surfaces in
 * one array). Prefer `getAllTags` or `getAllNetworks` for the
 * specific surface.
 *
 * Kept because earlier code paths in this file and downstream
 * modules imported `getAllCategories`; renaming would have churned
 * the test suite. The semantics: tags first (in `TAGS` order),
 * then networks (in `NETWORKS` order), with each entry carrying
 * `surface: 'tag' | 'network'` so consumers can distinguish.
 *
 * @returns {Array<{ id: string, label: string, surface: 'tag' | 'network', icon?: string, color?: string }>}
 */
export function getAllCategories() {
  return [
    ...TAGS.map(({ id, label, icon, color }) => ({ id, label, surface: 'tag', icon, color })),
    ...NETWORKS.map(({ id, label }) => ({ id, label, surface: 'network' })),
  ];
}
