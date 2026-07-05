// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { fetchToFile, assertSeedZipBody } from '../src/lib/seed.ts';

const URL = 'https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
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

describe('assertSeedZipBody', () => {
  it('passes a real-looking ZIP body through unchanged', () => {
    expect(() => assertSeedZipBody(VALID_ZIP_HEAD, URL)).not.toThrow();
  });

  it('throws on a Cloudflare challenge page (cf-mitigated marker)', () => {
    // First marker match wins; "<!doctype html" appears earlier in
    // the buffer than "cf-mitigated" so it's what fires. The test
    // pins "any WAF marker throws" rather than "this specific
    // marker throws" - any future marker-list change shouldn't
    // break this contract.
    expect(() => assertSeedZipBody(Buffer.from(CF_CHALLENGE), URL))
      .toThrow(/contains ".*" marker/);
  });

  it('throws on a generic WAF error page (doctype marker)', () => {
    expect(() => assertSeedZipBody(Buffer.from(GENERIC_WAF), URL))
      .toThrow(/contains "<!doctype html" marker/);
  });

  it('throws on body that is neither zip nor HTML (truncated / garbage)', () => {
    expect(() => assertSeedZipBody(Buffer.from('just some random bytes'), URL))
      .toThrow(/not a ZIP file/);
  });

  it('throws on a too-short buffer with no markers', () => {
    expect(() => assertSeedZipBody(Buffer.from([0x00, 0x01]), URL))
      .toThrow(/not a ZIP file/);
  });

  it('does NOT throw on a ZIP whose first KB happens to contain a marker substring', () => {
    // Defensive: a zip with the bytes "forbidden" somewhere in its
    // first KB shouldn't trip the guard (PK magic is checked first,
    // so we return early). This is the "happy path wins" contract.
    const weirdButValidZip = Buffer.concat([
      ZIP_MAGIC,
      Buffer.from('forbidden <html> but still a real zip'),
    ]);
    expect(() => assertSeedZipBody(weirdButValidZip, URL)).not.toThrow();
  });
});

describe('fetchToFile', () => {
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
    // The exact pattern that crashed 'stops near me' today.
    // Transitous responded HTTP 200 + CF challenge HTML; fetchToFile
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