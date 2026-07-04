# Docs — `cluj-napoca-gtfs-adapter`

Reference material that informed the design of this adapter. Read these before
changing the reconciliation rules — they explain *why* the adapter does what it
does, not just *what* it does.

## Index

| File | What's in it |
|------|--------------|
| [`tranzy-contract.md`](./tranzy-contract.md) | Verified behavior of the [tranzy.ai](https://tranzy.ai) v1 opendata REST API: base URL, auth headers, every endpoint used, response shape quirks, pagination/quota, the agency IDs we know about. |
| [`csv-timetable-format.md`](./csv-timetable-format.md) | The CTP-published CSV timetable format scraped from `ctpcj.ro/orare/csv/orar_<route>_<service>.csv` — column layout, the `route_long_name` / `service_name` / `service_start` / `in_stop_name` / `out_stop_name` header rows, the post-midnight time-wrap fix, the WAF headers needed to bypass the `ctpcj.ro` challenge page. |
| [`assemble-rules.md`](./assemble-rules.md) | The single source of truth for "when source X and source Y disagree, who wins?" — covers `routes`, `stops`, `shapes`, `trips`, `stop_times`, `calendar`, `trip_headsign`, plus what to do with routes that have no CSV (M26, 2, M35) and directions the Transitous seed is missing (#13, #15 in `neary-gtfs`). |
| [`architecture.md`](./architecture.md) | End-to-end data flow: Transitous seed + Tranzy + CTP CSV → reconciliation → GTFS zip. Who calls what, where retries happen, what the orchestrator does. |
| [`known-limitations.md`](./known-limitations.md) | Things that are still faked or approximated: synthetic arrival/departure times (when CSV is missing), 90-day calendar window, headsign fallbacks, Tranzy 404s treated as empty. |
| [`fol-bus-trip-planner.md`](./fol-bus-trip-planner.md) | Notes on [`danielgavrila2/FOL-Bus-Trip-Planner`](https://github.com/danielgavrila2/FOL-Bus-Trip-Planner) — a sibling project that also consumes the Tranzy API, with insights on shape_id encoding, haversine stop-to-shape projection, and the `connected(X, Y, R)` predicate approach to route formalization. |

## Where these docs come from

- `tranzy-contract.md` was originally captured in the `SESSION_MEMORY.md` of
  the prior `ctp-gtfs-adapter` work (private handoff bundle, never published)
  and verified against the live Tranzy API and `danielgavrila2/FOL-Bus-Trip-Planner`'s
  `tranzy_service.py`.
- `csv-timetable-format.md` was reverse-engineered from the
  `feeds/cluj-napoca/build.js` parser that has been scraping `ctpcj.ro` daily
  since mid-2026.
- `assemble-rules.md` and `architecture.md` are first-draft — they will
  evolve as the assembly code lands and we get more empirical feedback
  on the produced zips.