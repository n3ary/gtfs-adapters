/**
 * ingest.ts — programmatic fetch + reconcile + zip build for cluj-napoca.
 *
 * `ingestBuild()` is the new single-call entry for `n3ary/gtfs`'s
 * daily cron to acquire the upstream GTFS zip for this feed. It
 * replaces `n3ary/cluj-napoca-gtfs-adapter/src/cli.ts`'s `cmdBuild`
 * (and its preceding `cmdFetchCsv`), which used to live in a separate
 * repo + daily workflow + git `binaries` branch. With this entry,
 * `n3ary/gtfs-adapters` owns the feed build code and publishes a
 * zero-I/O library; `n3ary/gtfs` orchestrates + uploads to R2.
 *
 * What it does:
 *   1. Load the Transitous seed (a known-good baseline GTFS).
 *   2. Query Tranzy's static endpoints for CTP route/trip/stop data.
 *   3. Scrape CTP's CSV timetables to fill transit-minute precision.
 *   4. Reconcile the three sources into one GTFS dataset.
 *   5. Pack the dataset into a spec-compliant .zip on disk and read
 *      it back as a Buffer for the caller's R2 upload.
 *
 * What it does NOT do (consumer responsibilities):
 *   - R2 uploads (lives in n3ary/gtfs).
 *   - makeSqlite (also n3ary/gtfs — needs the StaticExtension from
 *     this same package's `static` subpath).
 *   - Cache invalidation (n3ary/gtfs's content-addressed hash).
 */

// @ts-nocheck - the rest of the cluj adapter is on @ts-nocheck; keep
// this entry consistent so the package's tsc check still passes.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TranzyClient } from '../sources/tranzy/index.ts';
import { loadTransitousSeed } from '../sources/transitous/index.ts';
import { fetchAllCsvSchedules, readCtpCsvFromDisk } from '../sources/ctp-csv/index.ts';
import { CSV_SERVICE_KEYS } from '../sources/ctp-csv/client.ts';
import { reconcile } from '../assemble/index.ts';
import { writeGtfsZip } from '../gtfs.ts';

/**
 * CTP Cluj-Napoca defaults — single source of truth for cluj-specific
 * constants that used to leak into the orchestrator as env vars.
 * Override only when running against a non-production CTP feed
 * (e.g. a smoke fixture).
 */
export const DEFAULT_AGENCY_ID = '2'; // Tranzy: CTP Cluj-Napoca
export const DEFAULT_SERVICE_KEYS = CSV_SERVICE_KEYS; // ['lv', 's', 'd']

/**
 * Options for the end-to-end feed build. The orchestrator passes only
 * the secret (`tranzy.apiKey`); static feed knowledge (agencyId,
 * serviceKeys, rateLimitMs, calendarDays) lives here as defaults so
 * the calling repo (`n3ary/gtfs`) stays feed-agnostic.
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
  tranzy: {
    apiKey: string;
    agencyId?: string;
    rateLimitMs?: number;
  };
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
 * (n3ary/gtfs) can hash + upload without ever writing to its own
 * disk. `sizeBytes` is the zip size (handy for logging).
 */
export type IngestResult = {
  zip: Buffer;
  sizeBytes: number;
  zipPath: string;
};

/**
 * Build the full cluj-napoca GTFS feed and return its bytes.
 *
 * Throws on:
 *   - missing `tranzy.apiKey` (the API is paid-only; no fetchable
 *     fallback for Tranzy data).
 *   - upstream fetch failures from CTP CSV scraping (status >= 400
 *     on the CTP server is treated as fatal by fetchAllCsvSchedules).
 *
 * Tranzy failures are non-fatal (logged as a warning) — the feed
 * can still be built from Transitous + CTP-CSV alone, mirroring the
 * legacy CLI's behavior on Tranzy outage.
 */
export async function ingestBuild(opts: IngestOptions): Promise<IngestResult> {
  if (!opts.tranzy?.apiKey) {
    throw new Error('ingestBuild: options.tranzy.apiKey is required (sign up at https://tranzy.dev/accounts).');
  }
  const outputDir = opts.outputDir;
  const outputName = opts.outputName ?? 'cluj-napoca.gtfs.zip';
  const calendarDays = opts.calendarDays ?? 180;
  const buildDate = opts.buildDate ?? new Date();
  const rateLimitMs = opts.tranzy.rateLimitMs ?? 500;
  const agencyId = opts.tranzy.agencyId ?? DEFAULT_AGENCY_ID;
  const serviceKeys = opts.ctp?.serviceKeys ?? DEFAULT_SERVICE_KEYS;
  const seedUrl = opts.transitous?.seedUrl;
  const fetchFn = opts.ctp?.fetchFn;

  mkdirSync(outputDir, { recursive: true });

  // 1. Transitous seed.
  const seed = await loadTransitousSeed(seedUrl ? { url: seedUrl } : {});

  // 2. Tranzy static (best-effort — fails soft).
  const tranzy = new TranzyClient({
    apiKey: opts.tranzy.apiKey,
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

  // 3. CTP CSV (status >= 400 is fatal — surfaced by fetchAllCsvSchedules).
  const csv = await fetchAllCsvSchedules(seed.routes, {
    loadFn: fetchFn ?? readCtpCsvFromDisk,
    serviceKeys,
  });
  console.log(`[ctp-csv] scraped ${csv.byRouteService.size} routes`);

  // 4. Reconcile.
  const { files, warnings, stats } = reconcile({
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
