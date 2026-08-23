/**
 * ingest.ts — programmatic fetch for the Helsinki adapter.
 *
 * `ingestBuild(opts)` is the single-call entry the orchestrator
 * uses to acquire the upstream GTFS zip for an adapter-driven
 * feed. The orchestrator calls `${publisher}/ingest`'s
 * default export (always named `ingestBuild`) with no
 * feed-specific knowledge — every piece of static config lives
 * in this module's defaults; secrets come through `opts.secrets`
 * keyed by env var name (the feed config declares which ones it
 * needs).
 *
 * The Helsinki adapter is intentionally SIMPLER than the cluj
 * one: HSL publishes a complete, daily-regenerated GTFS zip
 * at a stable URL. There is no need to reconcile a baseline
 * seed (Transitous) with a primary upstream (Tranzy) plus
 * operator CSVs — HSL IS the canonical source, with the
 * quality of feed you'd expect from a national operator. We
 * just fetch the zip and return it.
 *
 * HSL does NOT require an API key (it's public open data with
 * attribution), so the adapter's `REQUIRED_SECRETS` is empty
 * and the feed config's `secrets[]` is `[]`. This is the
 * simplest possible ingest — no auth, no rate limit, no
 * reconciliation.
 *
 * What it does NOT do (consumer responsibilities):
 *   - R2 uploads (lives in the orchestrator).
 *   - makeSqlite (orchestrator — needs the StaticExtension
 *     from this same package's `static` subpath).
 *   - Cache invalidation (orchestrator's content-addressed
 *     hash).
 *   - Verify the zip contents (orchestrator / static pipeline
 *     catches malformed GTFS via the SQL load errors).
 */

import { Buffer } from 'node:buffer';

/**
 * Canonical HSL GTFS feed URL. HSL regenerates this daily; the
 * upstream `Last-Modified` header is the cache-key signal used
 * by the orchestrator. Per
 * https://www.hsl.fi/en/hsl/open-data, "Data from HSL's
 * public transport register is parsed into GTFS format
 * daily."
 *
 * Override via `opts.gtfsUrl` in tests; production runs use
 * the default.
 */
export const DEFAULT_GTFS_URL =
  'https://gtfs.hsl.fi/gtfs.zip';

/**
 * Env var names this adapter expects. Empty for Helsinki —
 * HSL's open data is public. We declare it explicitly (rather
 * than omitting) so the orchestrator's feed config validator
 * has the same shape for every adapter.
 */
export const REQUIRED_SECRETS: ReadonlyArray<string> = [];

/**
 * Adapter-level defaults — single source of truth for feed-
 * specific constants that used to leak into the orchestrator.
 * Helsinki has no rate limit, no auth, and a stable URL.
 */
export const DEFAULT_AGENCY_ID = 'HSL';
export const DEFAULT_CALENDAR_DAYS = 60;

/**
 * Options for the end-to-end feed build. The orchestrator
 * passes only `outputDir`, `buildDate`, and `secrets`; all
 * feed-specific static config lives in this module as
 * defaults.
 *
 * `outputDir` is the staging directory the adapter writes the
 * intermediate build artifacts into (.build-input/hsl-gtfs.zip).
 * The caller chooses where — typically a workflow-scoped tmp
 * dir; left behind for log/debug.
 *
 * `buildDate` lets tests pin the clock; omit in production.
 *
 * `secrets` is a map of env-var-name → value; the adapter looks
 * up each name in `REQUIRED_SECRETS` and throws if any is
 * missing. For Helsinki, `REQUIRED_SECRETS` is empty, so any
 * secrets object (including `{}`) is fine.
 */
export type IngestOptions = {
  outputDir: string;
  outputName?: string;
  secrets: Record<string, string | undefined>;
  gtfsUrl?: string;
  fetchFn?: (url: string) => Promise<ArrayBuffer>;
  calendarDays?: number;
  buildDate?: Date;
};

/**
 * Result of a successful build. Returned as a Buffer so the
 * caller (orchestrator) can hash + upload without ever writing
 * to its own disk. `sizeBytes` is the zip size (handy for
 * logging).
 */
export type IngestResult = {
  zip: Buffer;
  sizeBytes: number;
  zipPath: string;
};

/**
 * Build the Helsinki GTFS feed and return its bytes.
 *
 * Throws on:
 *   - HTTP failure fetching the upstream zip (status >= 400).
 *   - Empty response body.
 *
 * The fetch is a single HTTP GET — no auth, no rate limit, no
 * retries. The orchestrator owns retries. We don't verify the
 * zip contents here; the static pipeline catches malformed
 * GTFS via the SQL load errors, and a fetch-verify round-trip
 * would add a zip-reader dependency for marginal value.
 */
export async function ingestBuild(opts: IngestOptions): Promise<IngestResult> {
  for (const name of REQUIRED_SECRETS) {
    if (!opts.secrets?.[name]) {
      throw new Error(
        `ingestBuild: opts.secrets.${name} is required (the feed config must declare "${name}" in its secrets[] list).`,
      );
    }
  }
  const gtfsUrl = opts.gtfsUrl ?? DEFAULT_GTFS_URL;
  const outputName = opts.outputName ?? 'helsinki.gtfs.zip';
  const fetchFn = opts.fetchFn ?? defaultFetch;

  const ab = await fetchFn(gtfsUrl);
  const buffer = Buffer.from(ab);
  if (buffer.length === 0) {
    throw new Error(`ingestBuild: empty response from ${gtfsUrl}`);
  }

  return {
    zip: buffer,
    sizeBytes: buffer.length,
    zipPath: outputName,
  };
}

/** Default fetch: a single GET, no auth, no retries, no
 *  rate-limit. The orchestrator owns retries. */
async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url, {
    headers: {
      'user-agent': 'n3ary/gtfs-adapter-helsinki',
      accept: 'application/zip, application/octet-stream, */*',
    },
  });
  if (!resp.ok) {
    throw new Error(
      `ingestBuild: HTTP ${resp.status} ${resp.statusText} fetching ${url}`,
    );
  }
  return await resp.arrayBuffer();
}
