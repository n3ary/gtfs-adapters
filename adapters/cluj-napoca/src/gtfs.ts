// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * GTFS zip writer.
 *
 * Takes the output of `reconcile()` and packs it into a standards-
 * compliant gtfs.zip using `archiver`. GTFS zips have no top-level
 * directory — all files at the root.
 *
 * History: previously also exposed `validateGtfsZip` (a zip-listing
 * peek for `cli.ts validate`). The orchestrator (`n3ary/gtfs-publisher`)
 * now owns GTFS-shape validation in its own `validate.ts` (cross-ref
 * orphans + required files + monotonic stop_sequence + the spec DDL's
 * CHECK + FK constraints); the cluj adapter just writes bytes.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ZipArchive } from 'archiver';

/**
 * @param {Record<string, string>} files  output of `reconcile().files`
 * @param {string} outPath  destination .zip path
 * @returns {Promise<{ sizeBytes: number }>}
 */
export async function writeGtfsZip(files, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const out = createWriteStream(outPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    out.on('close', () => resolve({ sizeBytes: archive.pointer() }));
    archive.on('error', reject);
    archive.pipe(out);
    for (const [name, body] of Object.entries(files)) {
      if (!body) continue;
      archive.append(body, { name });
    }
    archive.finalize();
  });
}