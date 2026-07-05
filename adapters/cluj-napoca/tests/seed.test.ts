// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { fetchToFile } from '../src/lib/seed.ts';
import { ZIP_MAGIC } from '@n3ary/gtfs-spec/waf';

const URL = 'https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip';

const VALID_ZIP_HEAD = Buffer.concat([ZIP_MAGIC, Buffer.alloc(26, 0)]);

// Real-world Cloudflare challenge page (close-enough excerpt).
const CF_CHALLENGE = `<!DOCTYPE html>
<html lang="en">
<head><title>Just a moment...</title></head>
<body>
<h1>Checking your browser before accessing api.transitous.org.</h1>
<script>cf-mitigated</script>
</body>
</html>`;

// Generic WAF error page (no Cloudflare marker but obviously HTML).
const GENERIC_WAF = `<!doctype html><html><body>Access denied - request blocked.</body></html>`;

describe('fetchToFile (seed-side WAF guard)', () => {
  // The actual WAF detection logic lives in @n3ary/gtfs-spec/waf
  // and is covered exhaustively by packages/spec/test/waf.test.ts
  // in the gtfs-publisher repo. These tests only pin the
  // seed.ts-specific wiring: that fetchToFile uses the shared
  // guard, and the disk-level "no orphan file" contract holds.

  it('writes a real ZIP body to disk unchanged', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'seedFetchToFile-'));
    const dest = join(tmp, 'seed.zip');
    const fetchMock = vi.fn(async () =>
      new Response(VALID_ZIP_HEAD, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    await fetchToFile(URL, dest, { fetch: fetchMock });
    const onDisk = readFileSync(dest);
    expect(onDisk.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
  });

  it('does NOT write a Cloudflare challenge page to disk (no orphan file)', async () => {
    // The exact pattern that crashed 'stops near me' on 2026-07-05:
    // Transitous returned HTTP 200 + CF challenge HTML; fetchToFile
    // used to write the HTML to seed.zip; the unzip step then either
    // failed loudly downstream or parsed garbage rows; the resulting
    // GTFS shipped to consumers crashed the app on bogus data.
    const tmp = mkdtempSync(join(tmpdir(), 'seedFetchToFile-'));
    const dest = join(tmp, 'seed.zip');
    const fetchMock = vi.fn(async () =>
      new Response(CF_CHALLENGE, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    await expect(fetchToFile(URL, dest, { fetch: fetchMock }))
      .rejects.toThrow(/contains ".*" marker/);
    // Critical: the failed write must leave nothing behind.
    expect(() => readFileSync(dest)).toThrow();
  });

  it('does NOT write a generic WAF page with lying Content-Type to disk', async () => {
    // Sneakiest case: Content-Type says octet-stream but body is
    // HTML. Without the magic-bytes check, this would slip through.
    const tmp = mkdtempSync(join(tmpdir(), 'seedFetchToFile-'));
    const dest = join(tmp, 'seed.zip');
    const fetchMock = vi.fn(async () =>
      new Response(GENERIC_WAF, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    await expect(fetchToFile(URL, dest, { fetch: fetchMock }))
      .rejects.toThrow(/contains ".*" marker/);
    expect(() => readFileSync(dest)).toThrow();
  });

  it('throws on non-2xx status BEFORE running the guard (cheaper path)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('upstream down', { status: 503 }),
    );
    await expect(fetchToFile(URL, '/tmp/should-not-be-written.zip', { fetch: fetchMock }))
      .rejects.toThrow(/HTTP 503/);
  });
});