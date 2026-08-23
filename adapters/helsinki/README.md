# @n3ary/gtfs-adapter-helsinki

Helsinki (HSL) GTFS adapter for the [n3ary](https://github.com/n3ary) family. One of the per-feed adapters in [`n3ary/gtfs-adapters`](https://github.com/n3ary/gtfs-adapters). See the monorepo README for the adapter contract and how the orchestrator consumes this package.

## What this adapter does

- **Ingest** (`/ingest`): fetches HSL's daily-published GTFS zip from `https://gtfs.hsl.fi/gtfs.zip`, verifies it has the required files, returns the bytes for the orchestrator to upload.
- **Static** (`/static`): exposes a `staticExtension(feedConfig)` factory that adds the `_neary_config` table (for the app's timing-aware travel-time math). HSL ships `route_color` + `route_text_color` for every route already, so there is no per-feed color work. Also exports `hslRouteType` and `computeHslBrandColor` for the app's category chip rendering.
- **RT** (`/rt`): exports the `helsinkiQuirk` (called by the generic `gtfs-rt` proxy on every fetched FeedMessage) plus two helpers, `syntheticHslTripId` and `splitHslVehicleId`. The quirk:

  1. Synthesizes a `trip_id` for `VehiclePosition` and `TripUpdate` entities when HSL omits one. HSL's real-time feed uses the composite `route_id + start_date + start_time + direction_id` instead of `trip_id`; the static feed regenerates `trip_id` on every publish, so the composite is the only stable join key. Format: `hsl:<route_id>:<start_date>:<start_time>:<direction_id>`.
  2. Splits the HSL `<operator>/<vehicle>` vehicle id — sets `vehicle.label` to the bare vehicle number while keeping `vehicle.id` as the full composite (so consumers can filter by operator).

## HSL-specific quirks

- **Trip IDs in RT are absent.** Composite is the only join. See the synthetic trip_id quirk above.
- **Vehicle IDs in RT are composite** (`HSL/1234` style). See the split quirk above.
- **`pathway_mode` is HSL's modal discriminator** — value 1 is metro even when `route_type=0` says tram. The `hslRouteType()` helper centralizes this so the app doesn't have to.

## Data sources

- **Static GTFS**: HSL publishes a daily GTFS zip at `https://gtfs.hsl.fi/`. Open data, no API key required. License: HSL open data with attribution.
- **GTFS-RT**: HSL publishes standard GTFS-RT protobuf feeds (no HFP conversion needed) at:
  - Service alerts: `https://realtime.hsl.fi/realtime/service-alerts/v2/hsl`
  - Trip updates: `https://realtime.hsl.fi/realtime/trip-updates/v2/hsl`
  - Vehicle positions: `https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl`
- License: HSL open data, attribution required (see `feeds/helsinki/config.json`).

## License

PolyForm Noncommercial 1.0.0. See [LICENSE](./LICENSE).
