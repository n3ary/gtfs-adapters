# Architecture

## Goal

Produce a single reconciled GTFS Schedule zip for CTP Cluj-Napoca
(`agency_id=2`) that combines:

- **Transitous seed** — curated structure, mdb-validated
- **Tranzy.ai** — live-updated static API, per-direction shapes
- **CTP CSV timetables** — authoritative departure times

…and is published by the orchestrator (`n3ary/gtfs-publisher`) to
Cloudflare R2 so the [neary](https://github.com/ciotlosm/neary) PWA
can consume it like any other GTFS source.

## Driver: `n3ary/gtfs-publisher` orchestrator

This adapter's runtime is now driven by the `gtfs-publisher`
orchestrator. Daily flow:

```
gtfs-publisher cron (00:30 UTC)
  → packages/gtfs-static pipeline (`node dist/cli.js`)
    → for source.type === 'adapter' feeds:
      → acquireGtfsAdapter(feedId, publisher)
        → dynamic-import(`${publisher}/ingest`)
          → ingestBuild({ outputDir, buildDate, secrets })
            → Transitous seed load
            → Tranzy fetch
            → CTP CSV scrape (live, on demand)
            → reconcile → serialize via spec
            → writeGtfsZip → return { zip, sizeBytes }
        ← bytes
      → deriveBbox + makeSqlite (with ${publisher}/static extension)
      → publish zip + sqlite to R2 + update feeds.json
```

The adapter **never** touches R2, never schedules itself, never owns a
CLI. It just exposes `ingestBuild()` and three subpaths:

- `./ingest` — `ingestBuild` (the runtime entry; required)
- `./static` — `staticExtension(feedConfig)` for sqlite columns
  (route colors + `_neary_config` table); required by the
  orchestrator's `makeSqlite`
- `./rt` — `clujRtQuirk` for the GTFS-RT proxy in `gtfs-rt`; loaded
  by the orchestrator's quirk registry

See `src/ingest/index.ts:38-77` for the `IngestOptions` /
`IngestResult` contract and `src/static/index.ts` for the extension
shape.

## Why three sources?

CTP doesn't expose its schedule data through one canonical GTFS feed:

- **Tranzy.ai** is the live network state — 168 routes, 880+ stops,
  per-direction shapes (`<route>_<dir>` convention), up-to-date
  colors/headsigns. CTP city hall officially promotes Tranzy as their
  open-data partner (see `https://ctpcj.ro/index.php/ro/despre-noi/
  open-data-tranzy`). Tranzy carries stop ordering but **not** arrival
  times (`/stop_times` has no `arrival_time`).
- **Transitous** mirror (`mdb-2121`) is the curated secondary catalog —
  108 routes, 750 stops, mdb-validated coordinates and IDs. Updates
  irregularly (sometimes weeks stale — see
  [`neary-gtfs#1`](https://github.com/ciotlosm/neary-gtfs/issues/1)).
  Used by this adapter mainly for **ID stability**: downstream apps
  (notably `neary`) already key routes by Transitous `route_id`, and
  re-keying shared routes to Tranzy's internal IDs would break every
  catalog reference.
- **CTP CSV timetables** carry the real departure times per route per
  service day. CTP doesn't publish them for every route (~63 of ~298
  missing — same `neary-gtfs#1`).

The three sources are complementary. Reconciliation is the only way to
get a feed that's *complete*, *fresh*, and *correct* — and *stable in
the IDs downstream apps already key on*.

## Data flow

```
   ┌──────────────┐  ┌────────────┐         ┌──────────────────┐
   │  Transitous  │  │   Tranzy   │         │  CTP CSV scrape  │
   │  seed zip    │  │  /routes   │         │  ctpcj.ro/orare/ │
   │  (no auth)   │  │  /stops    │         │  csv/orar_*.csv  │
   │              │  │  /trips    │         │  (WAF headers)   │
   │              │  │  /shapes   │         │                  │
   │              │  │  /stop_tim │         │                  │
   │              │  │  (X-API-KEY│         │                  │
   │              │  │  + AGENCY) │         │                  │
   └──────┬───────┘  └─────┬──────┘         └────────┬─────────┘
          │                │                         │
          ▼                ▼                         ▼
       ┌──────────────────────────────────────────────────┐
       │  src/sources/  (each = client.ts + transform.ts) │
       │  tranzy/   transitous/   ctp-csv/               │
       │  (REST)    (zip)         (REST, live)           │
       │  + index.ts entry-point per source              │
       └─────────────────────┬────────────────────────────┘
                             │
                             ▼
       ┌──────────────────────────────────────────────────┐
       │  src/assemble/                                   │
       │                                                  │
       │  merge/   ← combine multiple sources             │
       │    routes.ts    stops.ts    shapes.ts           │
       │                                                  │
       │  derive/  ← build one structure from inputs      │
       │    patterns.ts   calendar.ts   frequencies.ts   │
       │                                                  │
       │  emit/    ← generate GTFS rows                  │
       │    trips.ts   tranzy-fallback.ts   networks.ts  │
       │                                                  │
       │  check/   ← coverage warnings (CTP-specific)    │
       │    data-quality.ts                             │
       │                                                  │
       │  index.ts (top-level orchestrator for `reconcile`) │
       │                                                  │
       │  See docs/assemble-rules.md for priority table   │
       │  and edge-case handling.                         │
       └─────────────────────┬────────────────────────────┘
                             │
                             ▼
       ┌──────────────────────────────────────────────────┐
       │              src/gtfs.ts                         │
       │   write .txt files → output/cluj-napoca.gtfs.zip │
       │   (agency, routes, stops, shapes, calendar,      │
       │    trips, stop_times, networks,                  │
       │    route_networks, feed_info)                   │
       │   (All writers use @n3ary/gtfs-spec/serialize —  │
       │    spec owns column order + RFC 4180 quoting.)   │
       └─────────────────────┬────────────────────────────┘
                             │
                             ▼
                { zip: Buffer, sizeBytes: number }
                             │
                             ▼
                  gtfs-publisher orchestrator
                             │
                             ▼
                  Cloudflare R2 (neary-gtfs/feeds.json)
```

## Components

### `src/sources/`

Each upstream source has its own folder with a 3-file structure:
`client.ts` (network IO), `transform.ts` (pure data shape conversion),
`index.ts` (public API + convenience loader).

- `src/sources/tranzy/` — Tranzy.ai REST client + GTFS-shaped transform.
  Public API: `loadTranzyData(opts)` → `{ routes, stops, trips, ...,
  byRouteId, byStopId }`. Single network layer (`TranzyClient`), pure
  transform layer (stamps `source: 'tranzy'` + builds indexes).
- `src/sources/transitous/` — Transitous GTFS zip loader + transform.
  Public API: `loadTransitousData(opts)` → `{ routes, stops, trips, ...,
  patternsByRouteDir }`.
- `src/sources/ctp-csv/` — CTP CSV timetable fetcher + parser. Public
  API: `fetchCtpCsv()` (network, live), `fetchAllCsvSchedules()`
  (multi-fetch orchestrator), `parseCtpCsv()` (pure parser),
  `buildCtpCsvUrl()` + `normalizeShortNameForCtpUrl()` (URL builder —
  the latter strips whitespace so `39 CREIC` becomes `39CREIC`).
  Note: previously also exposed `readCtpCsvFromDisk()` for a
  two-phase smoke→build pipeline. That helper was retired when
  `gtfs-publisher` became the canonical build driver — the live
  fetch path here is now the only entry point the adapter uses.

### `src/assemble/`

Pipeline that produces the final in-memory GTFS structure, grouped by
the kind of work each file does:

- `merge/` — combine rows from multiple sources.
  - `routes.ts` — Tranzy primary + Transitous overlay (re-keys shared
    routes to Transitous `route_id` for downstream stability).
  - `stops.ts` — Tranzy primary + Transitous fill (Tranzy covers more
    stops; Transitous fills the legacy few hundred Tranzy doesn't).
  - `shapes.ts` — Tranzy primary + Transitous fill (per-direction
    shapes `<route>_<dir>` convention).
- `derive/` — build one structure from a single source.
  - `patterns.ts` — first trip's stop sequence per `(route_id, dir)`;
    Tranzy primary, Transitous seed fallback.
  - `calendar.ts` — service-id → weekday-bool map from CSV keys.
  - `frequencies.ts` — anchor trip emission for `*-range` annotations.
- `emit/` — generate GTFS rows.
  - `trips.ts` — for each CSV departure, pick the pattern, generate
    `trip_id` (format `${route}_${dir}_${serviceId}_${HHMM}`), write
    trip + stop_times rows. Validates CSV terminals against pattern
    first stops. Emits `timepoint='0'` on every stop_time row (times
    are interpolated, not authoritative).
  - `tranzy-fallback.ts` — NTxxx fallback trips for routes without CSV.
  - `networks.ts` — `networks.txt` + `route_networks.txt` from
    classified routes.
- `check/` — coverage warnings (CTP-specific).
  - `data-quality.ts` — emit warnings (#14 route colors, #15 M26
    frequencies, etc.).

`index.ts` at top of `assemble/` is the orchestrator for `reconcile()`.

**Source priority table** lives in
[`docs/assemble-rules.md`](./assemble-rules.md). Transitous is
consulted only for: ID stability on shared routes, fallback patterns
for Transitous-only routes (~1 today), lookup-only fallbacks when CTP
references a stop Tranzy doesn't have, and `agency.txt`.

### `src/lib/`

Pure helpers, no I/O.

- `seed.ts` — load Transitous GTFS zip from path/URL, parse with
  `@n3ary/gtfs-spec/spec` parsers.
- `timing.ts` — `pickSpeedBucket()` + `computeStopTimes()` (peak/offpeak/
  night speed model + shape projection + dwell).
- `polyline.ts` — `cumulativeShapeDistances()` (adapter-specific
  composition helper) + re-exports of `haversineMeters` and
  `projectOnPolyline` from `@n3ary/gtfs-spec/shape` (canonical
  shared math).
- `log-severity.ts` — tagged warning objects (`{severity, message, meta}`)
  with GHA `::group::` rendering and ANSI colors.

### `src/gtfs.ts`

The output writer. Given the assembled in-memory structures from
`src/assemble/`, writes the eight required GTFS `.txt` files plus
`feed_info.txt` into a zip using `archiver`. (Previously also exposed
`validateGtfsZip()`; that responsibility moved to
`n3ary/gtfs-publisher`'s `validate.ts` + the spec DDL's CHECK + FK
constraints.)

### `src/ingest/index.ts`

The runtime entry point. Exports `ingestBuild(opts)` returning
`{ zip, sizeBytes }`. This is what `gtfs-publisher`'s orchestrator
dynamic-imports and calls.

### `src/static/index.ts`

The sqlite extension factory. Exports `staticExtension(feedConfig)`
returning a `StaticExtension` (column/table extensions + a
`fillComputedColumns` hook). The orchestrator passes this to
`makeSqlite(gtfsPath, feedId, staticExtension)` so the post-load hook
can apply route-color substitution + network-color writeback.

### `src/rt/index.ts`

The GTFS-RT quirk for the CTP live feed. Exports `clujRtQuirk`,
`parseClujTripId`, `registerRtQuirks`. Consumed by the
`gtfs-rt` proxy's quirk registry.

## Build / publish

- `pnpm build` — `tsc -p tsconfig.build.json`. Emits to `dist/`.
- `pnpm test` — `vitest --run`. 164 tests.
- `pnpm check` — `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit`.
- `pnpm smoke:trip-ids` — `tsx src/verify-trip-id-format.ts`.
  Self-checks that every emitted `trip_id` ends in `_HHMM` (or `_NTxxx`
  for Tranzy-fallback trips), so the `neary` app's `parseLiveStartMin`
  fallback can extract the scheduled start time from the suffix.
  (Not a "parity check" against an external RT feed — those don't
  share IDs. See `docs/known-limitations.md` § RT parity for the
  full story on why that was misunderstood.)

Publishing: `adapters/cluj-napoca/v*` tags trigger
`.github/workflows/publish-adapter.yml` which calls
`npm publish --provenance --access public` against GitHub Packages.
The orchestrator pins an exact version in
`packages/gtfs-static/package.json` and bumps it in a PR after each
release.