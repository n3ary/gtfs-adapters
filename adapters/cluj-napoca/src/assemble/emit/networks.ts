// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).

import { type RouteRow, networksToTxt, routeNetworksToTxt } from '@n3ary/gtfs-spec/spec';

// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Emit GTFS `networks.txt` + `route_networks.txt` from classified routes.
 *
 * Per the GTFS spec (https://gtfs.org/schedule/reference/#networkstxt),
 * networks are groupings of routes — operators use them for service
 * families (TfL: "Underground", "Buses", "Overground"). We extend that
 * semantic to service classes (school, festival, night) — the spec
 * doesn't constrain networks to operator groupings, and the many-to-many
 * `route_networks.txt` join handles the cases we need.
 *
 * **Why both networks.txt and route_desc?** Two consumers:
 *
 *   1. Consumers reading `route_desc` directly (current pattern across
 *      GTFS tooling) get the human label for free — `route_desc` is set
 *      to the same string as `network_name` for the matching network.
 *   2. Consumers using `route_networks.txt` get a structured
 *      `network_id` they can map to icons, colors, and per-feed styling
 *      without parsing free text.
 *
 * Keeping `route_desc == network_name` means the two paths stay in sync
 * — if you change a label in CATEGORIES, both surfaces update.
 *
 * **Empty case**: if no routes match any category, both files are empty
 * strings (the orchestrator in `src/assemble/index.js` drops empty
 * optional files from the published zip).
 *
 * Writers: `networksToTxt` + `routeNetworksToTxt` come from
 * `@n3ary/gtfs-spec/serialize` (spec 0.5.3+). They give us RFC 4180
 * quoting for free; before this we hand-rolled the CSV bodies with
 * template literals, which would silently mis-quote any network_name
 * containing a comma.
 */

import { getAllCategories } from '../merge/routeCategory.ts';

/**
 * Build the CSV bodies for `networks.txt` and `route_networks.txt`.
 *
 * @param {Array<Pick<RouteRow, 'route_id' | 'route_short_name' | 'route_long_name' | 'route_desc'>>} routes
 *   The reconciled route rows — must have `route_desc` already populated
 *   by `applyCategory` in `merge/routeCategory.js`.
 * @returns {{
 *   networksTxt: string,
 *   routeNetworksTxt: string,
 *   networkUsage: Map<string, number>,
 * }}
 *   - `networksTxt`: CSV body for `networks.txt`. Empty if no categories
 *     are used (caller should drop the file from the zip).
 *   - `routeNetworksTxt`: CSV body for `route_networks.txt`. Empty if no
 *     routes have a category.
 *   - `networkUsage`: id → count, for build-log INFO summaries.
 */
export function buildNetworks(routes) {
  const allCategories = getAllCategories();

  // Build a lookup from label (which is what route_desc holds) to category.
  // Doing it via label keeps `route_desc == network_name` the contract.
  // route_desc can be a single label ("Metropolitan") or comma-separated
  // ("Transport Elevi, Metropolitan") for routes that match multiple
  // categories — see applyRouteCategory in routeCategory.js. We split on
  // comma and emit one route_networks.txt row per label so the n:m mapping
  // survives intact.
  const byLabel = new Map(allCategories.map((c) => [c.label, c]));

  /** @type {Map<string, number>} */
  const networkUsage = new Map();

  /** @type {Array<[string, string]>} */
  const routeNetworkRows = [];

  // Per GTFS spec, a route can belong to AT MOST ONE network. The
  // route_desc → category mapping can legitimately classify a route
  // under multiple categories (e.g. "Transport Elevi, Metropolitan"
  // — both match — see applyRouteCategory in routeCategory.js), which
  // would emit multiple route_networks rows for the same route_id
  // and violate the PRIMARY KEY (route_id) on route_networks.
  //
  // Dedup by route_id: first category wins. This preserves the more
  // specific network (Transport Elevi) over the more general one
  // (Metropolitan), since categories are ordered with specific ones
  // first in getAllCategories(). networkUsage still counts every
  // classification — only the emitted row is deduped — so build-log
  // INFO summaries stay accurate.
  const seenRouteIds = new Set<string>();
  for (const r of routes) {
    const desc = (r.route_desc ?? '').toString();
    if (!desc) continue; // regular urban — no network assignment
    const labels = desc.split(',').map((s) => s.trim()).filter(Boolean);
    if (labels.length === 0) continue;
    if (seenRouteIds.has(r.route_id)) continue;
    for (const label of labels) {
      const cat = byLabel.get(label);
      if (!cat) continue; // route_desc isn't a known label — shouldn't happen
      networkUsage.set(cat.id, (networkUsage.get(cat.id) ?? 0) + 1);
      routeNetworkRows.push([cat.id, r.route_id]);
      // First category wins; break after the first hit so more
      // specific labels take precedence over general ones.
      break;
    }
    seenRouteIds.add(r.route_id);
  }

  // Only emit network rows that are actually used — keeps the file lean.
  const networkRows = allCategories
    .filter((c) => networkUsage.has(c.id))
    .map((c) => [c.id, c.label] as [string, string]);

  const networksTxt = networksToTxt(networkRows);
  const routeNetworksTxt = routeNetworksToTxt(routeNetworkRows);

  return { networksTxt, routeNetworksTxt, networkUsage };
}

/**
 * Format a build-log INFO summary of network usage.
 *
 * @param {Map<string, number>} networkUsage
 * @returns {string} single-line summary, empty if no categories used
 */
export function formatNetworkUsageSummary(networkUsage) {
  if (networkUsage.size === 0) return '';
  const parts = [];
  for (const [id, count] of networkUsage) {
    parts.push(`${count} ${id}`);
  }
  return parts.join(', ');
}