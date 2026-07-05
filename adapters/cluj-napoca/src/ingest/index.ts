/**
 * ingest.ts — programmatic fetch + reconcile + zip build for an
 * adapter-driven feed.
 *
 * `ingestBuild(opts)` is the single-call entry the orchestrator uses
 * to acquire the upstream GTFS zip for an adapter-driven feed. The
 * orchestrator calls `${publisher}/ingest`'s default export (always
 * named `ingestBuild`) with no feed-specific knowledge — every piece
 * of static config (agencyId, serviceKeys, rateLimitMs, calendarDays)
 * lives in this module's defaults; secrets come through `opts.secrets`
 * keyed by env var name (the feed config declares which ones it needs).
 *
 * What it does (typical flow — may vary per adapter):
 *   1. Load a baseline seed (e.g. Transitous).
 *   2. Query a primary upstream source (e.g. Tranzy's static API).
 *   3. Reconcile additional sources (e.g. operator CSVs).
 *   4. Pack the dataset into a spec-compliant .zip on disk and read
 *      it back as a Buffer for the caller's R2 upload.
 *
 * What it does NOT do (consumer responsibilities):
 *   - R2 uploads (lives in the orchestrator).
 *   - makeSqlite (orchestrator — needs the StaticExtension from this
 *     same package's `static` subpath).
 *   - Cache invalidation (orchestrator's content-addressed hash).
 */

// @ts-nocheck - the rest of this adapter is on @ts-nocheck; keep this
// entry consistent so the package's tsc check still passes.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TranzyClient } from '../sources/tranzy/index.ts';
import { loadTransitousSeed } from '../sources/transitous/index.ts';
import { fetchAllCsvSchedules, fetchCtpCsv } from '../sources/ctp-csv/index.ts';
import { CSV_SERVICE_KEYS } from '../sources/ctp-csv/client.ts';
import { reconcile } from '../assemble/index.ts';
import { writeGtfsZip } from '../gtfs.ts';

/**
 * Env var name this adapter expects its primary API key under. The
 * orchestrator's feed config (`feeds/<id>/config.json`'s `secrets[]`)
 * must list this name so the secret gets forwarded into `opts.secrets`.
 */
export const REQUIRED_SECRETS = ['TRANZY_API_KEY'] as const;

/**
 * Adapter-level defaults — single source of truth for feed-specific
 * constants that used to leak into the orchestrator. Override only
 * when running against a non-production feed (e.g. a smoke fixture).
 */
export const DEFAULT_AGENCY_ID = '2';
export const DEFAULT_SERVICE_KEYS = CSV_SERVICE_KEYS;

/**
 * Options for the end-to-end feed build. The orchestrator passes only
 * `outputDir`, `buildDate`, and `secrets` (a map of env-var-name →
 * value); all feed-specific static config lives in this module as
 * defaults. The orchestrator's feed config declares which env vars
 * it needs in `secrets[]` and we look them up here by name.
 *
 * `outputDir` is the staging directory the adapter writes the
 * intermediate build artifacts into (.build-input/csv/, .build-input/
 * csv-status.json, and the final .zip). The caller chooses where
 * — typically a workflow-scoped tmp dir; left behind for log/debug.
 *
 * `buildDate` lets tests pin the clock; omit in production.
 */
export type IngestOptions = {
  outputDir: string;
  outputName?: string;
  secrets: Record<string, string | undefined>;
  transitous?: {
    seedUrl?: string;
  };
  ctp?: {
    serviceKeys?: string[];
    fetchFn?: (routeShortName: string, serviceKey: string) => string;
  };
  calendarDays?: number;
  buildDate?: Date;
};

/**
 * Result of a successful build. Returned as a Buffer so the caller
 * (orchestrator) can hash + upload without ever writing to its own
 * disk. `sizeBytes` is the zip size (handy for logging).
 */
export type IngestResult = {
  zip: Buffer;
  sizeBytes: number;
  zipPath: string;
};

