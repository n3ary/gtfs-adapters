import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GTFS_URL,
  DEFAULT_AGENCY_ID,
  DEFAULT_CALENDAR_DAYS,
  REQUIRED_SECRETS,
  ingestBuild,
} from '../src/ingest/index.ts';

/**
 * Live-fetch tests of ingestBuild are gated behind an env var
 * (HSL_LIVE_FETCH=1) so the test suite doesn't hit HSL's servers
 * on every run. The non-live tests cover the static config and
 * the failure paths.
 */

describe('ingest defaults', () => {
  it('points at the canonical HSL GTFS URL', () => {
    expect(DEFAULT_GTFS_URL).toBe('https://gtfs.hsl.fi/gtfs.zip');
  });

  it('declares the canonical HSL agency id', () => {
    expect(DEFAULT_AGENCY_ID).toBe('HSL');
  });

  it('uses a 60-day calendar window', () => {
    expect(DEFAULT_CALENDAR_DAYS).toBe(60);
  });

  it('requires no secrets (HSL is public open data)', () => {
    expect(REQUIRED_SECRETS).toEqual([]);
  });
});

describe('ingestBuild (offline)', () => {
  it('throws on upstream error', async () => {
    await expect(
      ingestBuild({
        outputDir: '/tmp/helsinki-test',
        secrets: {},
        fetchFn: async () => {
          throw new Error('HTTP 503 Service Unavailable');
        },
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('throws on empty response body', async () => {
    await expect(
      ingestBuild({
        outputDir: '/tmp/helsinki-test',
        secrets: {},
        fetchFn: async () => new ArrayBuffer(0),
      }),
    ).rejects.toThrow(/empty response/);
  });

  it('returns the zip bytes on success', async () => {
    const fake = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]).buffer;
    const result = await ingestBuild({
      outputDir: '/tmp/helsinki-test',
      secrets: {},
      fetchFn: async () => fake,
    });
    expect(result.sizeBytes).toBe(5);
    expect(result.zipPath).toBe('helsinki.gtfs.zip');
  });
});
