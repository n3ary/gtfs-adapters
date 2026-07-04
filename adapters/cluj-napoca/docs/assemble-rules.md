# Reconciliation rules

> [!IMPORTANT]
> **Single source of truth** for the question: *"source A and source B
> disagree about the same field — which wins?"*
>
> If you change anything here, update `docs/known-limitations.md` to
> reflect the new gaps and `tests/reconcile.test.js` to cover the case.

## Inputs

The adapter pulls from three independent sources for the same operator
(CTP Cluj-Napoca, `agency_id=2`):

| Source | Endpoint / file | Strong on | Weak on |
|---|---|---|---|
| **Transitous seed** | `https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip` | Curated, mdb-validated structure. `mdb-2121` mirror. Has authoritative `stop_times.txt` for routes whose CTP CSV is missing. | Update cadence is irregular — sometimes weeks stale (`neary-gtfs#1`). Missing entire directions for some routes (`neary-gtfs#13` for 25N, `#15` for M26). |
| **Tranzy.ai static** | `https://api.tranzy.ai/v1/opendata/{routes,stops,trips,stop_times,shapes}` | Live-updated routes/stops/headsigns/shapes. Per-direction shapes (`<route>_<dir>` shape_id convention). | No `arrival_time` / `departure_time`. No `calendar.txt` for most agencies (404). IDs are internal to Tranzy, may differ from Transitous. |
| **CTP CSV timetables** | `https://ctpcj.ro/orare/csv/orar_<route>_<serviceKey>.csv` | Authoritative departure times per route × service day. Fresh (hours, not weeks). Terminal stop names. | Per-route per-service-day, no full network shape. Some routes publish nothing (63 of ~300 per `neary-gtfs#1`). The CSV's dir0 column sometimes carries frequency annotations instead of times (`neary-gtfs#15` M26). |

## Priority table

> [!IMPORTANT]
> **Tranzy is the primary catalog.** Cluj-Napoca city hall promotes
> Tranzy as the authoritative live source for the network (see
> `https://ctpcj.ro/index.php/ro/despre-noi/open-data-tranzy`), so
> Tranzy is more up-to-date than the Transitous `mdb-2121` mirror:
> 168 vs 108 routes, 880+ vs 750 stops, fresher colors/headsigns,
> newer metropolitan lines (M22–M81, etc.). Transitous is consulted
> only for **ID stability** — downstream apps (notably `neary`) key
> routes/stops by id, and we don't want to break those references
> every time Tranzy's internal numeric IDs rotate.

The general rule is: **Tranzy wins for content (live data), Transitous
provides ID stability for shared entities, CSV wins for actual times.**
Read the **Rationale** column before changing a priority — it captures
the *why*, not just the *what*.

