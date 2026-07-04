# CTP CSV timetable format

> [!NOTE]
> Reverse-engineered from `feeds/cluj-napoca/build.js` (the parser that's been
> scraping `ctpcj.ro` daily since mid-2026). Captured 2026-06-29.

## URL pattern

```
https://ctpcj.ro/orare/csv/orar_<routeShortName>_<serviceKey>.csv
```

Substitutions:
- `<routeShortName>` — the CTP `route_short_name` (`"M26"`, `"35"`,
  `"45B"`, `"P"`, ...). URL-encoded if it contains non-ASCII (rare).
- `<serviceKey>` — one of `lv`, `s`, `d`, `ld`. Maps to GTFS `service_id`
  via `feeds/cluj-napoca/config.json`:
  ```json
  "serviceKeys": ["lv", "s", "d"],
  "serviceIdMap": { "lv": "LV", "s": "S", "d": "D" }
  ```
  (`ld` = "every day" isn't in the current key list; would need to be added
  if/when CTP starts publishing a unified "LD" CSV per route.)

### Not all routes × services exist

As of 2026-06-29 the routes without any CSV data are:
**M26, 2, M35** (Transpira school routes that only publish on certain
service days). The historical `39 CREIC` whole-line gap is fixed via
the [`canonicalShortName`](../src/sources/ctp-csv/shortname-aliases.js)
helper — Tranzy publishes the route as `39C` and Transitous as
`39 CREIC` (with space); both resolve to canonical `39CREIC` for the
CSV URL, on-disk filename, manifest entry, and route lookup. See
[`docs/quirks-and-rules.md`](./quirks-and-rules.md) § "Tranzy /trips
fallback for routes without CSV" for the history.

For these routes, Tranzy becomes especially important: we can synthesize
trips from Tranzy's `(route_id, direction_id)` pattern × the seed's
calendar (which is also weak), but we still won't have authoritative
departure times. See [`known-limitations.md`](./known-limitations.md).

## File layout

The file is **not** RFC 4180 CSV — it's a CTP-specific flat format with
metadata rows before the data table.

```csv
route_long_name,"Zorilor - Marasti"
service_name,"Luni - Vineri"
service_start,"01.06.2026"
in_stop_name,"Zorilor"
out_stop_name,"Marasti"
,05:15,06:00
,05:30,06:15
,05:45,06:30
...
```

### Rows

| Row index | Field(s) | Notes |
|---|---|---|
| 0 | `route_long_name` | The route's full name. Quoted, may contain commas. Used as a fallback for `trip_headsign` when the seed's headsign is empty. |
| 1 | `service_name` | Romanian human label for the service day: "Luni - Vineri" / "Sâmbătă" / "Duminică" / "Zilnic". Currently informational only — the `service_id` is derived from the URL key, not from this label. |
| 2 | `service_start` | The first day the service is valid, in `DD.MM.YYYY` format. Currently **not parsed** — we use the build date for the calendar window instead. |
| 3 | `in_stop_name` | The terminal stop for direction 1 (return direction). Quoted. |
| 4 | `out_stop_name` | The terminal stop for direction 0 (forward direction). Quoted. |
| 5+ | `,<HH:MM>,<HH:MM>` | Two columns: departures in direction 0, departures in direction 1. Empty cells mean "no departure for that direction at this row". The row is a "pair" only for layout — they're not linked. |

### Times are local

Times in the CSV are local Romanian time (Europe/Bucharest, EET/EEST). The
GTFS output uses `Europe/Bucharest` as the agency timezone — no UTC
conversion needed because we don't cross midnight to a different day. Post-
midnight times that belong to the *same* service day are written as
`25:30` / `26:45` (GTFS allows hours ≥ 24 for this exact case).

### Post-midnight wrap

A trip that departs at 23:55 and ends at 00:20 would show as `,23:55,00:20`
in the CSV, which looks like a 23h35m gap. The parser detects this and
re-writes the later time as `24:20`:

```js
function fixPostMidnight(times) {
  let prevMinutes = -1;
  for (let i = 0; i < times.length; i++) {
    const [h, m] = times[i].split(':').map(Number);
    const minutes = h * 60 + m;
    if (minutes < prevMinutes && prevMinutes > 20 * 60) {
      times[i] = `${h + 24}:${String(m).padStart(2, '0')}`;
    }
    const [effH, effM] = times[i].split(':').map(Number);
    prevMinutes = effH * 60 + effM;
  }
}
```

The `prevMinutes > 20 * 60` (20:00) guard prevents the wrap from triggering
when the operator genuinely has a backwards jump in the schedule (rare but
possible — early-morning routes with intentional ordering changes).

### Non-`HH:MM` cells (frequency / range annotations) — implemented in v0.1

