#!/usr/bin/env node
// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * cluj-napoca-gtfs-adapter CLI.
 *
 * Subcommands:
 *   build           full pipeline → output/<name>.gtfs.zip
 *                   Reads CSVs from .build-input/csv/ populated by a
 *                   prior smoke run. NEVER fetches upstream. Errors
 *                   out if the smoke manifest is missing.
 *   validate [path] inspect an existing zip
 *   reconcile       dry-run: print what would be built, don't write.
 *                   Fetches CSVs upstream — useful for dev / one-off
 *                   checks without running smoke first.
 *
 * Env (see .env.example for full list):
 *   TRANZY_API_KEY        required
 *   TRANZY_AGENCY_ID      default 2 (CTP Cluj-Napoca)
 *   TRANSITOUS_SEED_URL   override for tests
 *   GTFS_OUTPUT_DIR       default ./output
 *   GTFS_OUTPUT_NAME      default cluj-napoca.gtfs.zip
 *   GTFS_CALENDAR_DAYS    default 180
 *   TRANZY_RATE_LIMIT_MS  default 500
 */

import { argv, exit, env } from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { TranzyClient } from './sources/tranzy/index';
import { loadTransitousSeed } from './sources/transitous/index';
import { fetchAllCsvSchedules, readCtpCsvFromDisk } from './sources/ctp-csv/index';
import { reconcile } from './assemble/index';
import { writeGtfsZip, validateGtfsZip } from './gtfs';
import { statusManifestExists } from './lib/build-input';

const USAGE = `cluj-napoca-gtfs-adapter — build a reconciled GTFS feed for Cluj-Napoca

Usage:
  cluj-napoca-gtfs build                full pipeline → output/<name>.gtfs.zip
                                         reads CSVs from .build-input/csv/ (smoke must run first)
  cluj-napoca-gtfs validate [path]      validate a produced zip (default: latest in output dir)
  cluj-napoca-gtfs reconcile            dry-run: print summary, don't write a zip
                                         fetches CSVs upstream — for dev only

Env (see .env.example):
  TRANZY_API_KEY         required
  TRANZY_AGENCY_ID       default 2
  TRANSITOUS_SEED_URL    default https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip
  GTFS_OUTPUT_DIR        default ./output
  GTFS_OUTPUT_NAME       default cluj-napoca.gtfs.zip
  GTFS_CALENDAR_DAYS     default 180
`;

async function cmdBuild() {
  // Build ONLY reads from disk. Smoke must have run first to populate
  // .build-input/csv-status.json (manifest) and .build-input/csv/.
  // If the manifest is missing, fail loud with a hint to run smoke.
  if (!statusManifestExists()) {
    console.error(
      'FATAL: .build-input/csv-status.json not found.\n' +
      'Run scripts/fetch-stage.js first to fetch CSVs, then re-run build.',
    );
    exit(1);
  }
  const apiKey = env.TRANZY_API_KEY;
  if (!apiKey) {
    console.error('FATAL: TRANZY_API_KEY not set. Sign up at https://tranzy.dev/accounts and add it to .env');
    exit(1);
  }
  const agencyId = env.TRANZY_AGENCY_ID || '2';
  const seedUrl = env.TRANSITOUS_SEED_URL || undefined;
  const outputDir = env.GTFS_OUTPUT_DIR || './output';
  const outputName = env.GTFS_OUTPUT_NAME || 'cluj-napoca.gtfs.zip';
  const calendarDays = parseInt(env.GTFS_CALENDAR_DAYS || '180', 10);
  const rateLimitMs = parseInt(env.TRANZY_RATE_LIMIT_MS || '500', 10);

  // 1. Load Transitous seed.
  console.log('[1/4] Transitous seed');
  const seed = await loadTransitousSeed(seedUrl ? { url: seedUrl } : {});

  // 2. Fetch Tranzy static endpoints.
  console.log('[2/4] Tranzy static');
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

  // 3. Scrape CTP CSVs.
  console.log('[3/4] CTP CSV schedules');
  const csv = await fetchAllCsvSchedules(seed.routes, {
    loadFn: readCtpCsvFromDisk,
    serviceKeys: (env.CTP_SERVICE_KEYS || 'lv,s,d').split(',').map((s) => s.trim()),
  });
  console.log(`[ctp-csv] scraped ${csv.byRouteService.size} routes`);

  // 4. Reconcile + write.
  console.log('[4/4] Reconciling + writing');
  const { files, warnings, stats } = reconcile({
    seed,
    tranzy: tranzyData,
    csv,
    options: { calendarDays, buildDate: new Date() },
  });

  if (warnings.length > 0) {
    const { emitGroupedWarnings } = await import('./lib/log-severity.js');
    const counts = emitGroupedWarnings(warnings);
    console.log(
      `[reconcile] ${warnings.length} total — ${counts.info} info, ${counts.warn} warn, ${counts.error} error`,
    );
  } else {
    console.log('[reconcile] 0 warnings');
  }

  const outPath = join(outputDir, outputName);
  const { sizeBytes } = await writeGtfsZip(files, outPath);
  console.log(
    `[done] ${outPath} (${(sizeBytes / 1024).toFixed(1)} KB) — ` +
    `${stats.routes} routes, ${stats.stops} stops, ${stats.shapes} shapes, ` +
    `${stats.trips} trips, ${stats.stopTimes} stop_times`,
  );
}

