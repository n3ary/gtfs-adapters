// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
import { RouteRowSchema, serializeRows, type RouteRow } from '@n3ary/gtfs-spec/spec';
/**
 * Routes reconciliation.
 *
 * **Tranzy is the primary catalog.** Cluj-Napoca city hall promotes
 * Tranzy as the authoritative live source for the network (per
 * `docs/known-limitations.md` §3 and `https://ctpcj.ro/index.php/ro/
 * despre-noi/open-data-tranzy`), so Tranzy is more up-to-date than
 * the Transitous `mdb-2121` mirror: 168 vs 108 routes, with the gap
 * mostly in newer metropolitan lines (M22–M81, etc.).
 *
 * Transitous is consulted only for **ID stability** — downstream apps
 * (notably `neary`) key routes by `route_id`, and we don't want to
 * break those references every time Tranzy's internal numeric IDs
 * rotate. So when a route exists in BOTH sources:
 *   - The published row uses **Transitous's `route_id`** (downstream
 *     apps keep working without re-mapping).
 *   - The row's content (color, long_name, etc.) is **Tranzy's** (the
 *     live source — Tranzy's color/long_name override Transitous's).
 *
 * Routes only in Tranzy: included with Tranzy's `route_id`.
 * Routes only in Transitous: included with Transitous's `route_id`.
 *
 * See `docs/assemble-rules.md` for the priority table.
 */

import { info } from '../../lib/log-severity.ts';
import { canonicalShortName } from '../../sources/ctp-csv/shortname-aliases.ts';

/**
 * Normalize a color value to the GTFS-spec `Color` type: six-digit hex,
 * uppercased, no leading `#`. Accepts:
 *   - `'#abc'`  / `'abc'`     → `'AABBCC'` (CSS 3-char shorthand expanded)
 *   - `'#abcdef'` / `'abcdef'` → `'ABCDEF'`
 *   - empty / nullish / malformed → `''` (caller decides the fallback)
 *
 * Per https://gtfs.org/documentation/schedule/reference/#field-types
 * a `Color` MUST be six hex digits with no `#`. Tranzy occasionally
 * returns CSS 3-char shorthand (e.g. `'000'` for black on ~80 routes),
 * which is spec-violating; we expand rather than pass it through.
 */