**Source:** [`neary-gtfs#15`](https://github.com/ciotlosm/neary-gtfs/issues/15)

Some CSVs (notably M26's dir0 column) carry range or frequency annotations
instead of individual times:

```
05:05-22:40,05:23       ← col 0 = range "05:05 to 22:40"
10-20min,05:32          ← col 0 = headway "10–20 minutes"
05:41,05:50             ← col 0 = time, col 1 = time
```

The v0.1 parser classifies each cell into one of three categories:

| Cell pattern | Classification | Effect |
|---|---|---|
| `HH:MM` | time | Pushed to `departures.<dir>`. Becomes a regular trip. |
| `HH:MM-HH:MM` | range | Pushed to `frequencyAnnotations.<dir>.ranges`. Used by the frequencies reconciler to compute the operating window. |
| `Nmin` or `N-Mmin` | headway | Pushed to `frequencyAnnotations.<dir>.headways`. Used by the frequencies reconciler to compute the headway. |
| anything else | unknown | Logged as a warning; cell is dropped. |

**Concrete M26 LV example:**

```
05:05-22:40,05:23   →  dir0 range {05:05, 22:40},  dir1 time 05:23
10-20min,05:32      →  dir0 headway {min:600s, max:1200s, avg:900s},  dir1 time 05:32
05:41,05:50          →  dir0 time 05:41,  dir1 time 05:50
```

The frequencies reconciler derives (for dir0 LV): window `05:05–22:40`,
headway `900 s` (avg of 10–20 min), and emits:

```
frequencies.txt:
  M26_0_LV_FREQ_0505,05:05:00,22:40:00,900,0

trips.txt (anchor):
  M26,LV,M26_0_LV_FREQ_0505,Selimbar,0,92_0

stop_times.txt (anchor):
  M26_0_LV_FREQ_0505,05:05:00,05:05:00,D,0,0
  M26_0_LV_FREQ_0505,05:07:00,05:07:00,E,1,500
```

See `docs/known-limitations.md` §1 for the full fixed-state description
and the edge cases (only-headway / only-range / cross-midnight).

### Sanity checks

A real CSV always starts with the literal string `route_long_name,`. If the
fetched body doesn't, the parser treats it as a soft failure:

```js
if (!body.startsWith('route_long_name,')) {
  console.warn(`not CSV (got ${body.length}B starting "${body.slice(0,40)}…")`);
  return null;
}
```

This catches the two failure modes seen in production:
1. **WAF challenge page** — `ctpcj.ro` serves a captcha HTML when it
   suspects the client isn't a browser. The mandatory headers below
   prevent this; see [`csv-timetable-format.md` § WAF headers](#waf-headers).
2. **404 page** — when CTP removes a route's CSV, the server returns a
   proper 404 (handled upstream); but in some cases it returns 200 with
   HTML body.

## WAF headers

`ctpcj.ro`'s WAF treats the default Node `undici`/`fetch` headers as
suspicious. The current minimal-set that passes (tested 2026-06-29):

```js
{
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://ctpcj.ro/index.php/ro/orare-linii/linii-urbane',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
}
```

With these headers, requests return a clean `text/csv` body. Without them,
you get either:
- HTTP 415 (Unsupported Media Type), or
- HTTP 200 with an HTML challenge page that passes `response.ok` checks but
  fails the `startsWith('route_long_name,')` sanity check.

The `User-Agent` is the load-bearing one. The others are belt-and-braces;
they make the request look indistinguishable from a real browser navigating
from the timetable listing page.

### Polite concurrency

We cap concurrent CSV fetches at 4 via `Promise.all` chunking in
`fetchAll()` — beyond that `ctpcj.ro` starts responding slowly. The total
fan-out for all routes × services is roughly `60 routes × 3 services = 180
requests`; at 4-concurrent + ~150ms RTT that's ~7 seconds wall clock.

## Examples

### M26 (returns 404 currently)

```
GET https://ctpcj.ro/orare/csv/orar_M26_lv.csv
→ 404 Not Found
```

We log this and the route is added to `routesWithoutCsv` for the build log.

### 35 / LV (typical weekday)

```
route_long_name,"Piata Garii - Cart. Zorilor"
service_name,"Luni - Vineri"
service_start,"01.06.2026"
in_stop_name,"Cart. Zorilor"
out_stop_name,"Piata Garii"
,05:30,05:50
,06:00,06:20
,06:30,06:50
...
```

After parsing, `parsed.departures.dir0 = ["05:30", "06:00", "06:30", ...]`
and `parsed.departures.dir1 = ["05:50", "06:20", "06:50", ...]`.

## What we'd want from CTP

- A single combined endpoint per route that returns LV/S/D/LD in one CSV.
  Saves two round-trips per route.
- A `route_short_name` field in the CSV (instead of inferring from the URL
  filename) so renames don't break the parser.
- ISO 8601 dates in `service_start` so we don't have to parse `DD.MM.YYYY`.
- The WAF removed entirely — there's no good reason for `ctpcj.ro` to
  challenge a programmatic client fetching a public timetable.