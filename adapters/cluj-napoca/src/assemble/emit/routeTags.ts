// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Emit the `_route_tags` producer-extension CSV.
 *
 * **Why an extension, not just `route_desc`**: the public GTFS spec
 * (https://gtfs.org/schedule/reference/#route_networkstxt) disallows
 * 1:many rows in `route_networks.txt` — the PK is `route_id` alone,
 * and a feed that emits 1:many rows for the same route is malformed
 * (the static pipeline's `INSERT OR IGNORE` on the PK drops the
 * extras silently). For routes that legitimately match multiple
 * tags (e.g. an M26U = festival + metroline in cluj-napoca), the
 * public spec gives us exactly **one** network row per route —
 * the priority-pick. The full n:m membership is what this extension
 * carries.
 *
 * The cluj adapter surfaces the same data in **two** places:
 *
 *   - `route_desc` (the comma-joined tag label list, n:m). The
 *     "human-readable" surface; what neary renders as a route badge.
 *   - `_route_tags` (this extension, n:m). The "queryable" surface;
 *     what the n3ary app reads when it needs to filter / group /
 *     aggregate the full tag membership (e.g. "show me every
 *     festival-tagged route", which is a SQL query against the
 *     SQLite blob, not a string-parsing exercise).
 *
 * The DDL is producer-defined (lives in the cluj adapter's
 * `extension.ts`, Option 2 of issue #25 — the spec stays
 * feed-agnostic, mirroring the `_neary_config` precedent):
 *
 *   CREATE TABLE _route_tags (
 *     tag_id    TEXT NOT NULL,
 *     route_id  TEXT NOT NULL,
 *     tag_label TEXT,
 *     priority  INTEGER,
 *     PRIMARY KEY (tag_id, route_id)
 *   ) WITHOUT ROWID;
 *
 * The composite PK on `(tag_id, route_id)` — NOT just `route_id` —
 * is the whole point: the n:m mapping IS the row. `priority` is
 * the `TAGS` declaration index (0-based) and gives consumers a
 * stable sort order for badge rendering (1:many routes show their
 * badges in `TAGS` order, not insertion order).
 *
 * **Why a separate file in `assemble/emit/` and not in `networks.ts`?**
 * `networks.ts` emits the **public** spec files (`networks.txt` +
 * `route_networks.txt`). This module emits an **extension** — the
 * pipeline knows to drop it from the zip if empty, but its existence
 * is conditional on the per-adapter extension registration. Keeping
 * the two emitters separate makes the public-vs-extension split
 * visible in the file tree.
 *
 * The orchestrator in `assemble/index.ts` threads the structured
 * `routeTags` map from `applyRouteCategory` to both `buildNetworks`
 * (1:1 `route_networks.txt` priority-pick) and `buildRouteTags`
 * (this n:m extension). See `docs/quirks-and-rules.md` "Route
 * taxonomy surfaces" for the full four-surface contract.
 */

import { stringify } from 'csv-stringify/sync';

/**
 * @typedef {{ id: string, label: string, priority: number, icon?: string }} RouteTag
 */

const ROUTE_TAGS_HEADER = 'tag_id,route_id,tag_label,priority,icon';

/**
 * Build the CSV body for `_route_tags` from the structured per-route
 * tag map.
 *
 * **Empty case**: returns `''` (the orchestrator drops empty
 * optional files from the zip, same convention as `networks.txt`).
 *
 * **Output shape**:
 *   - One row per `(tag.id, route_id)` — full n:m.
 *   - Rows are emitted in `(route_id, priority)` order so:
 *     1. Every route's tags cluster together (a 1:many route's rows
 *        are adjacent, easy to read in a diff).
 *     2. Within a route, tags are in `TAGS` declaration order (the
 *        same priority order consumers render badges by).
 *   - `tag_label` is denormalized into the row for fast consumer
 *     reads; the spec's `_route_tags` is a producer-defined table
 *     (Option 2 from issue #25), so denormalizing the label is
 *     cheap and avoids forcing consumers to join against
 *     `networks.txt` for the human-readable string.
 *   - `icon` is the lucide-svelte slug the consumer renders in the
 *     tag chip (e.g. `moon`, `map-pin`, `plane`, `music`, `zap`).
 *     The adapter owns the tag-to-icon mapping — adding a new tag
 *     means a single edit in `routeCategory.CATEGORIES`, not a
 *     consumer code change. Empty string when the tag entry has
 *     no icon declared.
 *
 * @param {Map<string, ReadonlyArray<RouteTag>>} routeTags
 *   The per-route tag map from `applyRouteCategory.routeTags`. Routes
 *   with no matching tags are absent from the map (and absent from
 *   the output).
 * @returns {string} CSV body (header + rows + trailing newline), or
 *   `''` when the map is empty.
 */
export function buildRouteTags(routeTags) {
  if (!routeTags || routeTags.size === 0) return '';

  // Flatten to (route_id, tag) pairs, then sort by (route_id, priority).
  // Sorting BEFORE stringify keeps the output diff-stable across
  // re-runs (Map iteration order is insertion order, which depends on
  // the upstream route order; sorting eliminates that as a noise
  // source).
  /** @type {Array<[string, RouteTag]>} */
  const pairs = [];
  for (const [routeId, tags] of routeTags.entries()) {
    for (const tag of tags) {
      pairs.push([routeId, tag]);
    }
  }
  pairs.sort(([routeIdA, tagA], [routeIdB, tagB]) => {
    if (routeIdA !== routeIdB) return routeIdA < routeIdB ? -1 : 1;
    return tagA.priority - tagB.priority;
  });

  const rows = pairs.map(([routeId, tag]) => [
    tag.id,
    routeId,
    tag.label,
    String(tag.priority),
    tag.icon ?? '',
  ]);

  // csv-stringify/sync with explicit `header: false` + manual header
  // line keeps the column order locked to (tag_id, route_id,
  // tag_label, priority, icon) regardless of object key ordering. We
  // don't use `serializeRows` here because `_route_tags` is a
  // producer extension with no spec schema — its column order is
  // this adapter's contract, not the spec's.
  const body = stringify(rows, {
    header: false,
    columns: ['tag_id', 'route_id', 'tag_label', 'priority', 'icon'],
    record_delimiter: '\n',
  });
  return ROUTE_TAGS_HEADER + '\n' + body;
}

/**
 * Format a build-log INFO summary of the extension row count.
 *
 * The output format is:
 *   "N rows covering M route(s) (X 1:many)"
 * where N is the total number of rows in the extension, M is the
 * number of distinct routes that have at least one tag, and X is
 * the number of routes with more than one tag (the n:m cases).
 *
 * @param {Map<string, ReadonlyArray<RouteTag>>} routeTags
 * @returns {string} single-line summary, empty when there are no rows
 */
export function formatRouteTagsSummary(routeTags) {
  if (!routeTags || routeTags.size === 0) return '';
  let rowCount = 0;
  let multiRouteCount = 0;
  for (const tags of routeTags.values()) {
    rowCount += tags.length;
    if (tags.length > 1) multiRouteCount++;
  }
  return `${rowCount} rows covering ${routeTags.size} route(s) (${multiRouteCount} 1:many)`;
}
