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
│       │   ├── static/        # 3-source reconcile → GTFS zip
│       │   ├── rt/            # RT quirks + runtime registration
│       │   ├── shared/        # color resolution, networks, _neary_config
│       │   └── index.ts
│       └── ...
└── ...
```

Each adapter exports two surfaces:

- **`static.ts`** — produces the GTFS `.zip` (output of the static pipeline).
- **`rt.ts`** — registers per-feed RT quirks with the generic proxy.

The `static` side runs as part of the data publishing pipeline. The `rt` side deploys as a per-adapter Hetzner service (or as a plugin loaded by the generic `gtfs-rt` proxy at startup).

## Cross-references

- [n3ary/gtfs#67](https://github.com/n3ary/gtfs/issues/67) — the architecture refactor issue.
- [n3ary/gtfs](https://github.com/n3ary/gtfs) — the generic converter + spec.
- [n3ary/app](https://github.com/n3ary/app) — the consumer.
- [n3ary/branding](https://github.com/n3ary/branding) — the brand assets (logo, etc.).
- [@n3ary/gtfs-spec](https://github.com/n3ary/gtfs/tree/main/packages/spec) — the GTFS spec library (CSV readers, SQL DDL, row types).
