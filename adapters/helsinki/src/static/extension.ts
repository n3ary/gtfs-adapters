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
 *
 * HELSINKI ADAPTER SCOPE: HSL's static GTFS is high quality and ships
 * `routes.route_color` + `routes.route_text_color` already populated
 * for every route, plus a `pathway_mode` and `route_sort_order`. The
 * adapter therefore does NOT do its own route-color computation --
 * the colors are already there. The only HSL-specific work in
 * `staticExtension` is:
 *   1. The `_neary_config` table populated from `feedConfig.timing`,
 *      with HSL-defaulted peak/off-peak/night speeds.
 *   2. A no-op `fillComputedColumns` (Helsinki has no per-feed
 *      network taxonomy to derive; networks.txt is empty).
 * The cluj adapter's full color/derive pipeline is intentionally
 * NOT replicated here -- Helsinki's data is rich enough not to
 * need it.
 */

import type { ColumnSpec } from '@n3ary/gtfs-spec/sql';

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

export type ComputedUpdates = {
  readonly [tableName: string]: ReadonlyArray<Record<string, unknown>>;
};

export type FillComputedColumnsHook = (
  context: ExtensionContext,
) => ComputedUpdates | Promise<ComputedUpdates>;

export interface StaticExtension {
  columnExtensions?: ReadonlyArray<ColumnExtension>;
  tableExtensions?: Readonly<Record<string, TableExtension>>;
  fillComputedColumns?: FillComputedColumnsHook;
}

export type StaticExtensionFeedConfig = {
  timing?: unknown;
  [key: string]: unknown;
};

/**
 * Producer-extension files the orchestrator should parse from the GTFS
 * zip and hand to `staticExtension(feedConfig)`. The orchestrator
 * treats these as opaque (it just reads the CSV and sets
 * `feedConfig[feedConfigKey] = rows`); the adapter owns the schema
 * interpretation.
 *
 * The Helsinki adapter has none today. If HSL ever adds a
 * producer-extension file (e.g. `_poi.txt` for stops of interest),
 * register it here + add a `tableExtension` in `staticExtension()`.
 */
export const producerExtensions: ReadonlyArray<{
  fileName: string;
  feedConfigKey: string;
}> = [];

/**
 * Construct the StaticExtension object for this feed.
 *
 * Currently exposes:
 *   1. `_neary_config` table -- key/value pipeline-internal table,
 *      populated from `feedConfig.timing`. The app reads these rows
 *      at runtime (`speed_kmh` peak/off-peak/night, dwell seconds,
 *      peak/night windows) for its timing-aware travel-time math.
 *      Helsinki has no per-feed networks, so we just store the
 *      timing JSON as the only row.
 *   2. `fillComputedColumns` hook -- a no-op for Helsinki. HSL's
 *      static feed already carries `route_color` + `route_text_color`
 *      on every route, so there's nothing to compute. Returning an
 *      empty `ComputedUpdates` short-circuits the pipeline's UPDATE
 *      loop.
 */
export function staticExtension(feedConfig: StaticExtensionFeedConfig): StaticExtension {
  return {
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
    },
    fillComputedColumns: () => ({}),
  };
}

/**
 * No-op for Helsinki. The cluj adapter uses this hook to compute
 * per-network chip colors from modal route colors + per-feed
 * route-color fixups; HSL ships the colors already, and Helsinki
 * has no networks, so the hook returns an empty object.
 *
 * Exported for tests (the cluj suite tests this pattern; the
 * Helsinki suite is symmetric).
 */
export function applyStaticPostLoad(
  _ctx: ExtensionContext,
): ComputedUpdates {
  return {};
}
