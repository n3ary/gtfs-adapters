import { describe, it, expect } from 'vitest';

import { buildNetworks, formatNetworkUsageSummary } from '../src/assemble/emit/networks.ts';

/**
 * Per gtfs-adapters#26: networks.txt has exactly 2 networks
 * (`school` Transport Elevi, `normal` Normal). Every route is in
 * one of them. route_networks.txt has one row per route.
 *
 * The 1:1 contract is satisfied by construction: every route
 * belongs to exactly one of the two networks. buildNetworks reads
 * from the structured `routeNetworks` map populated by
 * `applyRouteCategory` -- it does NOT parse `route_desc` to
 * reverse-derive the network.
 */
function mapNetworks(entries: Array<[string, { id: string; label: string }]>) {
  return new Map(entries);
}

describe('buildNetworks — networks.txt + route_networks.txt', () => {
  it('emits networks.txt with only the networks actually used (school + normal)', () => {
    // Two TE routes (school) + one regular urban (normal). networks.txt
    // should have school + normal in declaration order. route_networks.txt
    // should have one row per route, with school routes going to the
    // school network and the regular urban to normal.
    const routes = [
      { route_id: '93', route_short_name: 'TE1', route_long_name: 'Manastur', route_desc: '' },
      { route_id: '94', route_short_name: 'TE2', route_long_name: 'Bucium', route_desc: '' },
      { route_id: '15', route_short_name: '1', route_long_name: 'Bucium - 1 Mai', route_desc: '' },
    ];
    const routeNetworks = mapNetworks([
      ['93', { id: 'school', label: 'Transport Elevi' }],
      ['94', { id: 'school', label: 'Transport Elevi' }],
      ['15', { id: 'normal', label: 'Normal' }],
    ]);
    const { networksTxt, routeNetworksTxt, networkUsage } = buildNetworks(routes, routeNetworks);
    expect(networksTxt).toBe(
      'network_id,network_name\nnormal,Normal\nschool,Transport Elevi\n',
    );
    // route_networks rows: sorted by network_id then route_id for diff-stability.
    expect(routeNetworksTxt).toBe(
      'network_id,route_id\n' +
      'normal,15\n' +
      'school,93\n' +
      'school,94\n',
    );
    expect(networkUsage.get('school')).toBe(2);
    expect(networkUsage.get('normal')).toBe(1);
  });

  it('emits only `normal` when no school-classified routes exist', () => {
    // All routes are non-TE -> normal network only. networks.txt
    // should have just the normal row (school is conditional on
    // having at least one TE* route).
    const routes = [
      { route_id: '1', route_short_name: '1', route_long_name: 'A - B', route_desc: '' },
      { route_id: '2', route_short_name: '2', route_long_name: 'C - D', route_desc: '' },
    ];
    const routeNetworks = mapNetworks([
      ['1', { id: 'normal', label: 'Normal' }],
      ['2', { id: 'normal', label: 'Normal' }],
    ]);
    const { networksTxt, routeNetworksTxt, networkUsage } = buildNetworks(routes, routeNetworks);
    expect(networksTxt).toBe('network_id,network_name\nnormal,Normal\n');
    expect(routeNetworksTxt).toBe('network_id,route_id\nnormal,1\nnormal,2\n');
    expect(networkUsage.size).toBe(1);
    expect(networkUsage.get('normal')).toBe(2);
    expect(networkUsage.has('school')).toBe(false);
  });

  it('emits only `school` when every route is TE*', () => {
    // Edge case: a feed with ONLY school routes. networks.txt
    // should have just the school row (normal is conditional on
    // having at least one non-TE route).
    const routes = [
      { route_id: '93', route_short_name: 'TE1', route_long_name: 'A', route_desc: '' },
      { route_id: '94', route_short_name: 'TE2', route_long_name: 'B', route_desc: '' },
    ];
    const routeNetworks = mapNetworks([
      ['93', { id: 'school', label: 'Transport Elevi' }],
      ['94', { id: 'school', label: 'Transport Elevi' }],
    ]);
    const { networksTxt, routeNetworksTxt, networkUsage } = buildNetworks(routes, routeNetworks);
    // The implementation emits only the networks actually referenced
    // by the input routes -- so a feed of only TE* routes produces
    // a networks.txt with just the `school` row (no normal row).
    expect(networksTxt).toBe('network_id,network_name\nschool,Transport Elevi\n');
    expect(routeNetworksTxt).toBe('network_id,route_id\nschool,93\nschool,94\n');
    expect(networkUsage.size).toBe(1);
    expect(networkUsage.get('school')).toBe(2);
  });

  it('returns empty strings when no routes exist (defensive)', () => {
    const { networksTxt, routeNetworksTxt, networkUsage } = buildNetworks([], new Map());
    expect(networksTxt).toBe('');
    expect(routeNetworksTxt).toBe('');
    expect(networkUsage.size).toBe(0);
  });

  it('skips routes that are not in routeNetworks (defensive)', () => {
    // Defensive: if a route is missing from routeNetworks (shouldn't
    // happen in practice -- applyRouteCategory sets a network for
    // every route), buildNetworks silently skips it rather than
    // throwing.
    const routes = [
      { route_id: '1', route_short_name: '1', route_long_name: 'A - B', route_desc: '' },
      { route_id: '2', route_short_name: '2', route_long_name: 'C - D', route_desc: '' },
    ];
    const routeNetworks = mapNetworks([
      ['1', { id: 'normal', label: 'Normal' }],
      // route '2' intentionally missing
    ]);
    const { networksTxt, routeNetworksTxt } = buildNetworks(routes, routeNetworks);
    expect(networksTxt).toBe('network_id,network_name\nnormal,Normal\n');
    expect(routeNetworksTxt).toBe('network_id,route_id\nnormal,1\n');
  });

  it('emits networks in declaration order (school before normal), not by first-seen', () => {
    // Even if the input order is normal-first then school, networks.txt
    // should be: school, normal (declaration order). This pins the
    // predictable file layout for downstream diff-stability.
    const routes = [
      { route_id: '15', route_short_name: '1', route_long_name: '', route_desc: '' },
      { route_id: '93', route_short_name: 'TE1', route_long_name: '', route_desc: '' },
    ];
    const routeNetworks = mapNetworks([
      ['15', { id: 'normal', label: 'Normal' }],
      ['93', { id: 'school', label: 'Transport Elevi' }],
    ]);
    const { networksTxt } = buildNetworks(routes, routeNetworks);
    expect(networksTxt).toBe(
      'network_id,network_name\nnormal,Normal\nschool,Transport Elevi\n',
    );
  });

  it('emits route_networks rows in (network_id, route_id) lex order for diff-stability', () => {
    // Order: network_id first, then route_id. This is more debuggable
    // than input order and easier to diff across builds.
    const routes = [
      { route_id: 'r-c', route_short_name: 'c', route_long_name: 'A', route_desc: '' },
      { route_id: 'r-a', route_short_name: 'a', route_long_name: 'B', route_desc: '' },
      { route_id: 'r-b', route_short_name: 'b', route_long_name: 'C', route_desc: '' },
    ];
    const routeNetworks = mapNetworks([
      ['r-a', { id: 'normal', label: 'Normal' }],
      ['r-b', { id: 'school', label: 'Transport Elevi' }],
      ['r-c', { id: 'normal', label: 'Normal' }],
    ]);
    const { routeNetworksTxt } = buildNetworks(routes, routeNetworks);
    expect(routeNetworksTxt).toBe(
      'network_id,route_id\n' +
      'normal,r-a\n' +
      'normal,r-c\n' +
      'school,r-b\n',
    );
  });

  it('emits one row per route, never 1:many (gtfs spec 1:1 by route_id)', () => {
    // Even with 100 routes, route_networks.txt should have exactly
    // 100 data rows. The previous design emitted 1:many rows for
    // routes matching multiple categories (issue #4 violation).
    const routes = Array.from({ length: 100 }, (_, i) => ({
      route_id: `r-${i}`,
      route_short_name: `${i}`,
      route_long_name: 'A - B',
      route_desc: '',
    }));
    const routeNetworks = mapNetworks(
      routes.map((r) => [r.route_id, { id: 'normal', label: 'Normal' }]),
    );
    const { routeNetworksTxt } = buildNetworks(routes, routeNetworks);
    const dataLines = routeNetworksTxt.trim().split('\n').slice(1);
    expect(dataLines.length).toBe(100);
  });
});

describe('formatNetworkUsageSummary — build-log helper', () => {
  it('formats id → count pairs in id-sorted order', () => {
    const usage = new Map([
      ['normal', 200],
      ['school', 15],
    ]);
    const s = formatNetworkUsageSummary(usage);
    // Sorted alphabetically: normal, school
    expect(s).toBe('200 normal, 15 school');
  });

  it('returns empty string for empty usage', () => {
    expect(formatNetworkUsageSummary(new Map())).toBe('');
  });

  it('handles single-network feeds', () => {
    const usage = new Map([['normal', 50]]);
    expect(formatNetworkUsageSummary(usage)).toBe('50 normal');
  });
});