function normalizeColor(raw) {
  let c = (raw ?? '').toString().replace(/^#?/, '').toUpperCase();
  if (c.length === 3 && /^[0-9A-F]{3}$/.test(c)) {
    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  return /^[0-9A-F]{6}$/.test(c) ? c : '';
}

// Tranzy-specific: `#000` / `#000000` is used as "no color set" on ~80
// CTP routes (verified 2026-06-30 against live API). Normalized form is
// `'000000'`. This isn't a value the operator intends — it's Tranzy's
// silent default — so we treat it the same as missing.
const TRANZY_BLACK_SENTINELS = new Set(['000000']);

// Generic placeholders any source might emit as "no signal". Empty for
// now; extend when we onboard agencies that use other off-the-shelf
// defaults (e.g. some operators emit `'808080'` grey or `'FFFFFF'` to
// mean "use the consumer default").
const GENERIC_PLACEHOLDERS = new Set();

const PLACEHOLDER_COLORS = new Set([...TRANZY_BLACK_SENTINELS, ...GENERIC_PLACEHOLDERS]);

// === OKLCh hue rotation ===================================================
// Used by the modal-collision resolver below. OKLab (Björn Ottosson, 2020 —
// https://bottosson.github.io/posts/oklab/) is a perceptually uniform color
// space: rotating hue in OKLCh changes the perceived color family while
// keeping lightness and chroma identical. Compared to HSL rotation this:
//   - preserves perceived brightness (so white-on-color contrast holds),
//   - produces genuinely different colors rather than tints/shades of the
//     same hue.
// We inline the matrices rather than depend on a color library because the
// arithmetic is small and the constants are stable reference values.

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]) {
  return [r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c) {
  // Clamp to sRGB gamut. Pure hue rotation in OKLCh can land slightly
  // outside [0,1]; clipping is a simple gamut map that's adequate for
  // badge colors. For more rigorous gamut handling we'd reduce chroma
  // until in-gamut — not worth it here.
  const clamped = Math.max(0, Math.min(1, c));
  const v = clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return v * 255;
}

function rgbToOklab([R, G, B]) {
  const r = srgbToLinear(R);
  const g = srgbToLinear(G);
  const b = srgbToLinear(B);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const lin_l = l_ ** 3;
  const lin_m = m_ ** 3;
  const lin_s = s_ ** 3;
  return [
    linearToSrgb( 4.0767416621 * lin_l - 3.3077115913 * lin_m + 0.2309699292 * lin_s),
    linearToSrgb(-1.2684380046 * lin_l + 2.6097574011 * lin_m - 0.3413193965 * lin_s),
    linearToSrgb(-0.0041960863 * lin_l - 0.7034186147 * lin_m + 1.7076147010 * lin_s),
  ];
}

/**
 * Rotate a 6-char hex color around the OKLCh hue wheel by `degrees`.
 * Lightness and chroma are preserved; only hue changes.
 *
 * Examples (3-decimal precision will vary across runtimes but order of
 * magnitude is stable):
 *   rotateHueOklch('F3513C', 0)    → 'F3513C' (no change)
 *   rotateHueOklch('F3513C', 120)  → green-ish
 *   rotateHueOklch('F3513C', 240)  → purple-ish
 */
function rotateHueOklch(hex, degrees) {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  const C = Math.sqrt(a * a + b * b);
  const h = Math.atan2(b, a) + (degrees * Math.PI) / 180;
  return rgbToHex(oklabToRgb([L, C * Math.cos(h), C * Math.sin(h)]));
}

/**
 * Euclidean distance between two hex colors in OKLab space (sometimes
 * called ΔE_OK). Perceptually uniform — same numeric distance ≈ same
 * perceived difference regardless of where in the gamut.
 *
 * Reference thresholds (rough):
 *  - < 0.02 — nearly identical, JND territory
 *  - 0.05 — visible but easy to confuse
 *  - 0.15 — "clearly different colors"
 */
function oklabDistance(hexA, hexB) {
  const [La, aa, ba] = rgbToOklab(hexToRgb(hexA));
  const [Lb, ab, bb] = rgbToOklab(hexToRgb(hexB));
  const dL = La - Lb;
  const da = aa - ab;
  const db = ba - bb;
  return Math.sqrt(dL * dL + da * da + db * db);
}

// Minimum OKLab distance a skewed modal must keep from every special
// (one-off) color and every other assigned modal. 0.15 is the
// "clearly different colors" threshold — small enough that nearly
// every rotation finds a valid landing within a few search steps,
// large enough that the result is visually distinguishable.
const OKLAB_DISTINCT_THRESHOLD = 0.15;

/**
 * Find a hue rotation of `baseColor` that lands at least
 * `OKLAB_DISTINCT_THRESHOLD` away from every color in `forbiddenColors`.
 *
 * Tries `idealDegrees` first, then drifts outward in ±15° steps up to
 * ±180°. Returns the first angle that clears the threshold; if none
 * does, returns the angle that maximizes the minimum distance (best
 * effort — better to land "as far as possible" than to collide
 * exactly).
 */
function findSafeRotation(baseColor, idealDegrees, forbiddenColors) {
  const candidates = [idealDegrees];
  for (let off = 15; off <= 180; off += 15) {
    candidates.push(idealDegrees + off);
    candidates.push(idealDegrees - off);
  }
  const forbidden = [...forbiddenColors].filter(Boolean);
  let bestColor = null;
  let bestDegrees = idealDegrees;
  let bestMinDist = -Infinity;
  for (const deg of candidates) {
    const candidate = rotateHueOklch(baseColor, deg);
    const minDist = forbidden.length === 0
      ? Infinity
      : Math.min(...forbidden.map((fc) => oklabDistance(candidate, fc)));
    if (minDist >= OKLAB_DISTINCT_THRESHOLD) {
      return { color: candidate, degrees: deg };
    }
    if (minDist > bestMinDist) {
      bestMinDist = minDist;
      bestColor = candidate;
      bestDegrees = deg;
    }
  }
  return { color: bestColor, degrees: bestDegrees };
}

/**
 * Resolve modal-color collisions between route_types by hue-rotating
 * shared modals so each type ends up visually distinct AND clear of
 * any existing one-off route colors in the catalog.
 *
 * Strategy:
 *  - Group `typeTopColors` by color. Singletons are kept as-is.
 *  - For each shared color, sort the colliding types by route count
 *    (the type with the most routes at that color keeps it — least
 *    churn), then by route_type number for deterministic ordering.
 *  - The i-th remaining type (i ≥ 1) gets the color rotated by an
 *    ideal `i * 360°/N`, then nudged via `findSafeRotation()` if that
 *    landing falls within `OKLAB_DISTINCT_THRESHOLD` of any forbidden
 *    color (one-offs already in the catalog + modals already assigned
 *    to other types during this pass).
 *
 * Mutates `typeTopColors` to point each skewed type at its new color
 * and returns `[{ type, fromColor, toColor }]` so the caller can
 * back-fill the route rows and log what changed.
 */
function resolveModalCollisions(typeTopColors, routeCountAtModal, allRouteColors) {
  const byColor = new Map();
  for (const [type, color] of typeTopColors) {
    if (!byColor.has(color)) byColor.set(color, []);
    byColor.get(color).push(type);
  }
  const skews = [];
  for (const [color, types] of byColor) {
    if (types.length < 2) continue;
    types.sort(
      (a, b) =>
        (routeCountAtModal.get(b) ?? 0) - (routeCountAtModal.get(a) ?? 0) ||
        Number(a) - Number(b),
    );
    const N = types.length;
    const step = 360 / N;
    // Forbidden = every catalog color except the one we're rotating
    // away from. Modals assigned during this pass get appended as we
    // go so later iterations also avoid earlier picks.
    const forbidden = new Set([...allRouteColors].filter((c) => c && c !== color));
    for (let i = 1; i < N; i++) {
      const ideal = i * step;
      const { color: newColor } = findSafeRotation(color, ideal, forbidden);
      typeTopColors.set(types[i], newColor);
      forbidden.add(newColor);
      skews.push({ type: types[i], fromColor: color, toColor: newColor });
    }
  }
  return skews;
}

/**
 * For each `route_type`, find the most-frequent non-placeholder
 * `route_color` across Tranzy's catalog. Returns a Map<typeString, color>.
 *
 * Why derive from data: the operator (CTP Cluj) doesn't publish a brand
 * palette anywhere we can ingest. Tranzy's own per-route colors are
 * partly random — for buses the top two are `#000` (74 routes) and
 * `#f3513c` (68 routes), with the rest one-offs — but the modal non-
 * placeholder color per type is a defensible "this is what most routes
 * of this mode look like" signal we can use to fill in the rest.
 */
function computeTypeTopColors(tranzyRoutes) {
  const counts = new Map(); // type → Map<color, count>
  for (const r of tranzyRoutes ?? []) {
    if (r.route_type == null) continue;
    const color = normalizeColor(r.route_color);
    if (!color || PLACEHOLDER_COLORS.has(color)) continue;
    const type = String(r.route_type);
    if (!counts.has(type)) counts.set(type, new Map());
    const inner = counts.get(type);
    inner.set(color, (inner.get(color) ?? 0) + 1);
  }
  const top = new Map();
  for (const [type, inner] of counts) {
    let bestColor = '';
    let bestCount = 0;
    for (const [color, n] of inner) {
      if (n > bestCount) { bestCount = n; bestColor = color; }
    }
    if (bestColor) top.set(type, bestColor);
  }
  return top;
}

/**
 * Resolve a route_color, substituting placeholders / invalid values
 * with the modal color for the route's type. Returns the final color
 * (uppercased 6-char hex, no `#`) and the reason for substitution if
 * any, so the caller can tally per-reason counts for the build log.
 *
 * Two substitution reasons are tracked:
 *  - `'placeholder'` — raw input normalized to a known no-signal
 *    sentinel (currently `'000000'`).
 *  - `'invalid'` — raw input was missing or not a parseable hex (e.g.
 *    Tranzy returning literal `'xxx'`, `null`, or a 7-char string).
 *
 * Both are substituted identically; the distinction exists only in
 * the build log so each row's origin is auditable.
 */
function resolveRouteColor(rawColor, routeType, typeTopColors) {
  const normalized = normalizeColor(rawColor);
  if (normalized && !PLACEHOLDER_COLORS.has(normalized)) {
    return { color: normalized, substitutedFrom: null };
  }
  const typeTop = typeTopColors.get(routeType);
  if (!typeTop) {
    return { color: normalized, substitutedFrom: null };
  }
  return {
    color: typeTop,
    substitutedFrom: PLACEHOLDER_COLORS.has(normalized) ? 'placeholder' : 'invalid',
  };
}

/**
 * @param {{
 *   seed: { routes: Array<{routeId, shortName, longName, type, color}>, agencyTxt: string },
 *   tranzy: { routes: any[] } | null,
 *   warnings: string[],
 * }} input
 * @returns {{
 *   routes: RouteRow[],
 *   byRouteId: Map<string, RouteRow>,
 * }}
 */
export function reconcileRoutes({ seed, tranzy, warnings }) {
  /** @type {Map<string, RouteRow>} */
  const byRouteId = new Map();
  /** @type {Map<string, any>} */
  // Keyed by canonical CTP-side name (post-alias, post-normalize) so
  // Tranzy's `39C` and Transitous's `39 CREIC` map to the same row.
  // The raw catalog-side names are still preserved on each row's
  // `route_short_name` field for downstream `routes.txt` output.
  const tranzyByCanonical = new Map();
  /** @type {Map<string, any>} */
  const seedByCanonical = new Map();
  const routes = [];

  // ── Step 1: Tranzy is the base catalog. Every Tranzy route becomes
  // a row keyed by its Tranzy route_id. We track them by canonical
  // short_name so the Transitous pass can look up the matching row
  // for ID-stability upgrades (using canonical names means the lookup
  // works even when Tranzy and Transitous spell the same route
  // differently — e.g. `39C` vs `39 CREIC`).
  let tranzyAdded = 0;
  // Per-type tally of substitutions, broken down by reason. Empty until
  // a substitution fires, then keyed by route_type → { placeholder, invalid }.
  /** @type {Map<string, { placeholder: number, invalid: number }>} */
  const colorSubstitutions = new Map();
  const tallySub = (routeType, reason) => {
    if (!colorSubstitutions.has(routeType)) {
      colorSubstitutions.set(routeType, { placeholder: 0, invalid: 0 });
    }
    colorSubstitutions.get(routeType)[reason]++;
  };
  const typeTopColors = tranzy && Array.isArray(tranzy.routes)
    ? computeTypeTopColors(tranzy.routes)
    : new Map();
  if (tranzy && Array.isArray(tranzy.routes)) {
    for (const r of tranzy.routes) {
      const id = r.route_id ? String(r.route_id) : null;
      if (!id) continue;
      if (byRouteId.has(id)) continue;
      const shortName = (r.route_short_name ?? '').toString().trim();
      const canonical = canonicalShortName(shortName);
      // `?? '3'` not `?` — the GTFS enum 0 (tram) is a valid value that
      // `?` would treat as missing and demote to bus.
      const routeType = String(r.route_type ?? '3');
      const { color: routeColor, substitutedFrom } =
        resolveRouteColor(r.route_color, routeType, typeTopColors);
      if (substitutedFrom) tallySub(routeType, substitutedFrom);
      const row = {
        route_id: id,
        agency_id: '2', // CTP Cluj-Napoca
        route_short_name: shortName,
        route_long_name: r.route_long_name,
        route_type: routeType,
        route_color: routeColor,
        // route_text_color is set uniformly in Step 3.
        route_desc: r.route_desc,
      };
      byRouteId.set(id, row);
      routes.push(row);
      if (canonical) tranzyByCanonical.set(canonical, row);
      tranzyAdded++;
    }
  }

  // ── Step 2: Transitous is the ID-stability overlay. For each
  // Transitous route, if we already added the matching Tranzy row by
  // canonical short_name, swap the published route_id to Transitous's
  // value so downstream apps (neary catalog, etc.) keep their
  // references. Tranzy stays authoritative for content (route_type,
  // colors, names); Transitous only fills fields Tranzy left empty.
  let tranzyUpgradedToTransitousId = 0;
  let transitousOnlyAdded = 0;
  for (const r of seed.routes) {
    if (!r.routeId) continue;
    const shortName = (r.shortName ?? '').toString().trim();
    const canonical = canonicalShortName(shortName);
    if (shortName && tranzyByCanonical.has(canonical)) {
      // Shared route — upgrade the existing Tranzy row's route_id to
      // Transitous's, and patch any missing fields from the seed.
      const tranzyRow = tranzyByCanonical.get(canonical);
      const oldId = tranzyRow.route_id;
      const newId = String(r.routeId);
      if (oldId !== newId) {
        byRouteId.delete(oldId);
        tranzyRow.route_id = newId;
        byRouteId.set(newId, tranzyRow);
        tranzyUpgradedToTransitousId++;
      }
      if (tranzyRow.route_type == null && r.type != null) tranzyRow.route_type = String(r.type);
      if (!tranzyRow.route_color) {
        const seedColor = normalizeColor(r.color);
        if (seedColor && !PLACEHOLDER_COLORS.has(seedColor)) tranzyRow.route_color = seedColor;
      }
      // route_text_color: always white (Step 3). Seed text colors are
      // ignored so the whole feed renders consistently.
      if (!tranzyRow.route_long_name && r.longName) tranzyRow.route_long_name = r.longName;
      // Remember the match so a Transitous-only fallback (no Tranzy)
      // wouldn't double-add this canonical name.
      seedByCanonical.set(canonical, tranzyRow);
      continue;
    }
    // Transitous-only route (Tranzy doesn't have it).
    if (byRouteId.has(r.routeId)) continue;
    const seedType = String(r.type ?? '3');
    const { color: seedColor, substitutedFrom } =
      resolveRouteColor(r.color, seedType, typeTopColors);
    if (substitutedFrom) tallySub(seedType, substitutedFrom);
    const row = {
      route_id: String(r.routeId),
      agency_id: '2',
      route_short_name: shortName,
      route_long_name: r.longName,
      // `?? '3'` not `?` — see Step 1 comment; type=0 is valid.
      route_type: seedType,
      route_color: seedColor,
      // route_text_color is set uniformly in Step 3.
    };
    byRouteId.set(row.route_id, row);
    routes.push(row);
    if (canonical) seedByCanonical.set(canonical, row);
    transitousOnlyAdded++;
  }

  // ── Step 3: Producer-side defaults for the color pair, applied to
  // every row before serialization. Per the GTFS spec
  // (https://gtfs.org/documentation/schedule/reference/#routestxt):
  //   - route_color defaults to FFFFFF (white) when omitted.
  //   - route_text_color defaults to 000000 (black) when omitted.
  //   - The producer SHOULD ensure sufficient contrast between them.
  //
  // Step 1 / 2 already substitute the modal per-type color for any
  // route whose source value was black or missing, so most rows already
  // have a non-black background. The only `route_color` that falls
  // through to `FFFFFF` here is the degenerate case where the type
  // had no non-black examples in Tranzy to derive a modal from.
  //
  // `route_text_color` is forced to white. Tranzy never returns a text
  // color (all 168 are null) and the modal backgrounds we substitute in
  // are dark enough (`#f3513c`, `#000`, etc.) that white is the only
  // value that satisfies the spec's contrast requirement across the
  // catalog. Picking one value also keeps the feed visually consistent.
  for (const row of routes) {
    if (!row.route_color) row.route_color = 'FFFFFF';
    row.route_text_color = 'FFFFFF';
  }

  // Note: route category classification + `route_long_name` cleanup
  // used to live here as Step 4. It moved to `src/assemble/index.js`
  // so it can run AFTER trip generation — the cleanup pass now uses
  // `deriveLongNameFromStops()` as a fallback when cleaning leaves
  // `route_long_name` empty, and that needs `stop_times.txt` data
  // which Step 4 didn't have access to. See neary#125 / neary#129
  // for the design discussion.

  // Build-log summary. One line per category — the per-row detail is
  // already in routes.txt, so grepping is enough for auditing.
  if (tranzyAdded > 0) {
    const onlyInTranzy = tranzyAdded - tranzyUpgradedToTransitousId;
    warnings.push(info(
      `routes: Tranzy primary catalog — ${tranzyAdded} routes total` +
      (onlyInTranzy > 0 ? `, ${onlyInTranzy} Tranzy-only` : '') +
      (tranzyUpgradedToTransitousId > 0 ? `, ${tranzyUpgradedToTransitousId} shared with Transitous (re-keyed to Transitous route_id for downstream stability)` : ''),
    ));
  }
  if (transitousOnlyAdded > 0) {
    warnings.push(info(`routes: ${transitousOnlyAdded} Transitous-only (Tranzy missing)`));
  }
  if (colorSubstitutions.size > 0) {
    const TYPE_LABELS = { 0: 'tram', 3: 'bus', 11: 'trolleybus' };
    const renderBreakdown = (reason) => {
      const parts = [...colorSubstitutions.entries()]
        .filter(([, counts]) => counts[reason] > 0)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([type, counts]) => {
          const label = TYPE_LABELS[Number(type)] ?? `type=${type}`;
          const top = typeTopColors.get(type) ?? 'FFFFFF';
          return `${counts[reason]} ${label} → #${top}`;
        });
      return parts.length > 0 ? parts.join(', ') : null;
    };
    const placeholderBreakdown = renderBreakdown('placeholder');
    if (placeholderBreakdown) {
      warnings.push(info(
        `routes: substituted placeholder route_color (000000 sentinel) with modal per-type color — ${placeholderBreakdown}`,
      ));
    }
    const invalidBreakdown = renderBreakdown('invalid');
    if (invalidBreakdown) {
      warnings.push(info(
        `routes: substituted invalid/missing route_color with modal per-type color — ${invalidBreakdown}`,
      ));
    }
  }

  // Cross-type collision resolution. If two route_types resolve to the
  // same modal color (Tranzy's CTP catalog has tram + bus + most
  // trolleybuses all sharing `#F3513C`), hue-rotate the smaller types
  // around the OKLCh wheel so each mode ends up visually distinct.
  // One-off route colors (e.g. trolleybus `5N`'s blue) are preserved —
  // only routes whose current `route_color` equals the colliding modal
  // are reassigned.
  if (typeTopColors.size > 1) {
    const TYPE_LABELS = { 0: 'tram', 3: 'bus', 11: 'trolleybus' };
    // Count routes per type that currently render at the type's modal,
    // so the collision resolver can keep the busiest type unchanged.
    const routeCountAtModal = new Map();
    const allRouteColors = new Set();
    for (const row of routes) {
      if (row.route_color) allRouteColors.add(row.route_color);
      const type = String(row.route_type);
      const modal = typeTopColors.get(type);
      if (modal && row.route_color === modal) {
        routeCountAtModal.set(type, (routeCountAtModal.get(type) ?? 0) + 1);
      }
    }
    const skews = resolveModalCollisions(typeTopColors, routeCountAtModal, allRouteColors);
    if (skews.length > 0) {
      // Back-fill: every route of a skewed type that's currently at the
      // colliding modal gets the new skewed color. Non-modal routes are
      // untouched, preserving operator-meaningful one-offs.
      const skewByType = new Map(skews.map((s) => [s.type, s]));
      for (const row of routes) {
        const skew = skewByType.get(String(row.route_type));
        if (skew && row.route_color === skew.fromColor) {
          row.route_color = skew.toColor;
        }
      }
      const parts = skews.map((s) => {
        const label = TYPE_LABELS[Number(s.type)] ?? `type=${s.type}`;
        return `${label} #${s.fromColor} → #${s.toColor}`;
      });
      warnings.push(info(
        `routes: modal route_color collision resolved by OKLCh hue rotation — ${parts.join(', ')}. ` +
        `Type with the most routes at the colliding color kept it; others were skewed to maximize perceptual separation.`,
      ));
    }
  }

  return { routes, byRouteId };
}

/**
 * Serialize routes rows to GTFS routes.txt body.
 *
 * @param {Array<object>} routes  output of `reconcileRoutes`
 * @returns {Promise<string>}
 */
export async function routesToTxt(routes) {
  // Spec-driven serializer — same pattern as stopsToTxt. Column order
  // comes from `Object.keys(RouteRowSchema.shape)` and drives both
  // header AND value positions, so reordering fields in the schema
  // can't silently desync the output.
  return serializeRows(RouteRowSchema, routes);
}