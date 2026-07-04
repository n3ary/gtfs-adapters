/**
 * Barrel for the cluj adapter's static pipeline.
 *
 * `@n3ary/gtfs-adapter-cluj-napoca/static` — published via the
 * adapter package's `exports.static` subpath. Consumed by the
 * generic `gtfs-static` pipeline (`n3ary/gtfs/packages/gtfs-static/
 * src/cli.ts`).
 */

export {
  clujStaticExtension,
  applyClujStaticPostLoad,
  type ClujFeedConfig,
} from './extension';

export type {
  StaticExtension,
  ColumnExtension,
  TableExtension,
  ExtensionContext,
  FillComputedColumnsHook,
} from './extension';

export {
  normalizeColor,
  computeTypeTopColors,
  resolveRouteColor,
  resolveModalCollisions,
  resolveRouteColors,
  computeNetworkColors,
  rotateHueOklch,
  oklabDistance,
} from './route-colors';
