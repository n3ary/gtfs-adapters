/**
 * staticExtension -- per-feed StaticExtension factory.
 *
 * The orchestrator (`n3ary/gtfs/static`'s cli.ts) imports
 * `${publisher}/static` and calls `staticExtension(feedConfig)` without
 * knowing what feed it is. This factory is the **only** entry point
 * the orchestrator uses to reach per-feed static knowledge.
 *
 * Owns every column + table + computed value that goes into the
 * sqlite beyond the public GTFS Schedule spec.
 *
 * CONTRACT NOTE: in the SQL-free refactor, the adapter is a PURE
 * data-in / data-out module. It never imports a SQLite driver, never
 * touches the DB, never knows which engine the pipeline runs on. The
 * `fillComputedColumns` hook receives the buffered spec rows + a
 * feedId and returns a `ComputedUpdates` object (table -> partial
 * rows to UPDATE). The pipeline then constructs UPDATE statements
 * using the spec's PRIMARY KEY metadata and applies them in a
 * transaction. See `@gtfs/static/src/lib/extension.ts` for the
 * full contract + the rationale (audit surface, schema-agnostic
 * adapters, fewer dependency edges).
 *
 * The shape of `StaticExtension` is duplicated here (also declared in
 * `@gtfs/static/src/lib/extension.ts`) -- TS is structural, so the
 * runtime contract is the same regardless of which package's
 * declaration is on each side. We keep them in sync via the vitest
 * suite here; if the shape changes, the extension.ts in @gtfs/static
 * MUST be updated too. Long-term, lift the type into
 * `@n3ary/gtfs-spec`.
 */

import type { ColumnSpec } from '@n3ary/gtfs-spec/sql';
import { resolveRouteColors, computeNetworkColors } from './route-colors.ts';

export type ColumnExtension = {
  table: string;
  column: ColumnSpec;
};

export type TableExtension = {
  columns: ColumnSpec[];
  rows?: ReadonlyArray<Record<string, unknown>>;
};

export type ExtensionContext = {
  readonly feedId: string;
  readonly routes: ReadonlyArray<Record<string, unknown>>;
  readonly networks: ReadonlyArray<Record<string, unknown>>;
  readonly routeNetworks: ReadonlyArray<Record<string, unknown>>;
};

/**
 * Per-table partial-row updates the adapter returns from
 * `fillComputedColumns`. Each entry under a table key MUST include
 * the spec's PRIMARY KEY column(s) (the pipeline uses them to build
 * `WHERE pk = ?`); remaining keys are the columns to SET.
 *
 * Example:
 *   { routes:    [{ route_id: 'R1', route_color: 'FF0000' }],
 *     networks:  [{ network_id: 'night', network_color: 'aabbcc' }] }
 */
export type ComputedUpdates = {
  readonly [tableName: string]: ReadonlyArray<Record<string, unknown>>;
};

/**
 * PURE hook: spec rows in, ComputedUpdates out. NO DB access.
 * Async is allowed (some adapters may fetch external material).
 * Returning an empty object is a valid no-op.
 */
export type FillComputedColumnsHook = (
  context: ExtensionContext,
) => ComputedUpdates | Promise<ComputedUpdates>;

export interface StaticExtension {
  columnExtensions?: ReadonlyArray<ColumnExtension>;
  tableExtensions?: Readonly<Record<string, TableExtension>>;
  fillComputedColumns?: FillComputedColumnsHook;
}

/**
 * Per-feed config shape consumed by `staticExtension(feedConfig)`.
 * Each adapter declares its own typed shape; the orchestrator passes
 * the raw `feeds/<id>/config.json` object through without
 * interpretation.
 *
 * **For `_route_tags` rows (issue #25)**: the orchestrator is expected
 * to populate `feedConfig.routeTags` by parsing `_route_tags.txt` from
 * the zip (see `producerExtensions` below) before calling
 * `staticExtension()`. The orchestrator does not interpret the rows —
 * it just hands the raw CSV `Record<string, string>` to the adapter.
 * The adapter is responsible for schema coercion (e.g. `priority` ->
 * number) before inserting into the SQLite table. Absent / empty ->
 * table is still created (so consumers can issue `SELECT ... LIMIT 0`)
 * but inserts no rows. See the "Route taxonomy surfaces" section of
 * `docs/quirks-and-rules.md` for the data-flow contract.
 */
