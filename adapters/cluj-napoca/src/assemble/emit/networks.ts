// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).

import { type RouteRow, networksToTxt, routeNetworksToTxt } from '@n3ary/gtfs-spec/spec';

// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Emit GTFS `networks.txt` + `route_networks.txt` from classified routes.
 *
 * Per the GTFS spec (https://gtfs.org/schedule/reference/#networkstxt),
 * networks are groupings of routes. Per gtfs-adapters#26, this adapter
 * emits exactly **2** networks for cluj-napoca:
 *
 *   1. `school` (Transport Elevi) -- routes whose `route_short_name`
 *      starts with `TE`. Transport Elevi is a separate contracted
 *      operator for school transport.
 *   2. `normal` (Normal) -- every other route. Catch-all network.
 *
 * **Service-class taxonomy** (special / festival / night / airport /
 * metroline) lives ONLY in `route_desc` as comma-joined labels. These
 * are tags, not networks -- per the public GTFS spec, `route_networks.txt`
 * is 1:1 by `route_id`, so n:m tag membership has to live somewhere
 * else. `route_desc` is the simple, portable choice.
 *
 * **Why 2 networks and not 1**: a route is either in the `school`
 * network (TE* short_name) or in the `normal` network. The 1:1
 * constraint is satisfied by construction: every route belongs to
 * exactly one of the two networks. The previous design emitted
 * multiple networks (one per used tag) which violated the public
 * spec's 1:1 rule (issue #4). This is the simplified, 2-network
 * resolution of gtfs-adapters#26.
 *
 * **Empty case**: if no routes exist, both files are empty strings
 * (the orchestrator in `src/assemble/index.js` drops empty optional
 * files from the published zip).
 *
 * Writers: `networksToTxt` + `routeNetworksToTxt` come from
 * `@n3ary/gtfs-spec/serialize` (spec 0.5.3+). They give us RFC 4180
 * quoting for free; before this we hand-rolled the CSV bodies with
 * template literals, which would silently mis-quote any network_name
 * containing a comma.
 */

import { getAllNetworks } from '../merge/routeCategory.ts';

/**
 * Build the CSV bodies for `networks.txt` and `route_networks.txt`.
 *
 * **Reads from the structured `routeNetworks` map** populated by
 * `applyRouteCategory` -- does NOT parse `route_desc` (the previous
 * design did; that roundtrip is fragile and was the source of the
 * 1:many violation that gtfs-adapters#4 fixed).
 *
 * @param {Array<Pick<RouteRow, 'route_id' | 'route_short_name' | 'route_long_name' | 'route_desc'>>} routes
 *   The reconciled route rows. Used only to iterate the route set in
 *   a stable order -- the per-route network assignment is in
 *   `routeNetworks`.
 * @param {Map<string, { id: string, label: string }>} routeNetworks
 *   Per-route network assignment from `applyRouteCategory`. Each
 *   entry is `school` (TE* routes) or `normal` (everything else).
 *   Routes that don't appear in the map are silently skipped
 *   (defensive -- shouldn't happen in practice; the orchestrator
 *   always sets a network for every route).
 * @returns {{
 *   networksTxt: string,
 *   routeNetworksTxt: string,
 *   networkUsage: Map<string, number>,
 * }}
 *   - `networksTxt`: CSV body for `networks.txt`. Always emits the
 *     header + 2 data rows (`school`, `normal`) when the feed has
 *     at least one route in each network; networks with zero routes
 *     are dropped. Empty if the feed has no routes.
 *   - `routeNetworksTxt`: CSV body for `route_networks.txt`. One row
 *     per route, in `route_id` order (sorted lexically for diff-
 *     stability across builds).
 *   - `networkUsage`: id -> count, for build-log INFO summaries.
 */
export function buildNetworks(routes, routeNetworks) {
  const allNetworks = getAllNetworks();

  /** @type {Map<string, number>} */
  const networkUsage = new Map();

  // Build the route_networks rows. Iterate `routes` (the
  // orchestrator-supplied canonical order) so the emitted CSV
  // is diff-stable across builds that produce the same input.
  // Each row is one (network_id, route_id) -- 1:1 by route_id
  // per the public GTFS spec.
  /** @type {Array<[string, string]>} */
  const routeNetworkRows = [];
  for (const r of routes) {
    const network = routeNetworks.get(r.route_id);
    if (!network) continue; // defensive: orchestrator always sets a network
    networkUsage.set(network.id, (networkUsage.get(network.id) ?? 0) + 1);
    routeNetworkRows.push([network.id, r.route_id]);
  }

  // Sort the route_networks rows by route_id for diff-stability
  // (the input-order tie-breaker doesn't carry semantic meaning,
  // and any deterministic order is more debuggable than input order).
  routeNetworkRows.sort((a, b) => {
    if (a[0] !== b[0]) return a[0].localeCompare(b[0]); // network_id first
    return a[1].localeCompare(b[1]); // then route_id
  });

  // Only emit network rows that are actually used -- keeps the file
  // lean. Declared in `getAllNetworks` order (school, normal) for
  // diff-stability. In practice every populated feed has at least
  // one `normal` route, so `normal` is virtually always present;
  // `school` is conditional on having at least one TE* route.
  const networkRows = allNetworks
    .filter((n) => networkUsage.has(n.id))
    .map((n) => [n.id, n.label] as [string, string]);

  const networksTxt = networksToTxt(networkRows);
  const routeNetworksTxt = routeNetworksToTxt(routeNetworkRows);

  return { networksTxt, routeNetworksTxt, networkUsage };
}

/**
 * Format a build-log INFO summary of network usage.
 *
 * @param {Map<string, number>} networkUsage
 * @returns {string} single-line summary, empty if no networks used
 */
export function formatNetworkUsageSummary(networkUsage) {
  if (networkUsage.size === 0) return '';
  // Sort by id for diff-stability (Map iteration order is
  // insertion order in V8, but we don't want to depend on that).
  const parts = [];
  for (const [id, count] of [...networkUsage].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`${count} ${id}`);
  }
  return parts.join(', ');
}
