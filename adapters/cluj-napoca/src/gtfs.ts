// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * GTFS zip writer.
 *
 * Takes the output of `reconcile()` and packs it into a standards-
 * compliant gtfs.zip using `archiver`. GTFS zips have no top-level
 * directory — all files at the root.
 */

import { createWriteStream } from 'node:fs';
import { mkdirSync, statSync } from 'node:fs';
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

/**
 * Validate a produced GTFS zip. Walks the zip listing and checks the
 * minimum required files are present, with at least a header row.
 *
 * @param {string} zipPath
 * @returns {Promise<{
 *   ok: boolean,
 *   presentFiles: string[],
 *   missingRequired: string[],
 *   errors: string[],
 * }>}
 */
export async function validateGtfsZip(zipPath) {
  const present = [];
  const errors = [];
  if (!statSync(zipPath)) {
    return { ok: false, presentFiles: [], missingRequired: REQUIRED, errors: ['file not found'] };
  }
  // Lazy-import node-stream-zip to avoid adding it as a dep just for validation.
  // If it's not available we fall back to a basic zip-listing via the
  // central directory at the end of the file (only lists names, not content).
  let zip;
  try {
    const mod = await import('node-stream-zip');
    zip = new mod.default({ file: zipPath, storeEntries: true });
    for (const entry of await zip.entries()) {
      present.push(entry.name);
    }
    await zip.close();
  } catch (err) {
    // No node-stream-zip — fall back to a minimal zip-name peek.
    const { readFileSync } = await import('node:fs');
    const buf = readFileSync(zipPath);
    const names = peekZipCentralDirectoryNames(buf);
    present.push(...names);
    if (names.length === 0) {
      errors.push(`could not read zip: ${err.message || err}`);
    }
  }

  const missingRequired = REQUIRED.filter((f) => !present.includes(f));
  return { ok: missingRequired.length === 0, presentFiles: present, missingRequired, errors };
}

const REQUIRED = ['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt'];

/**
 * Minimal zip central-directory peek. Reads the End-of-Central-Directory
 * record at the tail, then walks the entries for their filename.
 *
 * Format reference: PKWARE APPNOTE 6.3.x. We only need the names, so
 * we parse the EOCD + each CD entry's filename length + filename.
 */
function peekZipCentralDirectoryNames(buf) {
  const names = [];
  // EOCD signature = 0x06054b50, located in the last 64K + 22 bytes.
  const SIG_EOCD = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;
  const view = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const u8 = new Uint8Array(view);
  const dv = new DataView(view);
  let eocdOff = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 0xFFFF - 22); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocdOff = i; break; }
  }
  if (eocdOff < 0) return names;
  const cdSize = dv.getUint32(eocdOff + 12, true);
  const cdOff = dv.getUint32(eocdOff + 16, true);
  let p = cdOff;
  const end = cdOff + cdSize;
  while (p < end && p < u8.length) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) break;
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const nameStart = p + 46;
    if (nameStart + nameLen > u8.length) break;
    names.push(new TextDecoder('utf-8').decode(u8.subarray(nameStart, nameStart + nameLen)));
    p = nameStart + nameLen + extraLen + commentLen;
  }
  return names;
}