export type StaticExtensionFeedConfig = {
  timing?: unknown;
  /**
   * Pre-parsed `_route_tags.txt` rows. The orchestrator populates
   * this by walking `producerExtensions` and reading the declared
   * file from the zip via a generic CSV reader. Each entry is the
   * raw CSV row (`Record<string, string>`) — the adapter does the
   * schema coercion in `staticExtension()`.
   */
  routeTags?: ReadonlyArray<Record<string, string>>;
  [key: string]: unknown;
};

/**
 * Producer-extension files the orchestrator should parse from the GTFS
 * zip and hand to `staticExtension(feedConfig)`. The orchestrator
 * treats these as opaque (it just reads the CSV and sets
 * `feedConfig[feedConfigKey] = rows`); the adapter owns the schema
 * interpretation. This is the contract that keeps the publisher
 * feed-agnostic — adding a new producer extension is an adapter-only
 * change, not a publisher change.
 *
 * For the cluj adapter, the only declared producer extension is
 * `_route_tags.txt` (issue #25, the n:m route->tag mapping). Adding
 * another file in the future (e.g. `_poi.txt`, `_fare_zones.txt`) is
 * a one-line entry here plus a corresponding `tableExtension`
 * registration in `staticExtension()`.
 */
export const producerExtensions: ReadonlyArray<{
  /** File name in the GTFS zip (e.g. '_route_tags.txt'). */
  fileName: string;
  /**
   * Key on `feedConfig` the orchestrator should populate with the
   * parsed rows. The adapter reads this key in `staticExtension()`.
   */
  feedConfigKey: string;
}> = [
  { fileName: '_route_tags.txt', feedConfigKey: 'routeTags' },
];

/**
 * Construct the StaticExtension object for this feed.
 *
 * Adds:
 *   1. `networks.network_color` -- producer-computed chip color for
 *      each network (derived from per-route modal colors).
 *   2. `_neary_config` table -- key/value pipeline-internal table,
 *      populated from `feedConfig.timing`. The app reads these rows
 *      at runtime (`speed_kmh` peak/off-peak/night, dwell seconds,
 *      peak/night windows) for its timing-aware travel-time math.
 *   3. `_route_tags` table (issue #25) -- producer extension carrying
 *      the full n:m route→tag mapping. The cluj adapter owns the DDL
 *      (per Option 2 of the issue's open question — the spec stays
 *      feed-agnostic, mirroring the `_neary_config` precedent). Rows
 *      come from `feedConfig.routeTags`, which the orchestrator
 *      populates by parsing `_route_tags.txt` from the zip before
 *      calling this factory.
 *   4. `fillComputedColumns` hook -- computes the route-color fixup
 *      from `ctx.routes`, then derives per-network chip colors. The
 *      hook returns a `ComputedUpdates` object; the pipeline owns
 *      the SQL.
 */
export function staticExtension(feedConfig: StaticExtensionFeedConfig): StaticExtension {
  return {
    columnExtensions: [
      { table: 'networks', column: ['network_color', 'TEXT'] },
    ],
    tableExtensions: {
      _neary_config: {
        columns: [
          ['key', 'TEXT PRIMARY KEY'],
          ['value', 'TEXT NOT NULL'],
        ],
        rows: feedConfig.timing
          ? [{ key: 'timing', value: JSON.stringify(feedConfig.timing) }]
          : [],
      },
      // `_route_tags` — full n:m route→tag mapping.
      //
      // DDL rationale (issue #25, Option 2 — DDL in the adapter):
      //   - Composite PK on `(tag_id, route_id)`. The whole point is
      //     n:m, so `route_id` alone MUST NOT be unique.
      //   - `tag_label` is denormalized into the row so consumers
      //     (notably neary's chip rendering) can render badges
      //     without joining `networks.txt` for the human string.
      //     The label is fed from `applyRouteCategory`'s `TAGS`
      //     declaration, so it's always consistent with the
      //     `route_networks.txt` join.
      //   - `priority` is the `TAGS` declaration index (0-based).
      //     Consumers sort by it for stable badge ordering (1:many
      //     routes show badges in TAGS order, not insertion order).
      //     Stored as INTEGER for cheap ORDER BY.
      //   - WITHOUT ROWID + composite PK = the (tag_id, route_id)
      //     pair IS the row's primary key, so the table is keyed
      //     exactly once per membership tuple. The pipeline's
      //     `INSERT OR IGNORE` semantics in `@gtfs/static`'s
      //     `insertTableExtensionRows` make the same publish
      //     idempotent across re-runs.
      //
      // Note: we declare the columns without the composite-PK
      // constraint here because the spec's `TableExtension`
      // contract expects each column to be a plain `ColumnSpec`
      // string. The pipeline constructs `CREATE TABLE <name> (<col>
      // <type>, ...)` from these — composite-PK semantics are
      // enforced upstream by the INSERT OR IGNORE behavior plus
      // duplicate detection in tests. The cluj adapter's
      // `applyStaticPostLoad` test asserts the expected row count
      // per `route_id` so accidental over-insertion fails loudly.
      _route_tags: {
        columns: [
          ['tag_id', 'TEXT NOT NULL'],
          ['route_id', 'TEXT NOT NULL'],
          ['tag_label', 'TEXT'],
          ['priority', 'INTEGER'],
        ],
        // Coerce the raw CSV rows (which arrive as `Record<string, string>`
        // from the orchestrator's generic CSV reader) into the typed
        // shape the SQLite column needs. Empty string / missing ->
        // null. Numeric `priority` is parsed defensively: an empty
        // string or non-numeric value becomes null (the SQLite
        // `INTEGER` column would otherwise reject the row, and a
        // malformed emit is loud failure not silent data loss).
        rows: feedConfig.routeTags && feedConfig.routeTags.length > 0
          ? feedConfig.routeTags.map((r) => {
              const priorityRaw = r.priority?.trim() ?? '';
              const priorityNum = priorityRaw === '' ? null : Number(priorityRaw);
              return {
                tag_id: r.tag_id ?? '',
                route_id: r.route_id ?? '',
                tag_label: r.tag_label && r.tag_label.length > 0 ? r.tag_label : null,
                priority: priorityNum !== null && Number.isFinite(priorityNum) ? priorityNum : null,
              };
            })
          : [],
      },
    },
    fillComputedColumns: (ctx) => applyStaticPostLoad(ctx),
  };
}

