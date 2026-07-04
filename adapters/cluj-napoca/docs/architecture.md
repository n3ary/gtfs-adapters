# Architecture

## Goal

Produce a **single** reconciled GTFS Schedule zip for CTP Cluj-Napoca
(`agency_id=2`) that combines:

- **Transitous seed** — curated structure, mdb-validated
- **Tranzy.ai** — live-updated static API, per-direction shapes
- **CTP CSV timetables** — authoritative departure times

…and is **always available** at a stable URL (GitHub Pages `binaries`
branch, via GitHub raw) so the [neary](https://github.com/ciotlosm/neary)
PWA can consume it like any other GTFS source.

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
                  ┌─────────────────────────────────────────┐
                  │  GitHub Actions (cron 30 0 * * * UTC)   │
                  └────────────────────┬────────────────────┘
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            │                                                     │
            ▼                                                     ▼
   ┌─────────────────────┐                            ┌──────────────────┐
   │  Stage 1 — fetch    │                            │  Stage 2 — build │
   │  scripts/smoke-     │   .build-input/csv/        │  src/cli.js      │
   │  csv-parser.js      │   .build-input/csv-        │  build           │
   │                     │   status.json             │                  │
   │  Authoritative      │   (200-ok CSV bodies +    │  Reads CSVs from │
   │  route list:        │    manifest of every      │  disk. NEVER     │
   │   Tranzy union      │    attempt's outcome)     │  fetches.        │
   │   Transitous seed   │                            │                  │
   │                     │                            │  Assembles       │
   │  Fetches every      │                            │  routes/stops/   │
   │  (route × service)  │                            │  shapes/trips/   │
   │  CSV from CTP.      │                            │  calendar →      │
   │  Writes body on     │                            │  GTFS zip.       │
   │  200-ok. Fails loud │                            │                  │
   │  on infra miss.     │                            │                  │
   └─────────────────────┘                            └──────────────────┘
```

**Why two phases?** Smoke acts as a gate — if upstream has a
WAF/HTTP/network failure, CI fails before build runs, so we never
produce a degraded zip. Single fetch per CSV per CI run (no double-fetch).

**Authoritative route source for smoke**: Tranzy (`/routes` endpoint)
+ Transitous seed (id stability). Tranzy is the source of truth for
*what CTP operates* (~168 routes vs Transitous's ~108); Transitous adds
id stability for shared routes so downstream apps (neary) keep their
keying on Transitous `route_id`. Transitous-only routes still get CSV
fetches in case CTP publishes them.

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
       │  src/sources/  (each = client.js + transform.js) │
       │  tranzy/   transitous/   ctp-csv/               │
       │  (REST)    (zip)         (REST or disk)         │
       │  + index.js entry-point per source              │
       └─────────────────────┬────────────────────────────┘
                             │
                             ▼
       ┌──────────────────────────────────────────────────┐
       │  src/assemble/                                   │
       │                                                  │
       │  merge/   ← combine multiple sources             │
       │    routes.js    stops.js    shapes.js            │
       │                                                  │
       │  derive/  ← build one structure from inputs      │
       │    patterns.js   calendar.js   frequencies.js   │
       │                                                  │
       │  emit/    ← generate GTFS rows                  │
       │    trips.js   tranzy-fallback.js                │
       │                                                  │
       │  check/   ← validation + warnings                │
       │    data-quality.js                              │
       │                                                  │
       │  index.js (orchestrator)                         │
       │                                                  │
       │  See docs/assemble-rules.md for priority table   │
       │  and edge-case handling.                         │
       └─────────────────────┬────────────────────────────┘
                             │
                             ▼
       ┌──────────────────────────────────────────────────┐
       │              src/gtfs.js                         │
       │   write .txt files → output/cluj-napoca.gtfs.zip │
       │   (agency, routes, stops, shapes, calendar,      │
       │    trips, stop_times, feed_info)                 │
       └─────────────────────┬────────────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  GitHub `binaries`   │
                  │  branch / GitHub raw  │
                  │  CDN                 │
                  └──────────────────────┘
```

## Components

### `src/sources/`

Each upstream source has its own folder with a 3-file structure:
`client.js` (network/disk IO), `transform.js` (pure data shape
conversion), `index.js` (public API + convenience loader).

- `src/sources/tranzy/` — Tranzy.ai REST client + GTFS-shaped transform.
  Public API: `loadTranzyData(opts)` → `{ routes, stops, trips, ...,
  byRouteId, byStopId }`. Single network layer (`TranzyClient`), pure
  transform layer (stamps `source: 'tranzy'` + builds indexes).
- `src/sources/transitous/` — Transitous GTFS zip loader + transform.
  Public API: `loadTransitousData(opts)` → `{ routes, stops, trips, ...,
  patternsByRouteDir }`.
- `src/sources/ctp-csv/` — CTP CSV timetable fetcher + parser. Public
  API: `fetchCtpCsv()` (network), `readCtpCsvFromDisk()` (build phase
  reads pre-fetched CSVs from `.build-input/`), `fetchAllCsvSchedules()`
  (multi-fetch orchestrator), `parseCtpCsv()` (pure parser),
  `buildCtpCsvUrl()` + `normalizeShortNameForCtpUrl()` (URL builder —
  the latter strips whitespace so `39 CREIC` becomes `39CREIC`).

### `src/assemble/`

Pipeline that produces the final in-memory GTFS structure, grouped by
the kind of work each file does:

- `merge/` — combine rows from multiple sources.
  - `routes.js` — Tranzy primary + Transitous overlay (re-keys shared
    routes to Transitous `route_id` for downstream stability).
  - `stops.js` — Tranzy primary + Transitous fill (Tranzy covers more
    stops; Transitous fills the legacy few hundred Tranzy doesn't).
  - `shapes.js` — Tranzy primary + Transitous fill (per-direction
    shapes `<route>_<dir>` convention).
- `derive/` — build one structure from a single source.
  - `patterns.js` — first trip's stop sequence per `(route_id, dir)`;
    Tranzy primary, Transitous seed fallback.
  - `calendar.js` — service-id → weekday-bool map from CSV keys.
  - `frequencies.js` — anchor trip emission for `*-range` annotations.
- `emit/` — generate GTFS rows.
  - `trips.js` — for each CSV departure, pick the pattern, generate
    `trip_id` (format `${route}_${dir}_${serviceId}_${HHMM}`), write
    trip + stop_times rows. Validates CSV terminals against pattern
    first stops. Emits `timepoint='0'` on every stop_time row (times
    are interpolated, not authoritative).
  - `tranzy-fallback.js` — NTxxx fallback trips for routes without CSV.
- `check/` — validation + warnings.
  - `data-quality.js` — emit warnings (#14 route colors, #15 M26
    frequencies, etc.).

`index.js` at top of `assemble/` is the orchestrator.

**Source priority table** lives in
[`docs/assemble-rules.md`](./assemble-rules.md). Transitous is
consulted only for: ID stability on shared routes, fallback patterns
for Transitous-only routes (~1 today), lookup-only fallbacks when CTP
references a stop Tranzy doesn't have, and `agency.txt`.

### `src/lib/`

Pure helpers, no I/O (mostly vendored from `neary-gtfs`):

- `build-input.js` — read/write helpers for `.build-input/csv-status.json`
  and `.build-input/csv/<route>_<svc>.csv` (the data-exchange layer
  between smoke and build phases).
- `seed.js` — load GTFS zip from path/URL.
- `timing.js` — `pickSpeedBucket()` + `computeStopTimes()` (peak/offpeak/
  night speed model + shape projection + dwell).
- `csv.js` — RFC4180-ish GTFS CSV parser (for reading the seed).
- `polyline.js` — project stops onto polyline, haversine fallback.
- `log-severity.js` — tagged warning objects (`{severity, message, meta}`)
  with GHA `::group::` rendering and ANSI colors.
- `stop-id-translator.js` — Transitous→Tranzy stop_id mapping by
  name (CTP CSVs reference stops by name; the seed has different ids).

### `src/gtfs.js`

The output writer. Given the assembled in-memory structures from
`src/assemble/`, writes the eight required GTFS `.txt` files plus
`feed_info.txt` into a zip using `archiver`.

### `src/cli.js`

Single entry point:

```bash
node src/cli.js build           # reads CSVs from .build-input/, assembles → output/<name>.gtfs.zip
node src/cli.js validate [path]  # check a produced zip
node src/cli.js reconcile       # fetches CSVs upstream (dev only), prints summary
```

## Deployment

GitHub Actions cron at `30 0 * * *` UTC (after Transitous's daily ~00:00
UTC import). Two-phase pipeline:

1. Checkout this repo.
2. Setup Node 24, `pnpm install`.
3. **Stage 1** — `pnpm fetch:csv` (fetches all CSVs from CTP, populates
   `.build-input/`). Fails loud on infra misses (WAF / HTTP 5xx / network).
4. **Stage 2** — `node src/cli.js build` (reads CSVs from `.build-input/`,
   assembles the GTFS feed, writes the zip). Never fetches upstream.
   Both stages use `TRANZY_API_KEY` from repo secret.
5. Push `output/cluj-napoca.gtfs.zip` to the root of the `binaries`
   branch (orphan, no `output/` prefix — the branch itself is the
   artifact namespace, same pattern as `neary-gtfs/.github/workflows/daily.yml`).
6. GitHub raw serves it at
   `https://raw.githubusercontent.com/ciotlosm/cluj-napoca-gtfs-adapter/binaries/cluj-napoca.gtfs.zip`.

The `neary-gtfs` pipeline then mirrors this URL into its `binaries`
branch's `feeds.json` (or directly via a `realtime.zip` style entry)
instead of running its own `feeds/cluj-napoca/build.js`. The vestigial
`tranzy` field in `feeds/cluj-napoca/config.json` gets removed at that
point.

## What lives in `neary-gtfs` after this lands

| Today | After |
|---|---|
| `feeds/cluj-napoca/build.js` — 339-line enhancement script | Removed; replaced by fetching this adapter's zip. |
| `feeds/cluj-napoca/config.json` — declarative metadata | Kept as a thin config that points at this adapter's URL. |
| `feeds/cluj-napoca/lib/{seed,timing}.js` — vendored | Kept in their original locations (already shared via copy). |
| `tranzy` field in config (vestigial) | Removed. |
| Daily pipeline: `node src/pipeline/build-all.js` | Daily pipeline: same + a new "fetch adapter URL, store locally" step for the Cluj feed. |

The bigger refactor — collapsing the `neary-gtfs` pipeline into a
"download + SQLite" pipeline that consumes upstream feeds directly — is a
separate task. The minimum viable step is the deletion of
`feeds/cluj-napoca/build.js` and the config's `tranzy` field.