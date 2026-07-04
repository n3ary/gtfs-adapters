# gtfs-adapters

Per-feed GTFS adapters for the [n3ary](https://github.com/n3ary) family. Each adapter holds **all per-feed knowledge** for one city/feed — CSV format quirks, source reconciliation, color resolution, RT recovery.

The generic [n3ary/gtfs](https://github.com/n3ary/gtfs) repo stays **feed-agnostic** — its packages (`@n3ary/gtfs-spec`, the generic GTFS→SQLite converter, the generic RT proxy) have no per-feed knowledge.

## Why this repo exists

Before the split:

- The cluj RT quirk (`<route>_<dir>_<service>_<run>_<HHMM>` → `direction_id` / `start_time`) lived in `n3ary/gtfs/packages/gtfs-rt/src/quirks/cluj.ts`. That's per-feed knowledge in a supposedly-generic repo.
- The cluj color resolution lived in `n3ary/gtfs/packages/gtfs-static/src/lib/route-colors.ts`. Same issue.
- The cluj CSV format (5 metadata rows + `HH:MM` data) lived in `n3ary/cluj-napoca-gtfs-adapter/src/sources/ctp-csv/`. The Tranzy+Transitous reconciliation lived there too. Two sources of truth for "what Cluj is" with no way to find them from one place.

After the split:

- `n3ary/gtfs-adapters/adapters/cluj-napoca/` owns **all** per-feed knowledge for Cluj.
- `n3ary/gtfs` is a pure spec + generic converter repo, with no per-feed code.
- Adding Bucharest (or any future feed) is `adapters/bucharest/` with the same shape.

## Layout

```
gtfs-adapters/
├── pnpm-workspace.yaml
├── adapters/
│   └── cluj-napoca/           # @n3ary/gtfs-adapter-cluj-napoca
│       ├── src/
│       │   ├── static/        # route-color fixup + StaticExtension (per-feed sqlite extras)
│       │   ├── rt/            # RT quirks + runtime registration
│       │   ├── assemble/      # 3-source reconcile → GTFS zip
│       │   ├── sources/       # Tranzy + Transitous + CTP CSV fetchers
│       │   ├── lib/           # generic helpers (timing, stop-id, polyline)
│       │   └── cli.ts         # the daily CLI for cluj
│       └── tests/
│           ├── static/        # StaticExtension contract tests
│           ├── rt/            # RT quirk tests
│           └── ...
└── ...
```

Each adapter exports per-feed surfaces:

- **`static/`** — `clujStaticExtension(feedConfig): StaticExtension` for the generic `gtfs-static` pipeline; `route-colors.ts` for the algorithmic core; `applyClujStaticPostLoad(db, ctx)` for direct DB hooks. (See [gtfs-adapters#1](https://github.com/n3ary/gtfs-adapters/issues/1) — currently being split out of `n3ary/gtfs/packages/gtfs-static/`.)
- **`rt/`** — `registerRtQuirks(register)` hook for the generic proxy.
- **`assemble/` + `sources/`** — the cluj-specific reconcile-then-zip pipeline (runs as part of the cluj adapter's own daily cron, NOT consumed by `@n3ary/gtfs-static`).

The static-side `StaticExtension` is defined in `@gtfs/static/src/lib/extension.ts` and duplicated locally in the adapter (TS is structural). Long-term: lift into `@n3ary/gtfs-spec`.

## Why this repo exists

Before the split, the cluj adapter's per-feed knowledge (RT quirk, route-color fixup, `_neary_config`, network taxonomy) lived across three repos with no canonical source. After the split, `gtfs-adapters/adapters/cluj-napoca/` owns it all.

Tracks [n3ary/gtfs#67](https://github.com/n3ary/gtfs/issues/67). RT-side extraction is done (PR #2 in this repo). Static-side is landing via [#1](https://github.com/n3ary/gtfs-adapters/issues/1).

## Cross-references

- [n3ary/gtfs#67](https://github.com/n3ary/gtfs/issues/67) — the architecture refactor issue.
- [n3ary/gtfs](https://github.com/n3ary/gtfs) — the generic converter + spec.
- [n3ary/app](https://github.com/n3ary/app) — the consumer.
- [n3ary/branding](https://github.com/n3ary/branding) — the brand assets (logo, etc.).
- [@n3ary/gtfs-spec](https://github.com/n3ary/gtfs/tree/main/packages/spec) — the GTFS spec library (CSV readers, SQL DDL, row types).