/**
 * Run the per-feed post-load derivation in pure-data form. Exported
 * for tests; production callers reach it via `staticExtension`.
 *
 * Inputs:
 *   - `ctx.routes`  -- parsed routes.txt rows
 *   - `ctx.networks`, `ctx.routeNetworks` -- parsed networks+route_networks
 *     (only meaningful when networks.txt exists; otherwise empty)
 *
 * Output: { routes: [{route_id, route_color}], networks: [{network_id, network_color}] }
 *
 * The pipeline (in @gtfs/static's `make-sqlite.ts`) walks the return
 * value, locates PRIMARY KEY columns for `routes` and `networks` in
 * the spec SCHEMA, and issues one UPDATE per row in a single
 * transaction. ROLLBACK on throw.
 */
export function applyStaticPostLoad(
  ctx: ExtensionContext,
): ComputedUpdates {
  // 1. Route color fixup -- mutate a transformed copy of ctx.routes
  //    with substituted + OKLCh-rotated values; we hand the fixed
  //    rows back to the pipeline as partial-route-color updates.
  const allRouteFixup = resolveRouteColors(
    ctx.routes as Parameters<typeof resolveRouteColors>[0],
  );
  const routeUpdates: Array<Record<string, unknown>> = [];
  for (const r of allRouteFixup.rows) {
    const id = (r as { route_id?: string }).route_id;
    if (!id) continue;
    const color = (r as { route_color?: string }).route_color ?? '';
    routeUpdates.push({ route_id: id, route_color: color });
  }
  for (const line of allRouteFixup.logs) {
    console.log(`[static-postload] ${ctx.feedId}: routes -- ${line}`);
  }

  // 2. Network colors -- only meaningful when networks.txt +
  //    route_networks.txt are present. The pipeline already skips
  //    insertion when missing, so ctx.networks is empty in that case
  //    and computeNetworkColors returns an empty map. We always
  //    include the routeUpdates branch (even when empty) so the
  //    pipeline can rely on the shape being consistent.
  const updates: ComputedUpdates = {
    ...(routeUpdates.length > 0 ? { routes: routeUpdates } : {}),
  };
  if (ctx.networks.length === 0) return updates;
  const colors = computeNetworkColors(
    ctx.routes as Parameters<typeof computeNetworkColors>[0],
    ctx.routeNetworks as Parameters<typeof computeNetworkColors>[1],
    ctx.networks as Parameters<typeof computeNetworkColors>[2],
  );
  if (colors.size === 0) return updates;
  const networkUpdates: Array<Record<string, unknown>> = [];
  for (const [network_id, color] of colors) {
    networkUpdates.push({ network_id, network_color: color });
  }
  console.log(
    `[static-postload] ${ctx.feedId}: network colors -- ` +
      [...colors.entries()].map(([id, c]) => `${id}=#${c}`).join(', '),
  );
  return { ...updates, networks: networkUpdates };
}
