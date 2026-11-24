/**
 * Barrel for the adapter's static pipeline.
 *
 * Published via the adapter package's `exports.static` subpath.
 * Consumed by the generic `gtfs-static` pipeline
 * (`n3ary/gtfs/packages/gtfs-static/src/cli.ts`). The orchestrator
 * imports `${publisher}/static` and calls `staticExtension(feedConfig)`
 * without knowing what adapter it is — this barrel exposes the
 * generic surface that contract requires.
 *
 * Realtime-specific knowledge (Quirks, extra RT URLs) lives in the
 * `/rt` subpath. The `/static` subpath is for table extensions,
 * computed columns, and other schedule-pipeline concerns only.
 */

export type {
  ColumnExtension,
  ComputedUpdates,
  ExtensionContext,
  FillComputedColumnsHook,
  StaticExtension,
  TableExtension,
} from './extension.ts';
export {
  applyStaticPostLoad,
  producerExtensions,
  type StaticExtensionFeedConfig,
  staticExtension,
} from './extension.ts';

export {
  computeNetworkColors,
  computeTypeTopColors,
  normalizeColor,
  oklabDistance,
  resolveModalCollisions,
  resolveRouteColor,
  resolveRouteColors,
  rotateHueOklch,
} from './route-colors.ts';
