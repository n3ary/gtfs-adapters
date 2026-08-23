import { describe, it, expect } from 'vitest';
import {
  staticExtension,
  applyStaticPostLoad,
  producerExtensions,
} from '../src/static/index.ts';

describe('staticExtension', () => {
  it('returns a StaticExtension object', () => {
    const ext = staticExtension({});
    expect(ext).toBeDefined();
    expect(typeof ext.fillComputedColumns).toBe('function');
  });

  it('populates _neary_config from timing', () => {
    const ext = staticExtension({
      timing: { speed_kmh: { peak: 22, offpeak: 28, night: 32 } },
    });
    const neary = ext.tableExtensions!._neary_config!;
    expect(neary.columns).toEqual([
      ['key', 'TEXT PRIMARY KEY'],
      ['value', 'TEXT NOT NULL'],
    ]);
    expect(neary.rows).toEqual([
      {
        key: 'timing',
        value: JSON.stringify({ speed_kmh: { peak: 22, offpeak: 28, night: 32 } }),
      },
    ]);
  });

  it('skips _neary_config rows when timing is absent', () => {
    const ext = staticExtension({});
    const neary = ext.tableExtensions!._neary_config!;
    expect(neary.rows).toEqual([]);
  });

  it('does not declare network color column (Helsinki has no networks)', () => {
    const ext = staticExtension({});
    // The cluj adapter adds `networks.network_color`; the Helsinki
    // adapter doesn't, because HSL has no per-feed networks.
    expect(ext.columnExtensions ?? []).toEqual([]);
  });

  it('declares no producer extensions', () => {
    // Helsinki ships no producer-extension files today.
    expect(producerExtensions).toEqual([]);
  });
});

describe('applyStaticPostLoad', () => {
  it('returns empty ComputedUpdates (Helsinki ships colors, no derive)', () => {
    const out = applyStaticPostLoad({
      feedId: 'helsinki',
      routes: [{ route_id: '1003', route_color: 'FF0000' }],
      networks: [],
      routeNetworks: [],
    });
    expect(out).toEqual({});
  });
});
