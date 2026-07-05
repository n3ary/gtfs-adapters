/**
 * staticExtension — per-feed StaticExtension factory.
 *
 * The orchestrator (`n3ary/gtfs/packages/gtfs-static/src/cli.ts`)
 * imports `${publisher}/static` and calls `staticExtension(feedConfig)`
 * without knowing what feed it is. This factory is the **only** entry
 * point the orchestrator uses to reach per-feed static knowledge.
 *
 * Owns every column + table + computed value that goes into the
 * sqlite beyond the public GTFS Schedule spec. The shape of
 * `StaticExtension` is duplicated here (also declared in
 * `@gtfs/static/src/lib/extension.ts`) — TS is structural, so the
 * runtime contract is the same regardless of which package's
 * declaration is on each side. We keep them in sync via the vitest
 * suite here; if the shape changes, the extension.ts in @gtfs/static
 * MUST be updated too. Long-term, lift the type into
 * `@n3ary/gtfs-spec`.
 */

import type Database from 'better-sqlite3';
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
 * Per-feed config shape consumed by `staticExtension(feedConfig)`.
 * Each adapter declares its own typed shape; the orchestrator passes
 * the raw `feeds/<id>/config.json` object through without
 * interpretation.
 */
export type StaticExtensionFeedConfig = {
  timing?: unknown;
  [key: string]: unknown;
};

/**
 * Construct the StaticExtension object for this feed.
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
    },
    fillComputedColumns: (db, ctx) => applyStaticPostLoad(db, ctx),
  };
}

/**
 * Run the per-feed post-load hook on an open `Database`. Exported
 * for tests; production callers reach it via `staticExtension`.
 */
export function applyStaticPostLoad(
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
    console.log(`[static-postload] ${ctx.feedId}: routes — ${line}`);
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
    `[static-postload] ${ctx.feedId}: network colors — ` +
      [...colors.entries()].map(([id, c]) => `${id}=#${c}`).join(', '),
  );
}
