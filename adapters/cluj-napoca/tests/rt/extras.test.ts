/**
 * extraVehiclePositions.test.ts — cluj's /rt subpath exposes the
 * array of extra vehicle_positions URLs.
 *
 * What this guards:
 *   1. `extraVehiclePositions()` is exported from /rt and is
 *      callable.
 *   2. Returns `string[]` (the type contract).
 *   3. For cluj today: empty array. If CTP ever publishes a
 *      mirror, this is the one place that knows.
 *   4. The /static subpath does NOT export it (realtime-specific
 *      knowledge belongs in /rt, not /static).
 */
import { describe, it, expect } from 'vitest';
import { extraVehiclePositions } from '../../src/rt/extras.ts';
import * as rtExports from '../../src/rt/index.ts';
import * as staticExports from '../../src/static/index.ts';

describe('extraVehiclePositions()', () => {
  it('is exported from the /rt subpath', () => {
    expect(typeof rtExports.extraVehiclePositions).toBe('function');
    // The barrel re-export must point at the same function the
    // /rt module defines (orchestrator imports the barrel).
    expect(rtExports.extraVehiclePositions).toBe(extraVehiclePositions);
  });

  it('returns string[] (the type contract)', () => {
    const extras = extraVehiclePositions();
    expect(Array.isArray(extras)).toBe(true);
    for (const url of extras) {
      expect(typeof url).toBe('string');
    }
  });

  it('returns an empty array for cluj today (no third-party mirrors)', () => {
    expect(extraVehiclePositions()).toEqual([]);
  });

  it('all entries are https:// (CF cache + the consumer both refuse plain http)', () => {
    for (const url of extraVehiclePositions()) {
      expect(url.startsWith('https://')).toBe(true);
    }
  });
});

describe('realtime concerns stay in /rt, not /static', () => {
  it('/static does NOT export extraVehiclePositions', () => {
    expect((staticExports as Record<string, unknown>).extraVehiclePositions).toBeUndefined();
  });

  it('/rt does NOT re-export staticExtension (the static-pipeline concern)', () => {
    expect((rtExports as Record<string, unknown>).staticExtension).toBeUndefined();
  });
});
