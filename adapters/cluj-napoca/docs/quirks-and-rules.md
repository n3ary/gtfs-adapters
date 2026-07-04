# Quirks and rules

This document captures the **non-obvious** behaviors of the
`cluj-napoca-gtfs-adapter` reconciler — the things you'd only know if
you read every warning text and cross-referenced against CTP's
upstream catalog. Read this before changing warning text, classify
logic, or the failure thresholds in `scripts/fetch-stage.js`.

For the per-field priority order (which source wins for which GTFS
field) see [`assemble-rules.md`](./assemble-rules.md).
For the data-quality data-loss categories see
[`known-limitations.md`](./known-limitations.md).

## Table of contents

- [404s: expected weekend gap vs whole-line gap](#404s-expected-weekend-gap-vs-whole-line-gap)
- [`*`/`**` CSV annotations](#csv-annotations-and-suspension-markers)
- [Origin label matching: exact / fuzzy / no-match](#origin-label-matching-exact--fuzzy--no-match)
- [Stale `route_desc` vs `route_long_name`](#stale-route_desc-vs-route_long_name-tranzy-publishes-contradictory-terminals)
- [Frequency annotations and anchor trips](#frequency-annotations-and-anchor-trips)
- [Tranzy /trips fallback for routes without CSV](#tranzy-trips-fallback-for-routes-without-csv)
- [Suspension markers (`Nu circula` etc.)](#suspension-markers-nu-circula-etc)
- [GTFS specification quirks](#gtfs-specification-quirks)
- [Build log severity tiers](#build-log-severity-tiers)

---

## 404s: expected weekend gap vs whole-line gap

CTP returns 404 from `https://ctpcj.ro/orare/csv/orar_<route>_<service>.csv`
in two distinct situations:

1. **Expected weekend gap** — the route exists and runs on weekdays,
   but does not run on weekends (or only runs LV). CTP's CSV
   endpoint correctly returns 404 because there's no schedule to
   publish. Cross-referenced against CTP's HTML pages (route 22:
   *"Sâmbăta: Nu circulă. Duminica: Nu circulă."*). This is
   **NOT a build failure** — the adapter correctly skips the
   route×service combo and emits trips for the days that do work.

2. **Whole-line gap** — the route is listed on CTP's website but
   has zero CSVs published for any service day (no recent example —
   the historical `39 CREIC` case is fixed via the
   [`canonicalShortName`](../src/sources/ctp-csv/shortname-aliases.js)
   helper, which collapses Tranzy's `39C` and Transitous's `39 CREIC`
   to the same canonical `39CREIC` for the CSV URL).
   This **IS a build failure** — the operator hasn't published any
   authoritative schedule data, and the Tranzy fallback (see below)
   is the only data we have.

The smoke script distinguishes the two by cross-referencing each
route's 404s against its own successful CSV fetches:

- Route has ≥1 successful CSV → 404s are weekend/service-day gaps
  (reported as `Expected (route has weekday CSV — 404 is weekend/no-service)`)
- Route has 0 successful CSVs → 404s are whole-line gaps
  (reported as `⚠ WHOLE-LINE gaps (no CSV at all for this route)`,
   fails build with exit code 3 unless
   `SMOKE_ALLOW_WHOLE_LINE_404S=1`)

Current state (2026-06-29): 18 expected 404s (weekday-only routes
missing weekend CSV), 0 whole-line gaps (the historical `39 CREIC`
case is fixed via [`canonicalShortName`](../src/sources/ctp-csv/shortname-aliases.js):
`39C` → `39CREIC`).

---

## CSV annotations and suspension markers

CTP's CSV timetable cells carry single-character annotations whose
meaning is **per-line** — documented on each line's HTML legend page
(verified examples for M23 and M39):

| Marker | M23 meaning | M39 meaning |
|---|---|---|
| `*` (leading or trailing) | Shared run with M81/M22 (bus doesn't stop at terminal) | Extends past terminus to Sânmartin |
| `**` (double trailing) | (not used in M23) | Skips the Cluj Due neighborhood |

**Adapter behavior**: the marker is stripped, the time is kept,
the trip is emitted. The annotation is surfaced in the build log via
`CtpCsvSchedule.annotations[]` so the operator can see what
happened. The trip_id format is unchanged.

**GTFS implication**: since the operator's published timetable
includes the trip, we include it in our GTFS even though the
operating vehicle is registered under a different `route_id`. Live
GPS won't match (the bus is an M81, not an M23) — consumers see
"scheduled time, no live GPS" which is the correct UX.

**Suspension markers** (`Nu circula`, `In lucru`, `Suspendat`,
`Suspended`, `Nu functioneaza`, `Nu merge`) are classified as
`{type: 'suspended', reason}` and produce **zero trips** for that
service day. Routes where every cell is suspended get the
`suspendedAllCells` flag.

---

## Origin label matching: exact / fuzzy / no-match (with pattern traversal)

CTP's CSV carries two terminal-name labels in its metadata header
(rows 3 and 4):

- `in_stop_name` = origin of col 0 buses = first stop of dir 0
  pattern
- `out_stop_name` = origin of col 1 buses = first stop of dir 1
  pattern
- (The other terminal is the destination of that direction and is
  used as the headsign.)

The adapter validates these against the catalog pattern's stops
using `findLabelInPattern()` + `terminalNamesMatch()` in
`src/assemble/emit/trips.js`:

1. **Pattern traversal** — search every stop in the pattern (not just
   position 0). CTP sometimes publishes an origin that's mid-pattern
   (M24: catalog dir 0 starts at "Disp. Bucium" but the CSV says col
   0 origin is "Calea Floresti" further along the route).
2. **Exact match** — diacritic-insensitive case-insensitive equality
   after normalization (`ă/â→a, î→i, ș→s, ț→t`).
3. **Word-token overlap** — split both names on word boundaries
   (spaces, hyphens, parens, punctuation). Accept when EITHER:
   - ≥2 shared tokens of length ≥4, OR
   - ≥1 shared token of length ≥6.

   The stricter "≥2 OR ≥6" rule (vs the older "≥1 of length ≥4")
   prevents false positives on common transit prefixes like "Disp."
   (4 chars, abbreviation for "Dispecerat" = depot). Without it,
   "Disp. Grigorescu" would falsely match "Disp. IRA" because both
   share "disp" — but those are different physical depots.

Reported as a 5-tier build-log classification:

| Tier | When | Action |
|---|---|---|
| `exact-both` | both CSV terminals match somewhere in their respective patterns (any position, exact) | silent |
| `exact-one` | one exact, one fuzzy/no-match | info, trust column convention |
| `fuzzy-both` | both fuzzy matches found | info, trust column convention |
| `fuzzy-one` | one fuzzy, one no-match | info, trust column convention |
| `swap-exact-both` | cross-direction (col 0 ↔ dir 1, col 1 ↔ dir 0) both exact | info, direction_id unchanged (RT feed alignment) |
| `swap-fuzzy-both` | cross-direction both fuzzy | info, direction_id unchanged |
| `swap-partial` | one cross-pair exact/fuzzy, other doesn't match anywhere | warn, asymmetric — operator likely renamed one terminal |
| `no-match` | neither same-direction nor cross-direction matches anywhere in any pattern | warn with categorized sub-type |

### No-match sub-types (operator-actionable categorization)

When the no-match tier fires, the warning carries one of three
sub-types so the operator/Tranzy knows where to act:

| Sub-type | When | Operator action |
|---|---|---|
| `csv-placeholder` | A CSV label looks like a generic term — either it appears as a substring of the CSV's own `route_long_name` (likely a placeholder) or it has no real stop-name tokens (e.g. "Cluj-Napoca", "M") | Fix the CSV |
| `catalog-out-of-date` | CSV terminals look like real stops (no placeholder) but neither catalog pattern contains them | Ask Tranzy to update the stops for this route |
| `no-match-asymmetric` | Catalog patterns for the two directions have different first stops AND neither is a placeholder | Ask Tranzy to realign the catalog |

Live data examples (2026-06-30):

| Route | Sub-type | Diagnosis |
|---|---|---|
| 30 | (swap-exact-both → asymmetric) | Catalog patterns have 4 distinct terminal names; CSV describes a Disp. Grigorescu ↔ Disp. IRA corridor the catalog doesn't connect. Operator: ask Tranzy to realign the route's two patterns. |
| M26 | `csv-placeholder` | `in_stop_name = "Cluj-Napoca"` is a city name, not a stop (matches CSV's own `route_long_name` substring). Operator: fix the CSV. |
| 29S | `catalog-out-of-date` | `in_stop_name = "Sf.Ioan"` and `out_stop_name = "Pod Traian"` are real stops but neither is in the seed's patterns for this route. Operator: ask Tranzy to add these stops. |
| 46 | `swap-partial` | col 1 ("Giratie Drum Faget") fuzzy-matches dir 0 first stop; col 0 ("Opera") doesn't match anything. Asymmetric catalog. |

### Why the warn-but-proceed strategy

Trip direction is determined by **CSV column index** (col 0 = dir 0,
col 1 = dir 1), not by the CSV header labels. So an origin-mismatch
does NOT mean trips are going to the wrong direction — it means we
can't trust the CSV's terminal name as a headsign fallback. We
keep using catalog `direction_id` so the schedule stays aligned
with the Tranzy RT feed (which uses Tranzy's catalog mapping).
**We never flip `direction_id`** even when swap is detected — see
the [route_long_name rewrite](#route-long_name-rewrite-from-csv)
section below for the alternative use of swap detection.

### `route_long_name` rewrite from CSV in/out

**Rule** (Marius's design, 2026-06-30): `route_long_name` is the
CSV's `in/out_stop_name` pair, in catalog direction order, whenever
the CSV provides both labels. The CSV is the operator's authoritative
source for terminal labels — Tranzy/Transitous's catalog field is
often stale or uses depot-relative origins ("Disp. X") that confuse
riders. CSV labels reflect what CTP publishes in their timetable
headers.

**Direction order**: CTP's column convention (col 0 = origin of
col 0 buses = dir 0; col 1 = origin of col 1 buses = dir 1) UNLESS
a swap is detected (CSV col 0 actually matches catalog dir 1's
first stop, not dir 0's). Tranzy's direction_id mapping is
authoritative — dir 0 vs dir 1 stays Tranzy's contract for downstream
consumers (including the GTFS-RT feed, which keys on Tranzy's ids).

**No tier filter** — fires whenever BOTH `in_stop_name` and
`out_stop_name` are present, regardless of whether the catalog has a
matching pattern. For routes where neither Tranzy's nor Transitous's
pattern contains the CSV terminals (e.g. route 19, route 42 — both
catalogs use a different corridor than the CSV), the CSV is the only
authoritative source and the swap-detection falls back to "no swap"
(the CTP convention). The symmetry guard (`patternsShareEndpoint()`)
was removed — CSV priority means trusting the operator's labels even
when the catalog has 4 distinct terminal names (the route 30 case).

**Rewrite order** in the orchestrator:

1. CSV in/out (priority)
2. Stop sequence — `${first stop} - ${last stop}` of the longest
   trip (when CSV is unavailable or this code path is taken after
   the CSV rewrite)
3. Tranzy's value (cleaned) — last resort

**Concrete examples** from the live build (with the new rule
applied):

| route_short_name | Tranzy's `route_long_name` | CSV `in/out_stop_name` | After rewrite |
| --- | --- | --- | --- |
| 19 | Disp. Grigorescu - P-ta M. Viteazul Sud | Pod Traian / E. Quinet Sud | Pod Traian - E. Quinet Sud |
| 42 | Disp. Grigorescu - Dacia Service | Pod Traian / Biserica Campului | Pod Traian - Biserica Campului |
| 30 | Cart. Grigorescu - Str. Aurel Vlaicu | Disp. Grigorescu / Disp. IRA | Disp. IRA - Disp. Grigorescu (swap detected) |

For routes 19 and 42, Tranzy's catalog has a different corridor than
the CSV — neither Tranzy's dir 0/1 patterns contain the CSV
terminals. Old tier-based filter would have skipped the rewrite
(`tier = no-match`); new rule fires and uses the CSV labels, which
match what CTP actually publishes on their website.

For route 30, CSV col 0 ("Disp. Grigorescu") matches Tranzy dir 1's
first stop ("EXPO Transilvania") — swap detected. CSV labels are
used in reversed order to match the catalog's dir 0 → dir 1
convention. Note that Tranzy's dir 1 first stop is actually
"EXPO Transilvania", not "Disp. Grigorescu" — the fuzzy match here
works because Tranzy's dir 1 *also* ends at a depot whose name
contains "Grigorescu" (or similar — see the swap-detection INFO line
for the exact match). Operator review recommended for routes where
the CSV terminals are depot names ("Disp. X") because the published
`route_long_name` will surface those depot names to consumers
instead of passenger stops.

Build log emits one INFO line per rewrite pass:

```
routes: 106 route_long_name(s) rewritten from CSV in/out (catalog was stale — pattern traversal found a clean resolution, CSV terminals are more accurate).
```

A high rewrite count is normal when the catalog's `route_long_name`
is stale; operators should consider asking Tranzy/Transitous to
realign their catalog.

**Fuzzy-match summary**: the build emits a single INFO line counting
how many `(route, dir)` pairs used fuzzy (not exact) matching:

```
origin validation: 52 (route, dir) pair(s) used fuzzy word-token matching to align catalog ↔ CSV origin labels
```

A high count means the upstream sources use different naming
conventions for the same stops — operators should consider asking
CTP / Transitous / Tranzy to align.

---

## Stale `route_desc` vs `route_long_name` (Tranzy publishes contradictory terminals)

Live Tranzy data has ~50 routes where `route_desc` carries a
**different terminal pair** than `route_long_name` — typically because
the line was restructured and only one of the two fields got updated.
Concrete example (route 23 in the published feed):

```
route_long_name: "P-ta M. Viteazul - C.U.G"
route_desc:      "P-ta M. Viteazul - EMERSON"
```

`EMERSON` is a real stop in Cluj's network (route 52L, 36L, etc.
visit it), but **route 23 does not**. Tranzy's catalog and CTP's CSV
both agree the line goes to `C.U.G` — only the desc is stale.

The earlier `descHasUniqueInfo` heuristic in `applyRouteCategory`
saw `cleanedDesc != cleanedLong` and preserved the desc as "unique
info" — surfacing contradictory terminals to consumers.

### Fix: structural validation against the route's actual pattern

The strongest possible check is structural: does the desc's terminal
actually appear on this route's pattern? If it does, the operator
intentionally references that stop (maybe as a service variant /
historical headsign) — keep the desc. If it doesn't, the desc is
stale — drop it.

```js
// src/assemble/merge/routeCategory.js
function isStaleLongNameVariant(cleanedDesc, cleanedLong, routeStopNames) {
  if (!cleanedDesc || !cleanedLong) return false;
  if (!cleanedDesc.includes(' - ') || !cleanedLong.includes(' - ')) return false;
  if (/[()]/.test(cleanedDesc)) return false;
  // First terminal must fuzzy-match (handles "P-ta M. Viteazul" vs
  // "P-ta M. Viteazul Vest") — otherwise the desc is a different
  // route entirely, not a stale variant.
  const [descFirst, descSecond] = cleanedDesc.split(' - ');
  const longFirst = cleanedLong.split(' - ')[0];
  if (!tokenOverlap(descFirst, longFirst)) return false;
  // Structural: does the desc's destination appear on this route?
  if (!routeStopNames) return true; // no data → fall back to stale (safer default)
  for (const stopName of routeStopNames) {
    if (tokenOverlap(descSecond, stopName)) return false;
  }
  return true;
}
```

`routeStopNames` is computed by `getRouteStopNames()` which picks the
route's longest trip and returns its `stop_name` set. Same heuristic
as `deriveLongNameFromStops()`.

### Live trace impact

48 routes in the real Tranzy feed (2026-06-30) have stale descs:

| Route | `route_long_name` | `route_desc` (stale) |
|---|---|---|
| 23 | `P-ta M. Viteazul - C.U.G` | `P-ta M. Viteazul - EMERSON` |
| 21 | `P-ta M. Viteazul Vest - Dacia Service` | `P-ta M. Viteazul - Cart. Buna Ziua` |
| 101 | `Disp. Bucium - P-ta Garii Noi` | `Str. Bucium - P-ta Garii` |
| 22 | `P-ta Garii Sud - Sp. de Boli Infectioase` | `P-ta Garii - Str. I. Moldovan` |
| ... | (45 more, all "X - Y" descs where Y isn't on the route) | |

After this fix, these descs become empty. The structural check
correctly preserves descs whose terminal DOES appear on the route
(e.g. route 88A's parenthetical annotation, route D51's
just-a-code long_name).

### Why a structural check rather than format-only matching

Earlier heuristics (format-only, fuzzy first-terminal match) would
drop **legitimate** descs whose terminal is on the route but
spelled differently — e.g. a route with long_name `"P-ta M. Viteazul
Vest - Dacia Service"` and a desc `"P-ta M. Viteazul Vest - Dacia"`
(no "Service" suffix) — the structural check sees "Dacia" on the
route pattern → keeps the desc. The format-only check would have
flagged the destination-mismatch and dropped it.

---

## Frequency annotations and anchor trips

CTP's CSV cells aren't always `HH:MM` — some are frequency
annotations:

- `HH:MM-HH:MM` — service runs in this window
- `N-Mmin` — headway range (e.g. `10-20min` = bus every 10-20 min)
- `Nmin` — fixed headway (e.g. `5min`)
- `*` markers (see above)

The adapter handles these in `src/assemble/derive/frequencies.js`:

1. Pick the **first** window as the operating range (e.g.
   `05:05-22:40`)
2. Pick the headway as the **average** of the range (e.g. `15min`
   for `10-20min`)
3. Emit a **frequency anchor** trip in `trips.txt` with
   `trip_id=<route>_<dir>_<serviceId>_FREQ_<HHMM>` and one
   `stop_times.txt` row (anchor stop)
4. Emit a `frequencies.txt` row with `start_time`, `end_time`,
   `headway_secs`, `exact_times=0` (frequency-based, not exact)

**GTFS exact_times=0** is the canonical "service operates with
the given frequency, not exact timetabled times" — see
[GTFS spec](https://gtfs.org/schedule/reference/#frequenciestxt).

The build log emits one INFO line per frequency anchor (the success
path):

```
[INFO ] frequency anchor: M26 dir=0 LV 05:05-22:40 every 15min (avg)
```

This is **NOT a data-loss signal** — the anchor trip and
`frequencies.txt` row ARE the data. Don't be alarmed by these
warnings; they're confirmation that M26's complex schedule parsed
correctly.

If the CSV has frequency annotations but no explicit window/headway,
the adapter falls back to defaults (`05:00-23:00`, `600s = 10min`),
also surfaced as INFO.

The WARN-tier signal `frequency anchor skipped: ... — no pattern`
means we couldn't emit the anchor (no pattern available) — that's
a real data loss.

---

## Tranzy /trips fallback for routes without CSV

For routes with **no CTP CSV coverage** (new metropolitan lines CTP
hasn't published yet — TE1-TE14, 40S, 87B, M26U, 101A, 30U, etc.),
the adapter pulls trips directly from Tranzy's `/trips` and
`/stop_times` endpoints via `src/assemble/emit/tranzy-fallback.js`.

Historical note: `39 CREIC` used to be a whole-line gap until we
discovered Tranzy publishes its `route_short_name` as the truncated
`39C` while CTP publishes the CSV at `orar_39CREIC_lv.csv`. The
[`canonicalShortName`](../src/sources/ctp-csv/shortname-aliases.js)
helper handles this — `39C` → `39CREIC` (and the Transitous-side
`39 CREIC` collapses to the same canonical name). Every CSV-IO path
funnels through this one function so the URL, on-disk filename,
manifest entry, and route lookup all use `39CREIC`.

Constraints:

- **Tranzy doesn't publish `arrival_time` or `departure_time`** —
  we emit empty arrival/departure + `timepoint='0'` per GTFS spec
  (when `timepoint=0`, times MUST be empty).
- **Tranzy doesn't publish `service_id`** — we default to all three
  (`LV`, `S`, `D`). Over-scheduling is better than under-scheduling:
  the "does this route run at all" question is independent of
  which days it runs.
- **Trip_id format** for fallback trips: `${routeId}_${dir}_${serviceId}_NT${idx}`
  — the `NT` (no-time) sentinel signals to downstream parsers like
  `neary`'s `parseLiveStartMin` that there's no real start time to
  extract. Don't try to parse HHMM from these.
- **Stops filtered** to those in the reconciled `stops.txt` (drop
  orphans if Tranzy references a stop that didn't make it through).

Build-log line:

```
[INFO ] routes: 61 routes using Tranzy /trips fallback (no CSV coverage — times empty, timepoint=0, 312 trips emitted, service_ids=LV+S+D)
```

---

## Suspension markers (`Nu circula` etc.)

See [CSV annotations and suspension markers](#csv-annotations-and-suspension-markers)
above. The pattern is treated as a known skip — no trips generated,
no warning emitted for that service day (the marker IS the signal
that zero trips is correct).

Routes where **every** non-empty cell is suspended get the
`suspendedAllCells` flag, used by `reconcileTripsAndStopTimes` to
skip the route×service combo entirely without emitting
"No pattern" or "0 trips" warnings.

---

## GTFS specification quirks

The adapter makes several choices that deviate from "naive" GTFS
output. These are documented in `assemble-rules.md` but called
out here for quick reference:

- **`timepoint='0'` on every `stop_times.txt` row** — our
  arrival/departure times come from `computeStopTimes()` projecting
  the CSV origin time across the pattern. They're interpolated, not
  authoritative per-stop times. GTFS spec says `timepoint=0` is the
  canonical signal for "times are approximate".
- **`stop_sequence` preserved from upstream** — we never re-number.
  Re-numbering would discard any non-contiguous numbering the
  operator uses (gaps for dwell-only stops, odd-numbered extras).
- **`trip_id` format** is `${routeId}_${dir}_${serviceId}_${HHMM}`
  for CSV-derived trips, with `FREQ_<HHMM>` suffix for frequency
  anchors and `NT<idx>` suffix for Tranzy-fallback trips. The HHMM
  tail is the only structural requirement (downstream consumers like
  `neary`'s `parseLiveStartMin` rely on it).
- **`feed_info.txt`** identifies us as `cluj-napoca-gtfs-adapter`,
  not as CTP or Transitous. We do not impersonate upstream sources.

---

## Build log severity tiers

The build CLI classifies every reconcile warning into one of three
severity tiers (`src/lib/log-severity.js`):

| Tier | Visual | Meaning |
|---|---|---|
| **INFO** | `[INFO ]` (green) | We guessed data successfully (fuzzy match, Tranzy fallback, frequency anchor, route merge). NOT a failure. |
| **WARN** | `[WARN ]` (yellow) | We lost data or couldn't verify (no pattern, missing CSV, origin mismatch, frequency anchor skipped, color mismatch). Build proceeds; operator should review. |
| **ERROR** | `[ERROR]` (red) | Real failures. Currently unused in the reconciler output (errors exit the build before this layer). |

**Heuristic classification** (substring pattern match on warning text).
Defaults to `WARN` (safe side — "we don't know what we don't know").

INFO patterns:
- Tranzy /trips fallback success
- Tranzy primary catalog stats
- Transitous-only shapes/stops (gap fills)
- Origin exact-both / fuzzy-matched / fuzzy-one / exact-one / partial match
- Frequency anchor success (`frequency anchor: ...`)
- Frequency default fallback (`no (range|headway), using default`)

WARN patterns:
- Real data-loss: no usable pattern / No pattern for / no CSV / CSV missing / 0 trips
- Strong mismatches: DO NOT MATCH / DO NOT match / no-match / cannot be trusted
- Catalog gaps: CSV fetch returned 404 / not found
- Frequency anchor SKIPPED
- Dropping N departures

Build CLI renders each tier in its own collapsible GH Actions
section (`::group::INFO:` / `::group::WARN:`), and the final summary
line counts per tier:

```
::group::INFO: 9 reconcile note(s) — data resolved successfully
  [INFO ] routes: Tranzy primary catalog — ...
::endgroup::
::group::WARN: 2 data-loss signal(s) — review before merging
  [WARN ] routes: 13 distinct non-default color bucket(s) — ...
::endgroup::

  11 total — 9 info, 2 warn, 0 error
```

## Smoke test exit codes

| Code | Meaning |
|---|---|
| 0 | OK — no unrecognized cells, no infra misses, no whole-line 404s |
| 1 | Unrecognized cells in CSV (extend `classifyCell()`) |
| 2 | Infra miss (WAF / HTTP / network). Opt-out: `SMOKE_ALLOW_INFRA_FAILURES=1` |
| 3 | Whole-line 404 gap (route has zero CSV coverage). Opt-out: `SMOKE_ALLOW_WHOLE_LINE_404S=1` |