#!/usr/bin/env node
// @ts-nocheck — operational script, not part of the library surface. Migrated to .ts
// for the same tooling (tsc check, tsx run) as the rest of the package; full typing
// is a follow-up since this file is downstream of the spec (it parses the .zip output
// and inspects trip_id strings).
/**
 * Trip-ID format self-check.
 *
 * Verifies that every trip_id in our generated `trips.txt` ends in
 * `_HHMM` — the structural requirement that lets the `neary` app's
 * `parseLiveStartMin` (src/lib/domain/reconcile.ts) fall back to
 * extracting the scheduled start time from the trip_id suffix when
 * `TripDescriptor.start_time` isn't populated.
 *
 * NOTE: This is a SELF-check on OUR output, not a parity check
 * against an external GTFS-RT feed. The neary reconciler does NOT
 * match static and GTFS-RT trip_ids by equality — it re-maps live
 * observations to scheduled trips by `(routeId, directionId,
 * tripStartMin)` because static and RT trip_ids drift ~23% of the time
 * (each generator pulls from independent dispatch databases; see
 * neary/src/lib/domain/reconcile.ts:5-14).
 *
 * In other words: a "parity check" against the live RT feed was
 * checking a contract that doesn't exist. What we DO need to verify is
 * that our own trip_ids are well-formed for downstream consumers
 * (specifically: neary's HHMM tail fallback).
 *
 * Configuration:
 *   GTFS_ZIP_PATH          path to the produced zip (default:
 *                          output/cluj-napoca.gtfs.zip relative to cwd)
 *   TRIP_ID_HHMM_RE       override the regex (default: _\d{4}$ — last
 *                          segment is 4 digits, no colon)
 *
 * Exit codes:
 *   0  every trip_id ends with `_HHMM`
 *   1  at least one trip_id doesn't match the pattern
 *   2  zip not found / unreadable / trips.txt missing
 */

import { argv, env, exit } from 'node:process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_ZIP = join(process.cwd(), 'output', 'cluj-napoca.gtfs.zip');
const HHMM_RE = /_\d{4}$/;
// `NTxxx` suffix (e.g. `38_0_LV_NT001`) marks Tranzy-fallback trips
// — routes with no CTP CSV coverage. Tranzy doesn't publish
// arrival_time, so we emit timepoint='0' with empty times and a
// "no-time" sentinel in the trip_id so downstream parsers
// (neary's parseLiveStartMin) know not to extract a start time.
const NT_RE = /_NT\d{3,}$/;

async function main() {
  const zipPath = env.GTFS_ZIP_PATH || DEFAULT_ZIP;
  const re = env.TRIP_ID_HHMM_RE ? new RegExp(env.TRIP_ID_HHMM_RE) : HHMM_RE;

  if (!existsSync(zipPath)) {
    console.error(`[trip-ids] FATAL: ${zipPath} not found. Run 'pnpm run build' first.`);
    exit(2);
  }
  console.log(`[trip-ids] inspecting ${zipPath} (${(statSync(zipPath).size / 1024).toFixed(1)} KB)`);

  // Lazily require archiver's sibling for reading zips, OR fall back to
  // shelling out to `unzip -p` (always available on macOS/Linux dev env).
  let tripsTxt;
  try {
    const mod = await import('node-stream-zip');
    const zip = new mod.default({ file: zipPath, storeEntries: true });
    tripsTxt = await zip.stream('trips.txt', (err, stream) => {
      if (err) throw err;
    }).then((stream) => new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    }));
    await zip.close();
  } catch (err) {
    // Fallback: shell out to unzip. Same as src/lib/seed.js does.
    console.log(`[trip-ids] (node-stream-zip unavailable, falling back to unzip -p)`);
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('unzip', ['-p', zipPath, 'trips.txt'], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(`[trip-ids] FATAL: cannot read trips.txt from zip: ${r.stderr}`);
      exit(2);
    }
    tripsTxt = r.stdout;
  }

  if (!tripsTxt) {
    console.error(`[trip-ids] FATAL: trips.txt missing or empty in ${zipPath}`);
    exit(2);
  }

  const lines = tripsTxt.split('\n').slice(1).filter(Boolean);
  const ids = lines.map((l) => l.split(',')[2]).filter(Boolean);
  console.log(`[trip-ids] found ${ids.length} trip_ids in trips.txt`);

  const mismatches = ids.filter((id) => !re.test(id) && !NT_RE.test(id));
  const freqAnchors = ids.filter((id) => id.includes('_FREQ_'));
  const ntAnchors = ids.filter((id) => NT_RE.test(id));

  if (mismatches.length > 0) {
    console.error(`[trip-ids] FAIL: ${mismatches.length}/${ids.length} trip_ids do not end with _HHMM or _NTxxx`);
    for (const id of mismatches.slice(0, 10)) console.error(`  - ${id}`);
    if (mismatches.length > 10) console.error(`  ... and ${mismatches.length - 10} more`);
    console.error(`[trip-ids] fix: src/assemble/emit/trips.js makeTripId() should produce IDs ending in _HHMM or _NTxxx`);
    exit(1);
  }

  console.log(`[trip-ids] OK — all ${ids.length} trip_ids well-formed`);
  if (freqAnchors.length > 0) {
    console.log(`[trip-ids] (${freqAnchors.length} are frequency anchors, format _FREQ_<HHMM>)`);
  }
  if (ntAnchors.length > 0) {
    console.log(`[trip-ids] (${ntAnchors.length} are Tranzy-fallback anchors, format _NTxxx — no real start time)`);
  }
  console.log(`[trip-ids] sample: ${ids.slice(0, 5).join(', ')}`);
  exit(0);
}

main().catch((err) => {
  console.error(`[trip-ids] unexpected error: ${err.stack || err.message || err}`);
  exit(2);
});

void argv;