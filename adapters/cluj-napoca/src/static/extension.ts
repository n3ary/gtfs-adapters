/**
 * clujStaticExtension — the per-feed StaticExtension for cluj-napoca.
 *
 * Owns every column + table + computed value that goes into the
 * sqlite beyond the public GTFS Schedule spec. Called by the generic
 * `gtfs-static` pipeline (see `n3ary/gtfs/packages/gtfs-static/src/
 * make-sqlite.ts`, which now ships the `StaticExtension` API).
 *
 * The shape of `StaticExtension` is duplicated here (also declared in
 * `@gtfs/static/src/lib/extension.ts`) — TS is structural, so the
 * runtime contract is the same regardless of which package's declaration
 * is on each side. We keep them in sync via this file's vitest suite:
 * if the shape changes here, the extension.ts in @gtfs/static MUST be
 * updated too. Long-term, lift the type into `@n3ary/gtfs-spec`.
 */

import type Database from 'better-sqlite3';
import { resolveRouteColors, computeNetworkColors } from './route-colors';

type ColumnSpec = readonly [string, string];

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

export type FillComputedColumnsHook = (
  db: Database.Database,
  context: ExtensionContext,
) => void | Promise<void>;

export interface StaticExtension {
  columnExtensions?: ReadonlyArray<ColumnExtension>;
  tableExtensions?: Readonly<Record<string, TableExtension>>;
  fillComputedColumns?: FillComputedColumnsHook;
}

/**
 * Per-feed config for cluj-napoca. The `timing` block (and any future
 * per-feed knobs) is what makes cluj different from a generic
 * Transitous mirror — currently it carries peak/off-peak/night speed
 * buckets + peak windows + dwell seconds. See
 * `n3ary/gtfs/packages/gtfs-static/feeds/cluj-napoca/config.json`.
 */
export type ClujFeedConfig = {
  timing?: unknown;
};

/**
 * Construct the StaticExtension object for cluj-napoca.
 *
 * Adds:
 *   1. `networks.network_color` — producer-computed chip color for
 *      each network (derived from per-route modal colors).
 *   2. `_neary_config` table — key/value pipeline-internal table,
 *      populated from `feedConfig.timing`. The app reads these rows
 *      at runtime (`speed_kmh` peak/off-peak/night, dwell seconds,
 *      peak/night windows) for its timing-aware travel-time math.
 *   3. `fillComputedColumns` hook — applies the route-color fixup on
 *      top of the spec-CSV-derived routes, then computes network
 *      colors. UPDATEs the live DB rows.
 */
export function clujStaticExtension(feedConfig: ClujFeedConfig): StaticExtension {
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
    },
    fillComputedColumns: (db, ctx) => applyClujStaticPostLoad(db, ctx),
  };
}

/**
 * Run the cluj post-load hook on an open `Database`. Exported for
 * tests; production callers reach it via `clujStaticExtension`.
 */
export function applyClujStaticPostLoad(
  db: Database.Database,
  ctx: ExtensionContext,
): void {
  // 1. Route color fixup — applied to the live routes table.
  //    resolveRouteColors mutates a transformed copy of ctx.routes
  //    with substituted + OKLCh-rotated values; we UPDATEs each row
  //    inside a single transaction.
  const allRouteFixup = resolveRouteColors(
    ctx.routes as Parameters<typeof resolveRouteColors>[0],
  );
  const updateRouteColor = db.prepare('UPDATE routes SET route_color = ? WHERE route_id = ?');
  db.transaction(() => {
    for (const r of allRouteFixup.rows) {
      const id = (r as { route_id?: string }).route_id;
      if (!id) continue;
      const color = (r as { route_color?: string }).route_color ?? '';
      updateRouteColor.run(color, id);
    }
  })();
  for (const line of allRouteFixup.logs) {
    console.log(`[cluj-static-postload] ${ctx.feedId}: routes — ${line}`);
  }

  // 2. Network colors — only meaningful when networks.txt + route_networks.txt
  //    are present (they're optional GTFS tables). The pipeline already skips
  //    insertion when missing, so ctx.networks is empty in that case and
  //    computeNetworkColors returns an empty map.
  if (ctx.networks.length === 0) return;
  const colors = computeNetworkColors(
    ctx.routes as Parameters<typeof computeNetworkColors>[0],
    ctx.routeNetworks as Parameters<typeof computeNetworkColors>[1],
    ctx.networks as Parameters<typeof computeNetworkColors>[2],
  );
  if (colors.size === 0) return;
  const updateNet = db.prepare('UPDATE networks SET network_color = ? WHERE network_id = ?');
  db.transaction(() => {
    for (const [netId, color] of colors) updateNet.run(color, netId);
  })();
  console.log(
    `[cluj-static-postload] ${ctx.feedId}: network colors — ` +
      [...colors.entries()].map(([id, c]) => `${id}=#${c}`).join(', '),
  );
}
