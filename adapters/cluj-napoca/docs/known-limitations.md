# Known limitations

> [!NOTE]
> What's still faked, approximated, or just plain missing. Each entry
> links to the upstream issue or source so we know what to track.

## 1. CSV frequency annotations

**Source:** [`neary-gtfs#15`](https://github.com/ciotlosm/neary-gtfs/issues/15) (M26)

The CTP CSV occasionally publishes cells that aren't `HH:MM` departure
times — they're headway / range annotations like `05:05-22:40` or
`10-20min`. The adapter parses them and emits a `frequencies.txt` row +
a synthetic anchor trip.

Recognized cell formats:

| Cell | Classification | Effect |
|---|---|---|
| `HH:MM` | time | Emitted as a regular trip in `trips.txt` + `stop_times.txt`. |
| `HH:MM-HH:MM` | range | Operating-hours window. Stored in `frequencyAnnotations.<dir>.ranges`. |
| `Nmin` or `N-Mmin` | headway | Headway in minutes. Stored in `frequencyAnnotations.<dir>.headways`. |
| `N-M` (no unit, ≤120) | headway (no-unit) | Same as `N-Mmin`. |
| Anything else | unknown | Logged as a warning; cell is dropped. |

For M26 LV (the original #15 example):

```
05:05-22:40,05:23   ← range + specific dir1 time
10-20min,05:32      ← headway + specific dir1 time
05:41,05:50          ← specific dir0 + specific dir1 times
```

The assembler derives:
- **Window:** earliest start (`05:05`) → latest end (`22:40`)
- **Headway:** average of headway range = `(10 + 20) / 2 = 15 min = 900 s`

…and emits:

```
frequencies.txt:
  M26_0_LV_FREQ_0505,05:05:00,22:40:00,900,0

trips.txt (anchor):
  M26,LV,M26_0_LV_FREQ_0505,Selimbar,0,92_0

stop_times.txt (anchor):
  M26_0_LV_FREQ_0505,05:05:00,05:05:00,D,0,0
  M26_0_LV_FREQ_0505,05:07:00,05:07:00,E,1,500
```

The anchor trip uses the resolved pattern's stop sequence (seed → Tranzy
fallback) and its scheduled times are at the start of the window. GTFS
consumers interpret `frequencies.txt` rows as overriding the anchor's
scheduled times, so the effective schedule is "every 15 minutes between
05:05 and 22:40".

**Edge cases (approximate):**

- **Only a headway, no range.** We use the default window `05:00–23:00`
  (urban-bus assumption) and log a warning.
- **Only a range, no headway.** We use the default headway 900 s
  (15 min) and log a warning.
- **Multiple non-overlapping ranges** on the same route/day. We use
  earliest start and latest end. Could emit one `frequencies.txt` row
  per range.
- **Range crossing midnight** (e.g. `22:00-02:00`). The parser doesn't
  recognize this; treat as malformed → warning.

Test coverage: `tests/frequencies.test.ts`.

## 2. Routes without CSV data fall back to the (potentially stale) seed

**Source:** [`neary-gtfs#1`](https://github.com/ciotlosm/neary-gtfs/issues/1) (closed), `neary-gtfs#15` (M26)

CTP doesn't publish CSVs for ~63 of ~298 routes (per `neary-gtfs#1`'s
investigation). These break down as:

| Category | Examples | Expected behavior |
|---|---|---|
| School transport (TE*) | TE1–TE14, TE5B, TE8B, M75A–M80 | Seasonal, school-year only. Emit zero trips outside the school calendar. |
| Night routes (*N) | M26N, M41N, 4N | May use different naming. We currently miss them entirely. |
| Emerson shuttle (88*) | 88A–88L | Event/shift routes — depends on event calendar we don't have. |
| Special/seasonal | 30U (Untold festival), CS (CURSA SPECIALĂ), D51 | Festival-only; expected zero trips outside the event window. |
| Suspended | M35, 2, M12L, M34B, 40S, 87B, 8D, 8S, 39S, 52B, 101A | CSV says "Nu circula" / "In lucru". Zero trips is correct. (`39 CREIC` is no longer in this list — see [`canonicalShortName`](../src/sources/ctp-csv/shortname-aliases.ts).) |
| Active but no CSV | (none confirmed at the moment) | If the seed also has no pattern for these, we silently emit zero trips. |

For routes without CSV but with **seed pattern** (`routes.txt` has the
route, `trips.txt` has pattern trips, `stop_times.txt` has actual times
from the seed): we **pass through the seed's trip data unchanged**. This
matches what the existing `neary-gtfs/feeds/cluj-napoca/build.js` does
for `routesWithoutCsv`. The seed's trips may be weeks stale.

For routes without CSV **and** without seed pattern (silent zero-trip
output): we currently log a warning and emit zero trips. The Tranzy
fallback fixes a subset of these (cases where Tranzy has a
`(route_id, direction_id)` pattern the seed is missing — see `neary-gtfs#13`).

## 3. Synthetic arrival/departure times when shape is missing

**Source:** the original `ctp-gtfs-adapter` design (memory file)

When neither the Transitous seed nor Tranzy publish a shape for a pattern,
`computeStopTimes()` falls back to haversine between consecutive stops.
This produces monotonic but slightly inaccurate times — corner-cutting
through buildings, etc.

**Detection:** if `shape_dist_traveled` between consecutive stops is
~equal to the haversine distance (within 5%) across the whole trip, we're
in haversine fallback. Log a warning per affected trip. The warning
surfaces in the orchestrator's daily cron's reconcile log.

**Fix:** none — the alternative is no schedule at all. Worth flagging
to the consumer app so it can show "approximate times" rather than "live".

## 4. Calendar is synthesized from the CSV service keys we actually scraped

**Source:** same as `neary-gtfs/feeds/cluj-napoca/build.js` lines 235–241.

If only `lv` succeeds for a route, that route's trips are tagged with
`service_id=LV` and won't appear in `S`/`D` views. The calendar's
`start_date` / `end_date` are derived from build date + `GTFS_CALENDAR_DAYS`
(default 180). Out-of-window trips are not currently generated.

**Implication:** the GTFS-Realtime feed (`cluj-rt-feed.gtfs.ro`) which our
trip IDs might match is **not** calendar-aware in the same way. We may need
to align `calendar.txt` with CTP's published service calendar — separate
investigation.

## 5. Tranzy `stop_code` is sometimes a Roman numeral

**Source:** empirical observation from the ctp-gtfs-adapter fixtures

CTP's `stop_code` field (the public-facing code on signage) can be `II`,
`IV`, etc. `Number("II")` returns `NaN`. The adapter treats `stop_code`
as an opaque string and passes it through. Downstream consumers should
do the same.

## 6. The Tranzy client throttles in-process only

`TRANZY_RATE_LIMIT_MS` is enforced via a "last-request timestamp" inside
each `TranzyClient` instance. If two assembler invocations run in
parallel, both can race past the throttle. For our usage we run one
build per minute (orchestrator cron at 00:30 UTC), so this is fine.
If you ever fan out, move throttling to a shared middleware.

## 7. The `agency.txt` timezone is hard-coded

**Source:** [`neary#87`](https://github.com/ciotlosm/neary/issues/87)

We write `agency_timezone=Europe/Bucharest` from config. The seed's
`agency.txt` may carry a different zone (or be missing). We currently
override it unconditionally. The neary#87 spec calls for a build-time
warning when a feed has multiple `agency.txt` rows with different
timezones — we implement that check but do not act on it (single-agency
feeds only). The orchestrator's `validate.ts` runs zip-level checks
on adapter-driven feeds; cross-reference orphans (incl. services
referenced by `trips.service_id` but missing from `calendar.txt`) are
caught at build time and fail the daily cron loud.

## 8. Trip ID format

Trip-id format is `${route_id}_${dir}_${serviceId}_${HHMM}` (or
`_NTxxx` for Tranzy-fallback trips). The trailing `_HHMM` lets
`neary`'s `parseLiveStartMin` extract a scheduled start time when
`TripDescriptor.start_time` is missing — fallback, not the canonical
JOIN key.

> [!IMPORTANT]
> **Trip IDs are not contract-bound to `cluj-rt-feed.gtfs.ro` GTFS-RT.**
> `neary/src/lib/domain/reconcile.ts` matches live observations to
> scheduled trips by `(routeId, directionId, tripStartMin)` — not by
> `trip_id` equality. The header comment on that file is explicit:
>
> > *"trip_id equality is NOT used as a fast-path. Some operators
> > publish static GTFS and GTFS-RT from independent build pipelines
> > that happen to share the same `route_dir_service_run_HHMM` schema
> > but populate `<run>_<HHMM>` from independent dispatch databases.
> > Cluj sampling 2026-06-27 showed ~23% of live trip_ids drifted
> > from their static counterparts by ±1 run number and/or ±a few
> > minutes in HHMM."*

The trip-id format self-check is internal-only: every emitted
`trip_id` ends in `_HHMM` so the `parseLiveStartMin` fallback always
works. Run locally:

```bash
pnpm build
pnpm smoke:trip-ids
```

CI runs the same step in `pr-validation.yml`.

## 9. Canonical publish lives in `n3ary/gtfs-publisher`

The orchestrator (`n3ary/gtfs-publisher`) is the canonical publisher of
this adapter's output to Cloudflare R2 (`neary-gtfs/feeds.json`). The
`neary` PWA reads from R2. The adapter exposes `ingestBuild()` and three
subpaths (`./ingest`, `./static`, `./rt`) — `ingestBuild()` is the only
runtime entry point; the other two are loaded by the orchestrator for
sqlite extension columns and GTFS-RT quirks respectively.

Downstream consumers (`neary`, anyone reading `feeds.json`) reach this
adapter's output exclusively through the orchestrator's R2 publish —
see `n3ary/gtfs-publisher`'s `daily.yml` for the cron.