| Field | Primary | Fallback 1 | Fallback 2 | Last resort | Rationale |
|---|---|---|---|---|---|
| `agency` | Transitous seed | — | — | synthesized from config | Why seed: `agency.txt` only needs one row; Transitous's curated single-agency row is canonical for Cluj. Why synthesized last resort: if both seed and Tranzy are silent, fall back to a `.env`-driven row so the output stays valid GTFS. |
| `routes[].route_id` | **Transitous seed (when shared)** else Tranzy | Tranzy for Tranzy-only | Transitous seed for Transitous-only | — | Why Transitous for shared: Transitous IDs are stable, mdb-curated, and what downstream consumers already key on — we re-key shared Tranzy rows to Transitous's `route_id`. Why Tranzy for Tranzy-only: routes CTP added since Transitous's last import. Why Transitous-only as its own case: legacy routes Transitous still carries but Tranzy has dropped. |
| `routes[].route_short_name` | **Tranzy** | Transitous seed | CSV URL filename | — | Why Tranzy: CTP city-hall promotes Tranzy; live source for short names. Why Transitous: a small set of legacy routes Tranzy doesn't carry. Why CSV last: the URL filename (`orar_35_lv.csv`) embeds the short name CTP publishes, but it's the weakest source. |
| `routes[].route_long_name` | **Tranzy** | Transitous seed | CSV row 0 `route_long_name` | `route_short_name` | Why Tranzy: live renaming source. Why seed: curated long names. Why CSV row 0: rows 0 of the CSV carries the literal long-name string (e.g. `"Zorilor - Marasti"`), which is what CTP uses on their own timetable pages. |
| `routes[].route_type` | **Tranzy** | Transitous seed | 3 (bus default) | — | Why Tranzy: Tranzy is CTP's promoted live source and the producer-of-record for what each route currently runs as. Why seed: routes Tranzy doesn't carry at all. Why bus default: Cluj is overwhelmingly buses (148 of 168 routes per current Tranzy catalog); if all upstream is missing the type, defaulting to bus is the least-wrong answer. Note: missing-vs-falsy matters here — `route_type=0` (tram) is a valid GTFS enum value, so this column uses `?? '3'` instead of `? : '3'` to preserve `0`. |
| `routes[].route_color` | **Tranzy** (normalized to 6-char hex per GTFS spec) — black/missing **substituted with the per-type modal color**, then **OKLCh hue-rotated if multiple types share the same modal**, with the rotation **nudged away from any existing one-off color** | Transitous seed (same rule applies) | per-type modal color | FFFFFF (GTFS default; only when the type has no modal) | Why Tranzy: Tranzy inherits CTP's published color live. Why normalize: GTFS `Color` is a six-digit hex string; Tranzy occasionally returns 3-char CSS shorthand (e.g. `'000'`) which the spec doesn't permit — we expand to `'000000'` rather than pass through. Why substitute black/missing: Tranzy's per-route colors carry no consistent signal (for buses the top two are `#000` × 74 and `#f3513c` × 68, with the rest one-offs); the modal non-black color per `route_type` is the only "this is what most routes of this mode look like" signal we can derive from data. Non-black one-offs are preserved as-is. Why OKLCh hue rotation on collisions: Tranzy's CTP catalog has tram + bus + trolleybus all centered on `#F3513C` — without skewing, the published feed has no visual way to tell modes apart. The type with the most routes at the colliding color keeps it (least churn); others get rotated `i·360°/N` around the OKLCh hue wheel, which preserves perceived lightness (so white text still has contrast) while moving genuinely different hues, not just lighter/darker shades. Why nudge away from one-offs: the naive `i·360°/N` rotation can land near an existing one-off (e.g. tram's +240° landing on `#6482FF` blue is OKLab-close to bus one-off `#002FFF`). The resolver searches outward from the ideal angle in ±15° steps and picks the first one ≥ 0.15 OKLab away from every other color in the catalog (one-offs + already-assigned modals). 0.15 is the "clearly different colors" threshold in OKLab distance. Why `FFFFFF` last resort: matches the [spec's consumer default](https://gtfs.org/documentation/schedule/reference/#routestxt) when omitted. |
| `routes[].route_text_color` | **always `FFFFFF`** (uniform white) | — | — | — | Why uniform white: Tranzy returns `null` for `route_text_color` on every CTP route (verified 2026-06-30 across all 168 rows). After the per-type modal substitution, every background is dark enough that white is the only value satisfying the spec's contrast requirement across the catalog. Picking one value also keeps the feed visually consistent — there's no reason for one route's badge to read black and another white when the goal is to identify the route by its background color. |
| `stops[].stop_id` | **Tranzy** | Transitous seed | — | — | Why Tranzy: Tranzy covers more of the network (~880 stops vs Transitous's ~750). Why seed: the legacy few hundred stops Tranzy doesn't carry. Tranzy and Transitous use **different id namespaces**, so this is effectively "union of both" with Tranzy iterated first. |
| `stops[].stop_name` | **Tranzy** | Transitous seed | — | — | Why Tranzy: live signage source. Why seed: curated names. Why no CSV fallback: the CSV doesn't carry per-stop names. |
| `stops[].stop_lat` / `stop_lon` | **Tranzy** | Transitous seed | — | — | Why Tranzy: GPS-surveyed live coordinates. Why seed: mdb-validated coordinate cleanup. Why no third fallback: a stop without coordinates is unusable — drop rather than guess. |
| `stops[].stop_code` | **Tranzy** (sometimes Roman — see warning) | Transitous seed | empty | — | Why Tranzy: live signage code. Why seed: same source. Why empty last resort: don't synthesize a code — most consumers look up by `stop_id` anyway, and the Roman-numeral quirk makes guessing hazardous. |
| `shapes[].shape_id` | **Tranzy (`<route>_<dir>` convention)** | Transitous seed (mdb-2121) | synthesized from stop sequence | — | Why Tranzy: per-direction shapes (`35_0`, `35_1`) are the canonical operator routing geometry. Why seed: legacy shapes Tranzy doesn't carry. Why synthesized last: synthesize from `route_id`+`dir` so consumers always have something to look up. |
| `shapes[].shape_pt_*` | **Tranzy** | Transitous seed | haversine between consecutive stops | — | Why Tranzy: live polyline. Why seed: mdb-validated polyline. Why haversine: when both upstream missing, fall back to straight-line interpolation between stops — gives at least a renderable route on the map. |
| `trips[].trip_id` | **generated** — `${routeId}_${dir}_${serviceId}_${HHMM}` | — | — | — | Why generated (and why NOT claiming parity with the RT feed): the `neary` reconciler matches live observations to scheduled trips by `(routeId, directionId, tripStartMin)` with adaptive tolerance, **not** by `trip_id` equality — see `neary/src/lib/domain/reconcile.ts:5-14`. Static and RT trip_ids drift ~23% because each generator pulls from independent dispatch databases. The HHMM tail is the only structural requirement: it lets `neary`'s `parseLiveStartMin` extract start time from the suffix when `TripDescriptor.start_time` is missing. See `docs/known-limitations.md` §8. |
| `trips[].route_id` | CSV's URL filename (resolves to **Tranzy's** `route_id` first, then Transitous's) | Transitous seed | Tranzy | — | Why CSV URL first: the CSV is the authoritative source for *which routes have published schedules* — without it, we wouldn't be generating this trip. The URL embeds `route_short_name` which we resolve via the routes map (Tranzy primary, Transitous as id-stability overlay). |
| `trips[].direction_id` | CSV column index (0 = first col, 1 = second col), **validated** against `in_stop_name` / `out_stop_name` headers in `src/assemble/emit/trips.js` | — | — | — | Why CSV column: each data row in the CSV has TWO columns of departures — column 0 is direction 0 (forward, toward `out_stop_name`), column 1 is direction 1 (return, toward `in_stop_name`). This is the only place direction info lives in the CSV. **Validation:** the assembler cross-checks the CSV's terminal-name header against the resolved pattern's last stop; mismatch emits a warning and skips the CSV terminal as a headsign fallback (see `src/assemble/emit/trips.js` `terminalNamesMatch`). |
| `trips[].service_id` | CSV URL key mapped via `serviceIdMap` (`lv → LV`, `s → S`, `d → D`, `ld → LD`) | — | — | — | Why CSV URL key: each CSV is downloaded with a service-day suffix in the URL (`..._lv.csv`, `..._s.csv`). That suffix, mapped through `serviceIdMap`, becomes the GTFS `service_id`. Most precise source — it's literally how we decided to download this CSV. |
| `trips[].trip_headsign` | **Tranzy (live)** | Transitous seed | CSV `out_stop_name` (dir0) / `in_stop_name` (dir1) | `route_long_name` | Why Tranzy first: headsign is a *label*, not structural. Tranzy refreshes labels when CTP renames termini. Seed's headsign is stale if CTP changed it. Why CSV last resort: rows 3 and 4 of the CSV carry `in_stop_name` and `out_stop_name` — the terminal labels from CTP's published timetable (rows 0-4 are metadata; see `docs/csv-timetable-format.md`). |
| `trips[].shape_id` | **Tranzy `<route>_<dir>`** | Transitous seed | synthesized `${route_id}_${dir}` | empty | Why Tranzy first: per-direction shape is the canonical routing geometry — Tranzy's `<route>_<dir>` is the convention. Why seed: when Tranzy missing, seed's shape (if any) carries over. Why synthesized last: synthesize from `route_id`+`dir` so consumers always have something to look up. |
| `stop_times[].stop_id` | pattern lookup (Tranzy pattern first, seed fallback per `patterns.js`) | — | — | — | Why pattern lookup: stop_times are generated by walking the resolved pattern's stop sequence, so `stop_id` comes from the pattern, not a separate source. |
| `stop_times[].arrival_time` / `departure_time` | **synthesized** via `computeStopTimes()` from CSV's first departure time + `timing.js` | — | — | — | Why synthesized: CSV gives us origin departure time only. The rest comes from `computeStopTimes()` which projects the origin time across the pattern using shape-aware distance + peak/offpeak/night speed buckets + dwell. This is the only way to produce per-stop times without authoritative schedule data. See `lib/timing.js`. |
| `stop_times[].stop_sequence` | upstream's `stop_sequence` from the resolved pattern (Tranzy first, Transitous seed fallback) | re-numbered sequential index (fallback) | — | — | Why upstream's value: the resolved pattern carries the source's authoritative `stop_sequence` — when it's Tranzy's pattern, that's Tranzy's per-trip number; when Transitous's, that's Transitous's. Re-numbering with a sequential index would discard any non-contiguous numbering the operator uses (gaps for dwell-only stops, odd-numbered extras, etc.). Fallback to sequential index only if the pattern somehow lost the sequence (shouldn't happen with current sources). |
| `stop_times[].timepoint` | **synthesized** — always `'0'` (approximate) | — | — | — | Why `'0'`: our arrival/departure times come from `computeStopTimes()` projecting the CSV origin time across the shape — they're interpolated, not authoritative per-stop times. Per GTFS spec, `timepoint=0` is the canonical signal that times are approximate. See https://gtfs.org/schedule/reference/#stop_timestxt. |
| `stop_times[].shape_dist_traveled` | `cumulativeShapeDistances()` from the chosen shape | — | — | — | Why from shape: GTFS spec defines this as distance along the trip's shape. We use `cumulativeShapeDistances()` (vendored from `neary-gtfs`) which projects each stop onto the polyline, with haversine fallback for off-shape stops. |
| `calendar[].service_id` | `LV` / `S` / `D` / `LD` derived from CSV keys actually scraped | — | Tranzy (if 200) | synthesized | Why derived from CSV keys: each CSV we successfully parse confirms a service_id is active. We don't synthesize services we have no evidence for. Why Tranzy fallback: Tranzy's `/calendar` returns 404 for most agencies, but if it ever returns 200 we'd include those service_ids. |
| `calendar[].start_date` / `end_date` | build date + `GTFS_CALENDAR_DAYS` (default 180) | Tranzy | today only | — | Why build date + window: GTFS schedules are forward-looking. We publish "today + 6 months" which covers any consumer's planning window without locking in dates we can't validate against the seed. Why Tranzy fallback: Tranzy has real service windows if it ever exposes them. |
| `calendar[].{mon..sun}` | hardcoded service-day table (LV = M-F, S = Sat, D = Sun, LD = all) | Tranzy | — | — | Why hardcoded: the mapping is by definition — LV literally means "Luni-Vineri" (Monday-Friday) in Romanian. There's nothing to reconcile. |
| `feed_info` | static (publisher name, version = ISO date) | — | — | — | Why static: `feed_info` is meta about the producer of this feed, not data. We identify as `cluj-napoca-gtfs-adapter` and version by build date. Never overridden by upstream sources. |

## Pattern-resolution algorithm

For each `(route_id, direction_id)` pair that has CSV departures, we
need a stop sequence (the "pattern") to anchor the schedule. **Tranzy
is primary**, Transitous seed is fallback:

```
function patternFor(routeId, directionId):
    tranzy = tranzyPatterns[routeId][directionId]   // Tranzy patterns
    if tranzy exists:
        return { stops: tranzy.stopSequence, shapeId: tranzy.shapeId, source: 'tranzy' }

    seed = seedPatterns[routeId][directionId]    // Transitous seed
    if seed exists:
        return { stops: seed.stopSequence, shapeId: seed.shapeId, source: 'seed' }

    // Last resort: synthesize by walking the stops along the shape from CSV's
    // in_stop_name/out_stop_name. This is what neary-gtfs#13 suggests as a
    // third option. For now we LOG a warning and skip.
    log.warn(`No pattern for ${routeId} dir=${directionId} — dropping departures`)
    return null
```

The Tranzy-first choice is what fixes `neary-gtfs#13` (25N direction=1)
and `neary-gtfs#15` (M26 direction=1) — both were missing from the
Transitous seed but present in Tranzy. Earlier versions of this adapter
used seed-first priority and silently dropped those directions; the
flip moved those routes from "warnings + 0 trips" to "real schedule".

### Trip-headsign resolution

When Tranzy publishes a more recent headsign than Transitous (e.g. a route
renamed a terminus), we prefer Tranzy. CSV's `in_stop_name` / `out_stop_name`
(rows 3 and 4 of the CSV — see [`docs/csv-timetable-format.md`](./csv-timetable-format.md))
is the third fallback: it's the literal terminal label from CTP's
timetable, useful as a tiebreaker when both seed and Tranzy headsign are empty.

### Schedule-generation algorithm

For each CSV departure `HH:MM` on pattern `P`:

```
startSec = hhmmToSeconds(HH:MM)
{ arrivals, departures, shapeDistTraveledM, bucket, speedKmh } =
    computeStopTimes({
        startSec,
        stops: P.stops.map(s => ({ stopId: s.stopId, lat: stopCoords[s.stopId].lat, lon: ... })),
        shape: shapesById[P.shapeId] ?? [],
        timing: TIMING,   // peak/offpeak/night + dwell config
    })

for (i = 0; i < P.stops.length; i++) {
    yield {
        trip_id: `${routeId}_${directionId}_${serviceId}_${HHMMDigits}`,
        arrival_time: formatGtfsTime(arrivals[i]),
        departure_time: formatGtfsTime(departures[i]),
        stop_id: P.stops[i].stopId,
        stop_sequence: i,
        shape_dist_traveled: shapeDistTraveledM[i],
    }
}
```

The `bucket` / `speedKmh` returned by `computeStopTimes` are diagnostic —
logged per-route per-service-day so we can verify the time-of-day model
later.

## Data-quality checks (build warnings)

These don't block the build but emit `WARN` lines that should be reviewed
before merging the daily artifact:

1. **Routes with 0 emitted trips but CSV had non-suspended data** —
   surfaces the class of bug behind `neary-gtfs#15` (M26).
   *Suspended* = CSV row 0 starts with `"Nu circula"` or `"In lucru"` —
   explicit signals that zero trips is correct.

2. **CSV departures dropped due to non-`HH:MM` cells** — surfaces
   `neary-gtfs#15` M26's `05:05-22:40` / `10-20min` annotations. Currently
   we drop silently and warn; full frequency-annotation parsing
   (`frequencies.txt`) is a future feature.

3. **Stop with empty `stop_lat` / `stop_lon`** — Tranzy occasionally
   returns stops with coordinates as empty strings. Drop the stop from
   the patterns it's referenced in, or skip the route. Don't emit a
   trip whose stop sequence has a missing coordinate.

4. **Multiple agencies in `agency.txt`** — surfaces `neary#87`'s
   validator concern. Single-agency feeds (like ours) should have exactly
   one row in `agency.txt`. Warn if not.

5. **CSV row count mismatch with seed trip count** — if the seed
   publishes `N` trips for `(route, dir)` and CSV publishes `M` very
   different departure times, log both for visibility. We don't reconcile
   to the seed's count — CSV wins for trip count.

## Out of scope (deliberately)

- **Reconciling agency_id** — Transitous and Tranzy both treat CTP as
  agency `2`; CSV has no agency concept. No reconciliation needed.
- **Cross-source `stop_id` remapping** — Tranzy and Transitous use
  *different* `stop_id` namespaces for the same physical stops. Rather
  than build a brittle name+coords heuristic match, the reconciler
  unions both catalogs (every Tranzy stop + every Transitous stop with
  no matching id in Tranzy). Downstream apps consuming by `stop_id`
  should expect both namespaces to appear; in practice each consumer
  uses only one (neary uses Transitous, the live vehicle feed uses
  Tranzy).
- **Cross-source `route_id` remapping for shared routes** — we
  re-publish Transitous's `route_id` for shared routes (so `neary`
  catalog references keep working), and keep Tranzy's `route_id` for
  Tranzy-only routes. Tranzy's ID is **not** preserved on shared
  routes — using Transitous's stable ID is the deliberate choice.
- **`feed_publisher_name`** — always `cluj-napoca-gtfs-adapter`. We do
  not impersonate Transitous or CTP.
- **License attribution** — preserved as-is from the seed (`CC-BY` to
  CTP). Our `feed_info.txt` adds our publisher but does not strip the
  upstream attribution.