async function cmdValidate(pathArg) {
  const outputDir = env.GTFS_OUTPUT_DIR || './output';
  const outputName = env.GTFS_OUTPUT_NAME || 'cluj-napoca.gtfs.zip';
  const path = pathArg || join(outputDir, outputName);
  if (!existsSync(path)) {
    console.error(`FATAL: ${path} does not exist. Run 'cluj-napoca-gtfs build' first.`);
    exit(1);
  }
  const result = await validateGtfsZip(path);
  console.log(`GTFS zip: ${path}`);
  console.log(`Files (${result.presentFiles.length}):`);
  for (const f of result.presentFiles.sort()) console.log(`  - ${f}`);
  if (result.missingRequired.length > 0) {
    console.error(`MISSING required files: ${result.missingRequired.join(', ')}`);
    exit(1);
  }
  if (result.errors.length > 0) {
    console.error(`ERRORS: ${result.errors.join('; ')}`);
    exit(1);
  }
  console.log('OK — all required GTFS files present.');
}

async function cmdReconcileDryRun() {
  const apiKey = env.TRANZY_API_KEY;
  if (!apiKey) {
    console.error('FATAL: TRANZY_API_KEY not set');
    exit(1);
  }
  const seed = await loadTransitousSeed({});
  const tranzy = new TranzyClient({
    apiKey,
    agencyId: env.TRANZY_AGENCY_ID || '2',
    rateLimitMs: parseInt(env.TRANZY_RATE_LIMIT_MS || '500', 10),
  });
  const tranzyData = await tranzy.fetchAll();
  const csv = await fetchAllCsvSchedules(seed.routes);

  const { warnings, stats } = reconcile({
    seed,
    tranzy: tranzyData,
    csv,
    options: { calendarDays: parseInt(env.GTFS_CALENDAR_DAYS || '180', 10), buildDate: new Date() },
  });

  console.log('\nReconciliation dry-run summary:');
  console.log(`  routes:       ${stats.routes}`);
  console.log(`  stops:        ${stats.stops}`);
  console.log(`  shapes:       ${stats.shapes}`);
  console.log(`  trips:        ${stats.trips}`);
  console.log(`  stop_times:   ${stats.stopTimes}`);
  console.log(`  calendar:     ${stats.calendarServices} service(s)`);
  if (warnings.length > 0) {
    const { emitGroupedWarnings } = await import('./lib/log-severity.js');
    const counts = emitGroupedWarnings(warnings);
    console.log(
      `\n  ${warnings.length} total — ${counts.info} info, ${counts.warn} warn, ${counts.error} error`,
    );
  } else {
    console.log('\n  no warnings.');
  }
}

function main() {
  const args = argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(USAGE);
    return;
  }
  if (cmd === 'build') {
    return cmdBuild().catch((err) => {
      console.error(`FATAL: ${err.stack || err.message || err}`);
      exit(1);
    });
  }
  if (cmd === 'validate') {
    return cmdValidate(args[1]).catch((err) => {
      console.error(`FATAL: ${err.stack || err.message || err}`);
      exit(1);
    });
  }
  if (cmd === 'reconcile') {
    return cmdReconcileDryRun().catch((err) => {
      console.error(`FATAL: ${err.stack || err.message || err}`);
      exit(1);
    });
  }
  if (cmd === '-v' || cmd === '--version') {
    // Read version from package.json relative to this file.
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    console.log(`cluj-napoca-gtfs-adapter ${pkg.version}`);
    return;
  }
  console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
  exit(2);
}

main();