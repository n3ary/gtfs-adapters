/**
 * Barrel for the adapter's static pipeline.
 *
 * Published via the adapter package's `exports.static` subpath.
 * Consumed by the generic `gtfs-static` pipeline
 * (`n3ary/gtfs/packages/gtfs-static/src/cli.ts`). The orchestrator
 * imports `${publisher}/static` and calls `staticExtension(feedConfig)`
 * without knowing what adapter it is — this barrel exposes the
 * generic surface that contract requires.
 */

export {
  staticExtension,
  applyStaticPostLoad,
  type StaticExtensionFeedConfig,
} from './extension.ts';

export type {
  StaticExtension,
  ColumnExtension,
  TableExtension,
  ExtensionContext,
  FillComputedColumnsHook,
} from './extension.ts';

export {
  normalizeColor,
  computeTypeTopColors,
  resolveRouteColor,
  resolveModalCollisions,
  resolveRouteColors,
  computeNetworkColors,
  rotateHueOklch,
  oklabDistance,
} from './route-colors.ts';
