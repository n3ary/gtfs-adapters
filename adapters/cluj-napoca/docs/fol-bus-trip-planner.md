# `danielgavrila2/FOL-Bus-Trip-Planner` — notes

> [!NOTE]
> Reference project: <https://github.com/danielgavrila2/FOL-Bus-Trip-Planner>
> Captured 2026-06-29 from a fresh look at the public repo.

## What it is

An academic AI-Lab project: a trip planner for CTP Cluj-Napoca that uses
First-Order Logic (FOL) with **Prover9** (theorem prover) and **Mace4**
(model finder) to formally verify that a planned route is correct.

```
React (Leaflet map) → FastAPI (Python) → Tranzy API + Prover9/Mace4
```

The FOL formalization treats routes as `connected(X, Y, R)` predicates
and uses `step(N, X)` / `succ(N, M)` to model path traversal. The
interesting bit isn't the FOL — it's the upstream graph construction,
which is also where we can learn from FOL's approach.

## What we learn from it

### 1. Confirms Tranzy's shape_id encoding

FOL's `extract_direction_from_shape_id` splits on the **last** underscore:

```python
parts = shape_id.split('_')
return '_'.join(parts[:-1]), parts[-1]
# "35_0"  -> ("35", "0")
# "M26_1" -> ("M26", "1")
# "M_26_0" -> ("M_26", "0")  # route short names with underscores
```

This matches what we expect from the SESSION_MEMORY notes. Adopt the same
split rule — *"last underscore is the direction"* — so route short names
that contain underscores don't get mis-split.

### 2. Stops-along-shape via distance threshold

FOL projects stops onto shapes by finding the closest shape point within
a 20m threshold:

```python
for point in shape_points:
    distance = haversine_distance(stop, point)
    if distance < min_distance:
        min_distance = distance
        closest_sequence = point["shape_pt_sequence"]

if min_distance <= threshold_meters:    # 20 m default
    stops_on_route.append({"stop_id": ..., "sequence": closest_sequence, ...})

stops_on_route.sort(key=lambda x: x["sequence"])
```

We already have `cumulativeShapeDistances()` from
`neary-gtfs/src/pipeline/lib/polyline.js` (vendored to
`src/lib/polyline.js`) which does **better** — it projects onto the
closest **segment** (not just closest point) using the perpendicular
distance, with a 200m threshold and graceful haversine fallback. But FOL
confirms that 20–200m is the right order of magnitude for "stop belongs
to this shape". Keep our 200m threshold as is.

### 3. graph_builder is rich but specialized

FOL's `GraphBuilder` builds a *routing graph* (`stop_neighbors:
Dict[stop_id, List[{to, route, route_name}]]`) for pathfinding. This
isn't directly reusable for our static-feed generation — we don't need
a routing graph, we need a per-pattern stop sequence — but it's good
reference for how to turn the Tranzy `(stop_id, sequence)` tuples into
something a planner can consume.

### 4. TranzyService is a thin wrapper — nothing we don't already know

Their `tranzy_service.py` is a 90-line wrapper around the same six
endpoints (`/stops`, `/routes`, `/trips`, `/stop_times`, `/shapes`)
with the same auth headers. Their patterns:

```python
headers = {
    "Accept": "application/json",
    "X-API-KEY": api_key,
    "X-Agency-Id": agency_id,
}
```

Note: they write `X-Agency-Id` (hyphenated), our adapter writes
`X-AGENCY-ID` (uppercase). Both work — Tranzy's auth is case-insensitive
on header names — but worth aligning if we ever share code. Adopt FOL's
`X-Agency-Id` style in the adapter to match what most Tranzy clients use.

Actually, the original Python adapter from the ctp-gtfs-adapter handoff
also uses `X-AGENCY-ID`. We're consistent with our own upstream. Skip
the rename.

### 5. FOL's `pattern` field naming: `"35_0"` (route_id + direction)

FOL's API returns:

```json
{
  "route_id": "35",
  "route_name": "35",
  "direction": 0,
  "pattern": "35_0",
  "shape": [{"lat": ..., "lon": ..., "seq": 1}],
  "stops": [{"id": "...", "name": "Piata Garii", ...}]
}
```

The `pattern` field is the concatenation `<route_short_name>_<direction>`.
This is **a separate layer** on top of Tranzy's data — FOL built it.
But it suggests that for the Tranzy side, `<route_short_name>_<direction>`
is a natural shape_id, which matches our `<route>_<dir>` understanding.

### 6. Ticketing logic worth knowing about

FOL includes a `ticketing_service.py` — for Cluj-Napoca, a single ticket
is valid 45 minutes and a second ticket is needed for any transfer beyond
that window. Not relevant to the GTFS adapter (which is schedule-only,
not fare), but interesting context for trip planners built on top of the
feed.

### 7. Asset screenshots are useful sanity references

`/assets/View_Route2.png`, `View_Route.png`, `plan_trip1.png`, etc.
show actual route geometries, stop names, and trip plans. Useful as
"what the rendered feed should look like" reference when validating our
output.

## What FOL does NOT do (and where we add value)

- **No Transitous integration.** FOL uses Tranzy directly. They get
  Tranzy's quirks (no arrival_time, no calendar) and have to work around
  them. We fix this by adding Transitous seed + CTP CSV.
- **No reconciliation.** FOL builds a graph from Tranzy alone. Our
  adapter merges three sources.
- **No GTFS Schedule output.** FOL's purpose is pathfinding, not feed
  generation. They could consume our output.
- **No CI/automation.** FOL is a student project — no scheduled refresh,
  no GitHub Actions. Our adapter has a daily cron.

## What we'd propose to FOL (if collaboration made sense)

Not now. FOL is an academic project with a different goal. If Marius
ever wants to publish the FOL route-planner as a downstream consumer of
this adapter, the swap would be:

1. Replace `TranzyService` with a fetcher for `cluj-napoca.gtfs.zip`
   from GitHub raw.
2. Replace `GraphBuilder` with a consumer of `shapes.txt`, `trips.txt`,
   `stop_times.txt`.
3. Keep `PathFinder` + `FolEngine` + `Prover9/Mace4` as-is.

The reduction in FOL's transitive dependency surface (no more Tranzy
client, no more live API, just static feed → offline graph) would make
their demo more reproducible. Worth proposing after this adapter is
stable.