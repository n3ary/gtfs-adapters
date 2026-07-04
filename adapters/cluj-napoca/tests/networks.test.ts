import { describe, it, expect } from 'vitest';

import { buildNetworks, formatNetworkUsageSummary } from '../src/assemble/emit/networks';

describe('buildNetworks — networks.txt + route_networks.txt', () => {
  it('emits networks.txt with only the categories actually used', () => {
// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
    // Only school + night have routes — festival/airport/etc. should NOT
    // appear in networks.txt even though they're in CATEGORIES.
    const routes = [
      { route_id: '93', route_short_name: 'TE1', route_long_name: 'Manastur', route_desc: 'Transport Elevi' },
      { route_id: '94', route_short_name: 'TE2', route_long_name: 'Bucium', route_desc: 'Transport Elevi' },
      { route_id: '15', route_short_name: '25N', route_long_name: 'Bucium - Unirii', route_desc: 'Noapte' },
    ];
    const { networksTxt, routeNetworksTxt, networkUsage } = buildNetworks(routes);
    expect(networksTxt).toBe(
      'network_id,network_name\nschool,Transport Elevi\nnight,Noapte\n',
    );
    expect(routeNetworksTxt).toBe(
      'network_id,route_id\nschool,93\nschool,94\nnight,15\n',
    );
    expect(networkUsage.get('school')).toBe(2);
    expect(networkUsage.get('night')).toBe(1);
  });

  it('returns empty strings when no routes have a category (regular urban only)', () => {
    const routes = [
      { route_id: '1', route_short_name: '1', route_long_name: 'Bucium - 1 Mai', route_desc: '' },
      { route_id: '2', route_short_name: '2', route_long_name: 'A - B', route_desc: '' },
    ];
    const { networksTxt, routeNetworksTxt, networkUsage } = buildNetworks(routes);
    expect(networksTxt).toBe('');
    expect(routeNetworksTxt).toBe('');
    expect(networkUsage.size).toBe(0);
  });

  it('matches by label (route_desc == network_name)', () => {
    // Pin the contract: route_desc carries the human label, which is
    // the same string as networks.txt `network_name`. Adding a row with
    // a different route_desc (e.g. legacy "str.Bucium..." noise) should
    // be ignored — it isn't a known label.
    const routes = [
      { route_id: '1', route_short_name: '1', route_long_name: 'A - B', route_desc: 'Transport Elevi' },
      { route_id: '2', route_short_name: '2', route_long_name: 'C - D', route_desc: 'str.Bucium - p-ta garii autobuze' },
      { route_id: '3', route_short_name: '3', route_long_name: 'E - F', route_desc: '' },
    ];
    const { networksTxt, routeNetworksTxt, networkUsage } = buildNetworks(routes);
    // Only route_id=1 matches a known label.
    expect(networksTxt).toBe('network_id,network_name\nschool,Transport Elevi\n');
    expect(routeNetworksTxt).toBe('network_id,route_id\nschool,1\n');
    expect(networkUsage.get('school')).toBe(1);
    // Routes 2 and 3 (unknown label / empty label) are silently skipped.
  });

  it('emits category rows in CATEGORIES order, not by first-seen', () => {
    // Even if the route order is school, then festival, then night, the
    // networks.txt rows should be: school, festival, night (priority
    // order). This pins the predictable file layout for downstream
    // diff-stability.
    const routes = [
      { route_id: '93', route_short_name: 'TE1', route_long_name: '', route_desc: 'Transport Elevi' },
      { route_id: '68', route_short_name: 'M26U', route_long_name: '', route_desc: 'Untold' },
      { route_id: '15', route_short_name: '25N', route_long_name: '', route_desc: 'Noapte' },
    ];
    const { networksTxt } = buildNetworks(routes);
    expect(networksTxt).toBe(
      'network_id,network_name\nschool,Transport Elevi\nfestival,Untold\nnight,Noapte\n',
    );
  });

  it('handles empty input gracefully', () => {
    const { networksTxt, routeNetworksTxt, networkUsage } = buildNetworks([]);
    expect(networksTxt).toBe('');
    expect(routeNetworksTxt).toBe('');
    expect(networkUsage.size).toBe(0);
  });

  it('handles null/undefined route_desc defensively', () => {
    const routes = [
      { route_id: '1', route_short_name: '1', route_long_name: 'A - B' }, // no route_desc
      { route_id: '2', route_short_name: '2', route_long_name: 'C - D', route_desc: null },
    ];
    const { networksTxt, routeNetworksTxt } = buildNetworks(routes);
    expect(networksTxt).toBe('');
    expect(routeNetworksTxt).toBe('');
  });
});

describe('formatNetworkUsageSummary — build-log helper', () => {
  it('formats id → count pairs', () => {
    const usage = new Map([['school', 31], ['metroline', 41], ['night', 3]]);
    // Order: depends on Map iteration. Pin by checking all parts present.
    const s = formatNetworkUsageSummary(usage);
    expect(s).toContain('31 school');
    expect(s).toContain('41 metroline');
    expect(s).toContain('3 night');
  });

  it('returns empty string for empty usage', () => {
    expect(formatNetworkUsageSummary(new Map())).toBe('');
  });
});