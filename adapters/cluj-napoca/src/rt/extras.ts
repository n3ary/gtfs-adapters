/**
 * extraVehiclePositions — additional vehicle_positions URLs the
 * adapter knows about for this feed.
 *
 * Returns the **content** of the `realtime.extra_vehicle_positions`
 * array in `feeds.json`. The canonical `vehicle_positions` URL is
 * the operator's own public endpoint (e.g. cluj-rt-feed.gtfs.ro)
 * and lives in `feeds/<id>/config.json` or is auto-discovered via
 * the MDB catalog. **The adapter doesn't own the canonical URL.**
 *
 * What the adapter does own is what the operator has *added*: a
 * third-party mirror, a community-maintained backup feed, a
 * transportous fallback, etc. These are non-canonical, per-feed,
 * and adapter-known -- they belong in the adapter package.
 *
 * For cluj today: no extras. The function returns `[]`. If CTP
 * ever publishes a backup feed, the cluj adapter would import
 * + return it here; nothing on the publisher or consumer side
 * needs to change.
 *
 * Wired up by `gtfs-static` (n3ary/gtfs-publisher) at build time
 * via `${publisher}/rt.extraVehiclePositions()`. The orchestrator
 * writes the result into `feeds.json.realtime.extra_vehicle_positions`.
 */

/**
 * Cluj-Napoca has no third-party mirrors or backup feeds today.
 * Return an empty array; the function exists so the orchestrator
 * can call it uniformly across all adapter-type feeds.
 */
export function extraVehiclePositions(): string[] {
  return [];
}
