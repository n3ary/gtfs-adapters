# Tranzy.ai v1 opendata — verified contract

> [!NOTE]
> Captured from the `ctp-gtfs-adapter` project (private handoff) and
> cross-checked against
> [`danielgavrila2/FOL-Bus-Trip-Planner/src/backend/services/tranzy_service.py`](https://github.com/danielgavrila2/FOL-Bus-Trip-Planner)
> on 2026-06-29.

## Base URL

```
https://api.tranzy.ai/v1/opendata
```

No path versioning beyond `/v1/`. No documented public staging environment —
don't point the adapter at anything else for production.

## Auth (both headers required)

| Header | Value | Notes |
|---|---|---|
| `X-API-KEY` | `<key>` | Sign up at https://tranzy.dev/accounts. Free tier exists. |
| `X-AGENCY-ID` | `<int as string>` | Scopes every request to a single agency. |

Without either header the API returns 401. With a valid key but the wrong
agency id, endpoints that the agency hasn't opted into return **404** rather
than 403 — see "Quirks" below.

Recommended User-Agent: `cluj-napoca-gtfs-adapter/0.1 (+https://github.com/ciotlosm/cluj-napoca-gtfs-adapter)`.
Tranzy doesn't reject unknown UAs but a self-identifying one is polite and
helps debugging if you ever need to talk to them.

## Agency IDs we know about

| ID | Operator | Notes |
|---|---|---|
| `2` | CTP Cluj-Napoca (Compania de Transport Public Cluj-Napoca) | Default for this adapter. |
| `4` | Iași (COTAGA / S.C. Compania de Transport Public Iași) | Per the ctp-gtfs-adapter memory; unverified live. |
| `6` | Constanța (CTU Constanța) | Per the ctp-gtfs-adapter memory; unverified live. |
| `8` | Chișinău (RTEC Chișinău) | Per the ctp-gtfs-adapter memory; unverified live. |

If you intend to ship multi-agency, verify the ID against
`GET /agencies` (which returns `[{agency_id, agency_name, ...}]`) before
hard-coding. The numbers above are from the prior adapter's notes, not a
live probe.

## Endpoints we use

| Method + path | Returns |
|---|---|
| `GET /agencies` | `[{agency_id, agency_name, agency_url, agency_timezone, agency_lang, agency_phone}]` |
| `GET /routes` | `[{route_id, agency_id, route_short_name, route_long_name, route_type, route_desc, route_color, route_text_color}]` |
| `GET /stops` | `[{stop_id, stop_name, stop_desc, stop_lat, stop_lon, location_type, stop_code}]` |
| `GET /trips` | `[{trip_id, route_id, direction_id, trip_headsign, block_id, shape_id, wheelchair_accessible, bikes_allowed}]` |
| `GET /stop_times` | `[{trip_id, stop_id, stop_sequence}]` — **no `arrival_time` / `departure_time`** |
| `GET /shapes` | `[{shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence, shape_dist_traveled}]` |
| `GET /calendar` | Usually 404 — Tranzy doesn't expose a service calendar for most agencies. Treated as empty list. |
| `GET /vehicles?route_id=<int>` | `[{id, plate, route, trip, lat, lon, bearing, speed, ...}]` — used only by the realtime bridge from issue `neary#108`, not by this static adapter. |

### Pagination

None observed. Responses for Cluj-Napoca fit comfortably in one page
(~70 routes, ~700 stops, ~1000 trips, ~30k stop_times, ~50k shape points).
The client does **not** loop, retry on partial pages, or accept cursor params.

If Tranzy ever paginates, the client will silently truncate — at that point
add a `page`/`per_page` query loop to `_request()` and gate it behind a config
flag so the tests don't need real network.

### Quota

The Go upstream at `conexiuni-cluj` tracks daily quota separately for
`/vehicles` vs everything else. We don't track quota; we throttle via
`TRANZY_RATE_LIMIT_MS` (default `500ms`). Tranzy's free tier is generous
enough that throttling alone is fine.

If you start hitting 429s, raise the throttle to 750–1000ms before adding a
quota counter — a quota counter would need to be shared across replicas via
a sidecar or Redis, which is overkill for one operator's static feed.

## Quirks worth knowing

### 1. `404` ≠ "endpoint doesn't exist"

For agencies that haven't published a particular dataset, Tranzy returns
**404** rather than an empty array. The client's `fetchAll()` downgrades 404s
to `[]` (so a partial build can proceed), and `_request()` also treats 404
as empty when called directly.

The ctp-gtfs-adapter Python client made this explicit in `fetch_all()`:

> [!TIP]
> *"Failures on optional endpoints (calendar / stop_times) are downgraded to
> empty lists so a single missing endpoint doesn't kill the build."*
> — the original Python `ctp-gtfs-adapter` `fetch_all()` docstring. Same
> behavior in the Node port (`src/sources/tranzy/index.js`).

Same behavior in the Node port (`src/sources/tranzy/index.js`).

### 2. `/stop_times` has no times

`/stop_times` only carries `(trip_id, stop_id, stop_sequence)`. There is no
`arrival_time` or `departure_time` field. To produce a usable schedule you
need either:

- The Transitous seed's `stop_times.txt` (canonical, may be stale), or
- The CTP CSV timetables scraped from `ctpcj.ro` (fresh, but only per-route
  per service-day), or
- A time-distance projection using `shape_dist_traveled` (synthetic — fine
  for visualization, not authoritative).

See [`assemble-rules.md`](./assemble-rules.md) for how we
combine these three sources.

### 3. `shape_id` encodes `<route>_<direction>`

`extract_direction_from_shape_id("35_0")` → `("35", "0")`.
`extract_direction_from_shape_id("M26_1")` → `("M26", "1")`.

This is **how Tranzy organizes shapes per direction**, not per trip. The
`trips[].shape_id` field is stable across all trips on the same (route,
direction). This means we can group trips by `shape_id` and treat the shape
as the route's "pattern" for that direction — same idea as FOL's
`route_patterns: Dict[(route_id, direction), List[stop_id]]`.

The split logic is "split on the **last** underscore" so that route short
names containing underscores (rare but possible — e.g. `M_26` would split as
`("M", "26")`) are handled correctly.

### 4. `wheelchair_accessible` and `bikes_allowed` are sometimes `null`

Not always `0`/`1`. The ctp-gtfs-adapter's `test_trips_rows_normalize_wheelchair_null`
test pins this — the builder normalizes `null` to the empty string so it
matches GTFS spec without crashing.

### 5. `stop_code` is sometimes a Roman numeral

CTP's `stop_code` field (the public-facing code shown on signage) is
sometimes a Roman numeral ("II", "IV") rather than a digit. Don't parse it
as `Number()` — it will silently produce `NaN`. Use it as an opaque string.

### 6. `route_color` carries almost no per-route signal

Verified live against `/routes` for CTP Cluj on 2026-06-30 (all 168 rows):

| `route_type` | What Tranzy returns |
|---|---|
| 0 (tram, 4 routes) | `#f3513c` × 4 |
| 3 (bus, 148 routes) | `#000` × 74, `#f3513c` × 68, plus 6 one-offs (`#693cf3`, `#ff0000`, `#fc002e`, `#002fff`, `#0d00ff`, `#1f807b`) |
| 11 (trolleybus, 16 routes) | `#f3513c` × 9, `#000` × 4, `#1500ff`, `#0048ff`, `#000000` |

Takeaways:

- Tranzy does **not** publish a per-mode palette. Trams and buses share
  `#f3513c` (the modal color across both), and ~80 routes ship as black
  with no obvious distinguishing meaning.
- `route_color` is sometimes the 3-char CSS shorthand (`#000`) the GTFS
  spec doesn't permit; sometimes the full 6-char form (`#000000`); often
  the leading `#` is present (also non-spec). Treat all of those as
  equivalent and normalize to 6-char uppercase, no `#` (see
  `normalizeColor()` in `src/assemble/merge/routes.js`).
- Black (`#000` / `#000000`) is effectively Tranzy's "no preferred color"
  sentinel — there's no signage rationale behind it. The adapter treats
  it as missing and substitutes the per-type modal color. Non-black
  one-offs are preserved as-is.
- The per-type modals collide: all three modes (tram, bus, trolleybus)
  have `#f3513c` as their most-frequent non-placeholder color, so a
  naive substitution would publish a single-color feed with no visual
  way to tell modes apart. The adapter resolves the collision at
  publish time by **OKLCh hue rotation** (see
  [`assemble-rules.md`](./assemble-rules.md) — `route_color` row):
  the type with the most routes at the colliding color keeps it; each
  remaining colliding type is rotated by `i·360°/N` around the OKLCh
  wheel, then nudged in ±15° increments if needed to stay at least
  0.15 OKLab away from every existing one-off color (and from the
  other assigned modals). With current Tranzy data this yields
  bus = `#F3513C`, trolleybus = `#00B147` (green), tram = `#248EFF`
  (blue) — three perceptually distinct hues at the same perceived
  lightness, none within 0.15 OKLab of any one-off color in the
  catalog.

### 7. `route_text_color` is always `null`

Verified live against `/routes` for CTP Cluj on 2026-06-30: every one of
168 routes returns `route_text_color: null`. The field is in the response
shape but Tranzy doesn't populate it for this agency. The GTFS consumer
default (`000000`) would produce black-on-black plates for the ~80 routes
with dark `route_color`, so the adapter ignores the upstream value
entirely and forces `FFFFFF` (white) for every row — see
[`assemble-rules.md`](./assemble-rules.md).

## Rate-limit / retry behavior of the Node client

| Server response | Client behavior |
|---|---|
| 200, 2xx | Return parsed JSON. |
| 401, 403 | Throw `TranzyAuthError` immediately, no retry. |
| 404 | Return `[]` (treat as empty list). |
| 429 | Back off `2^attempt * 1000ms` (capped at 16s), retry up to `maxRetries`. Then `TranzyRateLimitError`. |
| 5xx | Same backoff and retry as 429, then `TranzyError`. |
| Network error / `AbortError` (timeout) | Back off `2^(attempt-1) * 1000ms` (capped at 8s), retry up to `maxRetries`. Then `TranzyError`. |
| Other 4xx | Throw `TranzyError` immediately, no retry. |

Throttling between calls is `TRANZY_RATE_LIMIT_MS` (default 500ms), enforced
via an in-process "last-request timestamp" — *not* a queue — so concurrent
calls from the same process can race past it. Fine for our usage (we call
endpoints sequentially in `fetchAll()`); revisit if you ever parallelize.

## What we deliberately don't use from Tranzy

- `GET /vehicles` — realtime. Out of scope for this static adapter; belongs
  to the realtime bridge repo described in `neary#108`.
- `route_text_color` — always `null` for CTP Cluj (see Quirk 7); the
  adapter ignores it and emits a uniform `FFFFFF` instead.
- Tranzy's `route_color` value when it equals `#000` / `#000000` — see
  Quirk 6; treated as a "no preferred color" sentinel and substituted
  with the per-type modal color.
- `agency_url`, `agency_phone`, etc. — passed through but not consulted.

## What we'd want from a future Tranzy

- `/calendar` returning real service-calendar data so we don't have to
  synthesize it from CSV service-day keys.
- A `last_updated` field per endpoint so we can know when to skip a refetch
  in CI.
- A single endpoint that returns the entire agency feed as one
  JSON-of-JSONs (cheaper than six round-trips).