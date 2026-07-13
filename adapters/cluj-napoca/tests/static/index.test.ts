/**
 * index.test.ts — pins the `/static` barrel re-exports.
 *
 * The publisher (`gtfs-publisher`) dynamic-imports the adapter's
 * `/static` subpath and reads `mod.producerExtensions` to discover
 * which producer-extension files in the zip to parse and where to
 * put the rows. If the barrel doesn't re-export `producerExtensions`,
 * the import is undefined, the wiring is silently skipped, and the
 * adapter's table-extension rows end up empty in the SQLite (a
 * particularly nasty failure because nothing errors — the build
 * just produces a SQLite with the DDL but no rows).
 *
 * Caught this in production 2026-07-13: PR #86 declared
 * `producerExtensions` in `static/extension.ts` and the publisher
 * PR #227 wired the consumer, but the barrel in `static/index.ts`
 * didn't re-export it. The live cluj SQLite had `_route_tags` DDL
 * but 0 rows even though the GTFS zip carried `_route_tags.txt`.
 *
 * This test fails if `producerExtensions` is missing from the
 * barrel, with a clear message naming the import the publisher
 * expects.
 */

import { describe, it, expect } from 'vitest';
import { producerExtensions, staticExtension } from '../../src/static/index.ts';

describe('static subpath barrel', () => {
  it('re-exports staticExtension (publisher calls this)', () => {
    expect(typeof staticExtension).toBe('function');
  });

  it('re-exports producerExtensions (publisher reads this to discover zip files)', () => {
    // The orchestrator does `import('${publisher}/static')` and
    // checks `Array.isArray(mod.producerExtensions)` to decide
    // whether to walk the producer-extension manifest. A missing
    // export here silently degrades to "no producer extensions"
    // for this adapter — the SQLite builds with empty table
    // extensions and the live-data smoke test fails.
    expect(Array.isArray(producerExtensions)).toBe(true);
    expect(producerExtensions.length).toBeGreaterThan(0);
    for (const entry of producerExtensions) {
      expect(typeof entry.fileName).toBe('string');
      expect(entry.fileName.length).toBeGreaterThan(0);
      expect(typeof entry.feedConfigKey).toBe('string');
      expect(entry.feedConfigKey.length).toBeGreaterThan(0);
    }
  });
});
