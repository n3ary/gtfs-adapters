# cluj-napoca-gtfs-adapter

Reconciled GTFS Schedule publisher for Cluj-Napoca (CTP) — combines three
independent data sources into the most complete, error-free feed possible.

> [!NOTE]
> Built to retire `neary-gtfs/feeds/cluj-napoca/build.js` once stable.
> The daily published zip at `output/cluj-napoca.gtfs.zip` is what
> `neary-gtfs` will eventually proxy.

## What it does

Pulls data from three independent sources and reconciles them:

| Source | Strong on | Used for |
|---|---|---|
| **Transitous** (`api.transitous.org`) | Curated, mdb-validated structure | Primary route/stop/shape definitions |
| **Tranzy.ai** (`api.tranzy.ai`) | Live-updated static data, per-direction shapes | Fills gaps when Transitous is missing directions (`neary-gtfs#13`, `#15`) |
| **CTP CSV timetables** (`ctpcj.ro/orare/csv/`) | Authoritative departure times | Per-route, per-service-day schedules |

…and writes a standards-compliant `cluj-napoca.gtfs.zip` ready for any
GTFS consumer.

See [`docs/assemble-rules.md`](./docs/assemble-rules.md) for
the full priority table.

## Quick start

```bash
git clone https://github.com/ciotlosm/cluj-napoca-gtfs-adapter.git
cd cluj-napoca-gtfs-adapter
npm install

# Sign up at https://tranzy.dev/accounts and put the key in .env
cp .env.example .env
$EDITOR .env

# Build the feed
npm run build

# Validate the produced zip
npm run validate

# Or just dry-run the reconciliation (no zip written)
npm run reconcile:dry
```

Output goes to `output/cluj-napoca.gtfs.zip`.

## Stack

- **Node 24+** ESM (matching `neary-gtfs`)
- Zero runtime dependencies except `archiver` (zip writer)
- Vitest for tests
- Vendored shared libs from `neary-gtfs` (seed.js, timing.js, csv.js, polyline.js) — same code, attribution headers preserved

## Project layout

```
src/
├── cli.js              # entry point: build / validate / reconcile
├── gtfs.js             # zip writer + minimal zip-name peek for validate
├── lib/                # vendored pure helpers
│   ├── seed.js
│   ├── timing.js
│   ├── csv.js
│   └── polyline.js
├── sources/
│   ├── transitous.js   # seed fetcher + pattern extraction
│   ├── tranzy.js       # Node port of the ctp-gtfs-adapter's Python client
│   └── ctp-csv.js      # ctpcj.ro scraper + parser
└── reconcile/
    ├── index.js        # orchestrator
    ├── routes.js
    ├── stops.js
    ├── shapes.js
    ├── patterns.js     # seed → Tranzy fallback per (route, dir)
    ├── trips.js        # CSV × patterns → trips.txt + stop_times.txt
    ├── calendar.js
    └── data-quality.js # warnings for #14, #15, M26, M26N, etc.

tests/                  # vitest, fixtures are canned (no network)
docs/                   # reference material — see docs/README.md
```

## Why a separate repo?

CTP's three data sources each have a missing piece: Transitous is
sometimes weeks stale, Tranzy has no `arrival_time`, CTP doesn't publish
CSVs for ~63 of ~300 routes. Combining them in a single repo lets us:

- Hold the Tranzy API key in one place (GitHub Actions repo secret),
  no leakage to `neary-gtfs` or `neary` (per `neary#108`, `neary-gtfs#16`).
- React to upstream changes in any single source without breaking the
  consumer (`neary-gtfs`).
- Eventually submit the reconciled feed to MobilityDatabase /
  Transitland so other apps benefit from the same freshness.

## Known limitations

See [`docs/known-limitations.md`](./docs/known-limitations.md) for the
full list. The big ones:

- Calendar is synthesized from the CSV keys we actually scraped; not
  aligned with CTP's published service calendar.
- `cluj-rt-feed.gtfs.ro` GTFS-RT trip-ID parity is a contract, not
  verified automatically — if the upstream RT feed changes format, our
  JOINs break silently.
- Routes without a CSV *and* without a Transitous or Tranzy pattern
  emit zero trips. See [`docs/known-limitations.md` §2](./docs/known-limitations.md#2-routes-without-csv-data-fall-back-to-the-potentially-stale-seed)
  for the taxonomy (school transport, suspended, event routes, etc.).

## Documentation conventions

All `*.md` files in this repo follow
[GitHub's alerts standard](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#alerts)
for callouts — **not** plain blockquotes. Use the right type for the
semantics:

| Alert | When to use |
|---|---|
| `> [!NOTE]` | Informational context — source attributions, background facts, doc purpose. |
| `> [!IMPORTANT]` | Crucial information the reader must not skip — invariants, contract details. |
| `> [!WARNING]` | Critical content demanding immediate attention — risky behavior, data loss scenarios. |
| `> [!TIP]` | Useful advice, alternative approaches, helpful quotes from other code/docs. |
| `> [!CAUTION]` | Negative potential consequences of an action — "if you do X, Y will break". |

A multi-line alert looks like this:

```markdown
> [!IMPORTANT]
> **This is a contract.** Don't change this without coordinating
> with the realtime bridge repo.
```

Plain `>` blockquotes are reserved for actual quoted material (e.g.
a verbatim citation from another project's code or docs).

## Deployment

GitHub Actions cron at `30 0 * * *` UTC publishes the daily zip to the
`binaries` branch, served directly from GitHub raw:

```
https://raw.githubusercontent.com/ciotlosm/cluj-napoca-gtfs-adapter/binaries/cluj-napoca.gtfs.zip
```

Requires a `TRANZY_API_KEY` repo secret. Optional: `RT_PARITY_URL`
repo variable to enable the GTFS-RT trip-ID parity check
(`scripts/smoke-rt-parity.js`). See
[`.github/workflows/daily.yml`](./.github/workflows/daily.yml).

## Contributing

`main` is protected — every change goes through a PR. See
[docs/standards/version-management.md](docs/standards/version-management.md)
for the bump-on-PR rule. PRs trigger
[`.github/workflows/pr-validation.yml`](.github/workflows/pr-validation.yml),
which bumps `package.json#version` on the PR branch and runs validate +
test + reconcile:dry. The daily workflow (above) handles publish.

Branch protection on `main`:
- PR required, 0 approvals (solo-dev friendly)
- Linear history (squash/rebase only)
- No force-push, no branch deletion
- **Require branches to be up to date** (so the version sequencing can't race)

### CI smoke tests

| Step | What it does | Fails the build when |
|---|---|---|
| `npm test` | Vitest unit + reconciliation tests with canned fixtures | any test fails |
| `npm run fetch:csv` | Scrapes every CTP CSV (full network), parses each through the production parser | any cell is unrecognized (i.e. the `#15` fix needs extending) |
| `npm run smoke:trip-ids` | Self-check on `trips.txt` from our built zip: every trip_id ends in `_HHMM` (so `neary`'s `parseLiveStartMin` fallback can extract the start time) | accidental format regression in `makeTripId()` |

## License

MIT — see [LICENSE](./LICENSE). Schedule data © CTP Cluj-Napoca;
this software is a personal transit data tool, not affiliated with CTP.
## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — free for individuals, hobbyists, education, research, and charitable organizations. Any commercial use (paid products, paid services, or hosted services for revenue) needs a separate license from the author. See the LICENSE file for the full terms.