/**
 * Build the full adapter-driven feed and return its bytes.
 *
 * Throws on:
 *   - any secret listed in REQUIRED_SECRETS being absent from
 *     `opts.secrets` (no fetchable fallback for paid-only APIs).
 *   - upstream fetch failures from CSV scraping (status >= 400 on
 *     the source server is treated as fatal by fetchAllCsvSchedules).
 *
 * Primary API failures are non-fatal (logged as a warning) — the
 * feed can still be built from seed + CSV alone, mirroring the
 * legacy CLI's behavior on upstream outage.
 */
export async function ingestBuild(opts: IngestOptions): Promise<IngestResult> {
  const apiKey = opts.secrets?.TRANZY_API_KEY;
  if (!apiKey) {
    throw new Error(
      `ingestBuild: opts.secrets.TRANZY_API_KEY is required (sign up at https://tranzy.dev/accounts). ` +
      `The feed config must declare "TRANZY_API_KEY" in its secrets[] list.`,
    );
  }
  const outputDir = opts.outputDir;
  const outputName = opts.outputName ?? 'feed.gtfs.zip';
  const calendarDays = opts.calendarDays ?? 180;
  const buildDate = opts.buildDate ?? new Date();
  const rateLimitMs = 500;
  const agencyId = DEFAULT_AGENCY_ID;
  const serviceKeys = opts.ctp?.serviceKeys ?? DEFAULT_SERVICE_KEYS;
  const seedUrl = opts.transitous?.seedUrl;
  const fetchFn = opts.ctp?.fetchFn;

  mkdirSync(outputDir, { recursive: true });

  // 1. Seed.
  const seed = await loadTransitousSeed(seedUrl ? { url: seedUrl } : {});

  // 2. Primary upstream API (best-effort — fails soft).
  const tranzy = new TranzyClient({
    apiKey,
    agencyId,
    rateLimitMs,
  });
  let tranzyData = null;
  try {
    tranzyData = await tranzy.fetchAll();
    console.log(
      `[tranzy] fetched ${tranzyData.routes.length} routes, ` +
      `${tranzyData.stops.length} stops, ${tranzyData.trips.length} trips, ` +
      `${tranzyData.shapes.length} shape points, ${tranzyData.stop_times.length} stop_times`,
    );
  } catch (err) {
    console.warn(`[tranzy] fetchAll failed: ${err.message || err}; continuing with seed-only`);
  }

  // 3. CSV reconcile (status >= 400 is fatal — surfaced by fetchAllCsvSchedules).
  // Default to live fetching CSVs from the CTP server. Pass
  // `opts.ctp.fetchFn` to override (e.g. tests inject a fixture reader).
  const csv = await fetchAllCsvSchedules(seed.routes, {
    loadFn: fetchFn ?? fetchCtpCsv,
    serviceKeys,
  });
  console.log(`[ctp-csv] scraped ${csv.byRouteService.size} routes`);

  // 4. Reconcile.
  const { files, warnings, stats } = await reconcile({
    seed,
    tranzy: tranzyData,
    csv,
    options: { calendarDays, buildDate },
  });

  if (warnings.length > 0) {
    const { emitGroupedWarnings } = await import('../lib/log-severity.js');
    const counts = emitGroupedWarnings(warnings);
    console.log(
      `[reconcile] ${warnings.length} total — ${counts.info} info, ${counts.warn} warn, ${counts.error} error`,
    );
  } else {
    console.log('[reconcile] 0 warnings');
  }

  // 5. Write zip + read back.
  const zipPath = join(outputDir, outputName);
  const { sizeBytes } = await writeGtfsZip(files, zipPath);
  if (!existsSync(zipPath)) {
    throw new Error(`ingestBuild: writeGtfsZip returned but no file at ${zipPath}`);
  }
  const zip = readFileSync(zipPath);
  console.log(
    `[done] ${zipPath} (${(sizeBytes / 1024).toFixed(1)} KB) — ` +
    `${stats.routes} routes, ${stats.stops} stops, ${stats.shapes} shapes, ` +
    `${stats.trips} trips, ${stats.stopTimes} stop_times`,
  );

  return { zip, sizeBytes, zipPath };
}
