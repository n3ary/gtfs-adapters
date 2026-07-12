// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity.
import { describe, it, expect } from 'vitest';

import {
  CATEGORIES,
  classifyRoute,
  classifyNetwork,
  cleanLongName,
  cleanDesc,
  deriveLongNameFromStops,
  applyRouteCategory,
  getAllCategories,
  getAllTags,
  getAllNetworks,
} from '../src/assemble/merge/routeCategory.ts';

describe('classifyRoute — tag-surface pattern → category', () => {
  // classifyRoute returns tag matches only (not networks). Empty for
  // regular urban routes and for TE routes (school is a network, not
  // a tag -- see gtfs-adapters#26).

  it('classifies TE-prefixed routes as NOT having a tag (school is network-only now)', () => {
    // School is a network under the new model (gtfs-adapters#26),
    // not a tag. TE1's school designation lives in route_networks.txt
    // only -- route_desc is empty (no tag matches).
    expect(classifyRoute({ route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur' })).toEqual([]);
    expect(classifyRoute({ route_short_name: 'TE14' })).toEqual([]);
    expect(classifyRoute({ route_short_name: 'TE-OG' })).toEqual([]);
  });

  it('classifies M7x routes as metroline ONLY (no school tag for long_name TE prefix)', () => {
    // Per gtfs-adapters#26 + #27: the M7x school-bus family
    // (M75A..M79C) used to be partially tagged as `school` because
    // their long_name starts with "TE\d+ Floresti". Under the new
    // model, school is network-only, so the overbroad long_name
    // match is gone. M7x routes are metroline-only tags, normal
    // network.
    expect(classifyRoute({
      route_short_name: 'M76A',
      route_long_name: 'TE2 Floresti str. Somesului',
    })).toEqual([
      { id: 'metroline', label: 'Metropolitan' },
    ]);
    expect(classifyRoute({
      route_short_name: 'M75B',
      route_long_name: 'TE1F',
    })).toEqual([
      { id: 'metroline', label: 'Metropolitan' },
    ]);
  });

  it('does NOT catch "elevi" substring as school (school is no longer a tag)', () => {
    // The previous "elevi" defensive substring check across all 3
    // fields is gone. School is a network (TE* short_name only) and
    // has no tag surface. The "elevi" string in long_name / desc
    // is not surfaced as a tag label.
    expect(classifyRoute({ route_short_name: 'X1', route_long_name: 'Some elevi variant' })).toEqual([]);
    expect(classifyRoute({ route_short_name: 'X2', route_long_name: '', route_desc: 'Elevi route' })).toEqual([]);
    expect(classifyRoute({ route_short_name: 'ELEVI-99', route_long_name: '' })).toEqual([]);
  });

  it('classifies *U suffix + "(untold)" annotation as "Untold"', () => {
    expect(classifyRoute({ route_short_name: '30U', route_long_name: 'Grigorescu - IRA' }))
      .toEqual([{ id: 'festival', label: 'Untold' }]);
    // M26U is also metroline (M* prefix) -> 1:many.
    expect(classifyRoute({
      route_short_name: 'M26U',
      route_long_name: 'Uzinei Electrice - Floresti / Cetate (untold)',
    })).toEqual([
      { id: 'festival', label: 'Untold' },
      { id: 'metroline', label: 'Metropolitan' },
    ]);
    expect(classifyRoute({ route_short_name: '30U', route_long_name: 'Grigorescu - IRA Untold' }))
      .toEqual([{ id: 'festival', label: 'Untold' }]);
    expect(classifyRoute({ route_short_name: '99', route_long_name: '', route_desc: 'Untold festival' }))
      .toEqual([{ id: 'festival', label: 'Untold' }]);
  });

  it('classifies *N suffix + "Noapte" long_name as "Noapte"', () => {
    expect(classifyRoute({ route_short_name: '25N', route_long_name: 'Str. Bucium - Str. Unirii' }))
      .toEqual([{ id: 'night', label: 'Noapte' }]);
    expect(classifyRoute({ route_short_name: '5N', route_long_name: 'Noapte Traian Vuia' }))
      .toEqual([{ id: 'night', label: 'Noapte' }]);
    expect(classifyRoute({ route_short_name: '99', route_long_name: '', route_desc: 'Noapte special' }))
      .toEqual([{ id: 'night', label: 'Noapte' }]);
  });

  it('classifies A1 / Aeroport long_name as "Aeroport Expres"', () => {
    expect(classifyRoute({ route_short_name: 'A1', route_long_name: 'Piata Mihai Viteazu - Aeroport' }))
      .toEqual([{ id: 'airport', label: 'Aeroport Expres' }]);
    expect(classifyRoute({ route_short_name: '99', route_long_name: 'Some Route Aeroport Expres' }))
      .toEqual([{ id: 'airport', label: 'Aeroport Expres' }]);
    expect(classifyRoute({ route_short_name: '99', route_long_name: '', route_desc: 'aeroport shuttle' }))
      .toEqual([{ id: 'airport', label: 'Aeroport Expres' }]);
  });

  it('does NOT classify D51 as commuter (D51 is employee-only / convention, not public commuter)', () => {
    expect(classifyRoute({ route_short_name: 'D51', route_long_name: 'D51' })).toEqual([]);
    expect(classifyRoute({ route_short_name: 'D99', route_long_name: 'Anywhere' })).toEqual([]);
  });

  it('classifies M* as "Metropolitan"', () => {
    expect(classifyRoute({ route_short_name: 'M11', route_long_name: 'P-ta Cipariu - Feleacu' }))
      .toEqual([{ id: 'metroline', label: 'Metropolitan' }]);
    expect(classifyRoute({ route_short_name: 'M26', route_long_name: 'Floresti - Cluj Napoca' }))
      .toEqual([{ id: 'metroline', label: 'Metropolitan' }]);
  });

  it('classifies CS as "Cursa Speciala"', () => {
    expect(classifyRoute({ route_short_name: 'CS', route_long_name: 'CURSA SPECIALA' }))
      .toEqual([{ id: 'special', label: 'Cursa Speciala' }]);
    expect(classifyRoute({ route_short_name: 'CS', route_long_name: '', route_desc: 'CURSA SPECIALA' }))
      .toEqual([{ id: 'special', label: 'Cursa Speciala' }]);
  });

  it('returns 1:many for routes that match multiple tags (festival + metroline)', () => {
    // Synthetic 1:many case. e.g. an M26U-like route whose long_name
    // AND route_desc both carry tag signals. With school no longer
    // being a tag, the canonical 1:many case is festival + metroline.
    const result = classifyRoute({
      route_short_name: 'M26U',
      route_long_name: 'Uzinei Electrice - Floresti / Cetate (untold)',
      route_desc: 'Untold',
    });
    expect(result).toEqual([
      { id: 'festival', label: 'Untold' },
      { id: 'metroline', label: 'Metropolitan' },
    ]);
  });

  it('returns empty array for regular urban routes that match no tag', () => {
    expect(classifyRoute({ route_short_name: '1', route_long_name: 'Str. Bucium - P-ta 1 Mai' }))
      .toEqual([]);
    expect(classifyRoute({ route_short_name: '24', route_long_name: 'Str. Unirii - Str. Bucium' }))
      .toEqual([]);
    expect(classifyRoute({ route_short_name: '101', route_long_name: 'Tram line 101' }))
      .toEqual([]);
  });

  it('respects priority order (matches in CATEGORIES tag order)', () => {
    // 1:many results preserve CATEGORIES declaration order (filtered
    // to tag-surface entries). `special` is declared first, then
    // (school -- excluded, network), `festival`, `night`, `airport`,
    // `metroline`. `normal` is at the end (also excluded, network).
    const tagIds = CATEGORIES.filter((c) => c.surface === 'tag').map((c) => c.id);
    expect(tagIds).toEqual(['special', 'festival', 'night', 'airport', 'metroline']);
    // For a festival + metroline 1:many case, festival comes first
    // because it's declared earlier than metroline in CATEGORIES.
    const result = classifyRoute({
      route_short_name: 'M26U',
      route_long_name: 'Floresti / Cetate (untold)',
    });
    expect(result.map((c) => c.id)).toEqual(['festival', 'metroline']);
  });

  it('treats missing/undefined fields as empty strings', () => {
    expect(() => classifyRoute({})).not.toThrow();
    expect(classifyRoute({})).toEqual([]);
  });
});

describe('classifyNetwork — 1:1 network assignment', () => {
  // Per gtfs-adapters#26: every route belongs to exactly one of two
  // networks -- `school` (TE* short_name) or `normal` (everything
  // else). The 1:1 constraint of the public GTFS spec is satisfied
  // by construction.

  it('assigns school network to TE* short_name routes', () => {
    expect(classifyNetwork({ route_short_name: 'TE1' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyNetwork({ route_short_name: 'TE14', route_long_name: 'whatever' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyNetwork({ route_short_name: 'TE-OG' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('assigns normal network to non-TE routes (including M7x, CS, regular urban)', () => {
    expect(classifyNetwork({ route_short_name: '1' }))
      .toEqual({ id: 'normal', label: 'Normal' });
    expect(classifyNetwork({ route_short_name: 'M76A', route_long_name: 'TE2 Floresti str. Somesului' }))
      .toEqual({ id: 'normal', label: 'Normal' });
    expect(classifyNetwork({ route_short_name: 'CS' }))
      .toEqual({ id: 'normal', label: 'Normal' });
    expect(classifyNetwork({ route_short_name: '25N' }))
      .toEqual({ id: 'normal', label: 'Normal' });
    expect(classifyNetwork({ route_short_name: 'A1' }))
      .toEqual({ id: 'normal', label: 'Normal' });
  });

  it('does not classify based on long_name (the school network is short_name-only)', () => {
    // The M7x family has "TE\d+ Floresti" in long_name -- that used
    // to flag school. Under the new model, school is short_name-only,
    // so the M7x family is normal network.
    expect(classifyNetwork({ route_short_name: 'M76A', route_long_name: 'TE2 Floresti str. Somesului' }))
      .toEqual({ id: 'normal', label: 'Normal' });
    expect(classifyNetwork({ route_short_name: '99', route_long_name: 'Some elevi variant' }))
      .toEqual({ id: 'normal', label: 'Normal' });
  });

  it('treats missing/undefined fields as empty strings (falls back to normal)', () => {
    expect(classifyNetwork({})).toEqual({ id: 'normal', label: 'Normal' });
    expect(classifyNetwork({ route_short_name: undefined, route_long_name: 'foo' }))
      .toEqual({ id: 'normal', label: 'Normal' });
  });
});

describe('cleanLongName — start-end format', () => {
  it('strips trailing parenthetical annotations', () => {
    expect(cleanLongName({ route_short_name: 'M26U', route_long_name: 'Uzinei Electrice - Floresti / Cetate (untold)' }))
      .toBe('Uzinei Electrice - Floresti / Cetate');
    expect(cleanLongName({ route_short_name: '88A', route_long_name: 'Floresti Cetate - Emerson (traseu M21)' }))
      .toBe('Floresti Cetate - Emerson');
    expect(cleanLongName({ route_short_name: 'M26N', route_long_name: 'Floresti - Cluj Napoca' }))
      .toBe('Floresti - Cluj Napoca');
  });

  it('strips "Transport Elevi -" / "Transport Elevi " prefix for school routes', () => {
    expect(cleanLongName({ route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur' }))
      .toBe('Manastur');
    expect(cleanLongName({ route_short_name: 'TE6', route_long_name: 'Transport Elevi-Manastur - Kogalniceanu' }))
      .toBe('Manastur - Kogalniceanu');
    expect(cleanLongName({ route_short_name: 'TE7', route_long_name: 'Transport Elevi-Bucium - Kogalniceanu' }))
      .toBe('Bucium - Kogalniceanu');
  });

  it('strips "TE\\d+ Floresti" prefix from M7x school routes', () => {
    // Kept even though M7x routes are no longer classified as school
    // (the cleanup pass still strips the Tranzy noise from long_name
    // -- the routing taxonomy is independent of the cleanup pass).
    expect(cleanLongName({ route_short_name: 'M76A', route_long_name: 'TE2 Floresti str. Somesului' }))
      .toBe('str. Somesului');
    expect(cleanLongName({ route_short_name: 'M79A', route_long_name: 'TE5 Floresti Tauti Floresti' }))
      .toBe('Tauti Floresti');
  });

  it('clears long_name for CS (no fixed endpoints to describe)', () => {
    expect(cleanLongName({ route_short_name: 'CS', route_long_name: 'CURSA SPECIALA' })).toBe('');
  });

  it('returns start-end unchanged when already clean', () => {
    expect(cleanLongName({ route_short_name: '1', route_long_name: 'Str. Bucium - P-ta 1 Mai' }))
      .toBe('Str. Bucium - P-ta 1 Mai');
    expect(cleanLongName({ route_short_name: '25', route_long_name: 'Str. Bucium - Str. Unirii' }))
      .toBe('Str. Bucium - Str. Unirii');
  });

  it('handles empty/undefined long_name gracefully', () => {
    expect(cleanLongName({ route_short_name: '1' })).toBe('');
    expect(cleanLongName({ route_short_name: '1', route_long_name: '' })).toBe('');
  });

  it('trims whitespace', () => {
    expect(cleanLongName({ route_short_name: '1', route_long_name: '  Str. Bucium - P-ta 1 Mai  ' }))
      .toBe('Str. Bucium - P-ta 1 Mai');
  });
});

describe('deriveLongNameFromStops — fallback when cleanup leaves long_name empty', () => {
  // Minimal shape — only fields actually used.
  const stopsByStopId = new Map([
    ['A', { stop_name: 'Piata Garii' }],
    ['B', { stop_name: 'Sala Sporturilor' }],
    ['C', { stop_name: 'Cart. Zorilor' }],
    ['D', { stop_name: 'Gara' }],
    ['E', { stop_name: 'Selimbar' }],
    ['Z', { stop_name: 'Circular Start' }],
  ]);

  it('returns "<first> - <last>" from the longest trip of the route', () => {
    const allStopTimeRows = [
      // Short trip (2 stops) for route 35
      { trip_id: 'short', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 'short', stop_id: 'B', stop_sequence: 1 },
      // Long trip (3 stops) — should win
      { trip_id: 'long', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 'long', stop_id: 'B', stop_sequence: 1 },
      { trip_id: 'long', stop_id: 'C', stop_sequence: 2 },
    ];
    const tripToRoute = new Map([['short', '35'], ['long', '35']]);
    expect(deriveLongNameFromStops({
      routeId: '35', allStopTimeRows, tripToRoute, stopsByStopId,
    })).toBe('Piata Garii - Cart. Zorilor');
  });

  it('returns "" when no stop_times exist for the route', () => {
    const allStopTimeRows = [{ trip_id: 't1', stop_id: 'A', stop_sequence: 0 }];
    const tripToRoute = new Map([['t1', 'OTHER']]);
    expect(deriveLongNameFromStops({
      routeId: '35', allStopTimeRows, tripToRoute, stopsByStopId,
    })).toBe('');
  });

  it('returns "" when first/last stop ids do not resolve to names', () => {
    const allStopTimeRows = [
      { trip_id: 't1', stop_id: 'UNKNOWN1', stop_sequence: 0 },
      { trip_id: 't1', stop_id: 'UNKNOWN2', stop_sequence: 1 },
    ];
    const tripToRoute = new Map([['t1', '35']]);
    expect(deriveLongNameFromStops({
      routeId: '35', allStopTimeRows, tripToRoute, stopsByStopId,
    })).toBe('');
  });

  it('returns "" for circular services (first stop == last stop)', () => {
    // Pin against emitting "X - X" which would mislead users.
    const allStopTimeRows = [
      { trip_id: 't1', stop_id: 'Z', stop_sequence: 0 },
      { trip_id: 't1', stop_id: 'Z', stop_sequence: 1 },
    ];
    const tripToRoute = new Map([['t1', 'CIRC']]);
    expect(deriveLongNameFromStops({
      routeId: 'CIRC', allStopTimeRows, tripToRoute, stopsByStopId,
    })).toBe('');
  });

  it('returns "" for single-stop trips (no start/end to extract)', () => {
    const allStopTimeRows = [
      { trip_id: 't1', stop_id: 'A', stop_sequence: 0 },
    ];
    const tripToRoute = new Map([['t1', '35']]);
    expect(deriveLongNameFromStops({
      routeId: '35', allStopTimeRows, tripToRoute, stopsByStopId,
    })).toBe('');
  });

  it('returns "" when inputs are missing (defensive)', () => {
    expect(deriveLongNameFromStops({})).toBe('');
  });
});

describe('cleanDesc — symmetric cleanup with cleanLongName', () => {
  it('strips the same parentheticals cleanLongName does', () => {
    expect(cleanDesc({ route_short_name: '88A', route_desc: 'Floresti Cetate - Emerson (traseu M21)' }))
      .toBe('Floresti Cetate - Emerson');
    expect(cleanDesc({ route_short_name: 'M26U', route_desc: 'Uzinei Electrice - Floresti / Cetate (untold)' }))
      .toBe('Uzinei Electrice - Floresti / Cetate');
  });

  it('strips "Transport Elevi -" / "Transport Elevi " prefix', () => {
    expect(cleanDesc({ route_short_name: 'TE1', route_desc: 'Transport Elevi Manastur' }))
      .toBe('Manastur');
  });

  it('clears desc for CS (matches cleanLongName behavior)', () => {
    expect(cleanDesc({ route_short_name: 'CS', route_desc: 'CURSA SPECIALA' })).toBe('');
  });

  it('handles missing/undefined desc gracefully', () => {
    expect(cleanDesc({ route_short_name: '1' })).toBe('');
    expect(cleanDesc({ route_short_name: '1', route_desc: '' })).toBe('');
  });

  it('preserves clean descs unchanged (D51-style useful endpoint info)', () => {
    // D51's desc from Tranzy is " P-ta Mihai Viteazu - Gilau" — already
    // clean (no parentheticals, no Transport Elevi prefix, no TE-? noise).
    // The cleanup pass leaves it intact so the orchestrator can use it
    // as route_desc when no tag matches.
    expect(cleanDesc({ route_short_name: 'D51', route_desc: ' P-ta Mihai Viteazu - Gilau' }))
      .toBe('P-ta Mihai Viteazu - Gilau');
  });
});

describe('applyRouteCategory — orchestrator entry point', () => {
  const stopsByStopId = new Map([
    ['A', { stop_name: 'Piata Garii' }],
    ['B', { stop_name: 'Sala Sporturilor' }],
    ['C', { stop_name: 'Cart. Zorilor' }],
  ]);

  function setup() {
    const allStopTimeRows = [
      { trip_id: 't-93', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-93', stop_id: 'B', stop_sequence: 1 },
      { trip_id: 't-93', stop_id: 'C', stop_sequence: 2 },
      { trip_id: 't-1',  stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-1',  stop_id: 'C', stop_sequence: 1 },
    ];
    const tripToRoute = new Map([['t-93', '93'], ['t-1', '1']]);
    const routes = [
      { route_id: '93', route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur', route_desc: '' },
      { route_id: '1',  route_short_name: '1',  route_long_name: 'Str. Bucium - P-ta 1 Mai',   route_desc: '' },
      // Route with empty long_name (e.g. Tranzy never published one).
      // Should fall back to stop_times.
      { route_id: '99', route_short_name: '99', route_long_name: '', route_desc: '' },
    ];
    return { routes, allStopTimeRows, tripToRoute };
  }

  it('classifies long_name + network + route_desc per the new model (gtfs-adapters#26)', () => {
    // TE1: school NETWORK (because TE*), no tags, so route_desc is
    // just the school label ("Transport Elevi") -- the network label
    // is always in route_desc under the new design.
    // Route 1: normal network, no tags, no useful desc, route_desc
    // is just "Normal" (network label only).
    // Route 99: normal network, no tags, no long_name (uses stops fallback).
    const { routes, allStopTimeRows, tripToRoute } = setup();
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.classifiedCount).toBe(0); // no route is tagged
    expect(result.multiTagCount).toBe(0);
    expect(result.networkCounts.school).toBe(1); // TE1
    expect(result.networkCounts.normal).toBe(2); // 1 and 99
    expect(routes[0].route_long_name).toBe('Manastur');
    // route_desc = network label (school). The school designation
    // is still visible in route_desc; route_networks.txt carries
    // the structured join.
    expect(routes[0].route_desc).toBe('Transport Elevi');
    expect(routes[1].route_long_name).toBe('Str. Bucium - P-ta 1 Mai');
    // Regular urban: route_desc is the network label only ("Normal").
    expect(routes[1].route_desc).toBe('Normal');
    // routeNetworks map: 1:1 by route_id, every route assigned.
    expect(result.routeNetworks.get('93')).toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(result.routeNetworks.get('1')).toEqual({ id: 'normal', label: 'Normal' });
    expect(result.routeNetworks.get('99')).toEqual({ id: 'normal', label: 'Normal' });
    // routeTags map: empty (no route is tagged in this fixture).
    expect(result.routeTags.size).toBe(0);
  });

  it('handles 1:many tag cases via route_desc comma-join (no school tag)', () => {
    // Regression test for the order-change. If classification ran AFTER
    // cleanup, signals embedded in long_name (e.g. "Transport Elevi" or
    // a parenthetical) would be stripped before classification could
    // match them. The 1:many route here exercises a long_name signal
    // ("untold" in parens) plus a short_name signal (M* prefix for
    // metroline) -- both must survive. School is intentionally NOT
    // part of the 1:many result anymore.
    const allStopTimeRows = [
      { trip_id: 't-145', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-145', stop_id: 'B', stop_sequence: 1 },
    ];
    const tripToRoute = new Map([['t-145', '145']]);
    const routes = [
      {
        route_id: '145',
        route_short_name: 'M26U',
        route_long_name: 'Some Endpoint - Liceul X (untold)',
        route_desc: '',
      },
    ];
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.classifiedCount).toBe(1); // 1 route tagged
    expect(result.multiTagCount).toBe(1); // with 2 tags
    expect(result.networkCounts.normal).toBe(1); // M26U is not TE* -> normal
    // route_desc = network + tag labels (comma-joined). The network
    // label is first, then tags in CATEGORIES order: festival
    // (Untold) before metroline (Metropolitan).
    expect(routes[0].route_desc).toBe('Normal, Untold, Metropolitan');
  });

  it('falls back to stop_times when long_name is empty after cleanup', () => {
    // Build a fresh scenario where route 99 has empty long_name AND
    // matching stop_times available.
    const allStopTimeRows = [
      { trip_id: 't-99', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-99', stop_id: 'B', stop_sequence: 1 },
      { trip_id: 't-99', stop_id: 'C', stop_sequence: 2 },
    ];
    const tripToRoute = new Map([['t-99', '99']]);
    const routes = [
      { route_id: '99', route_short_name: '99', route_long_name: '', route_desc: '' },
    ];
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.longNameDerivedCount).toBe(1);
    expect(result.longNameUnresolvedCount).toBe(0);
    expect(routes[0].route_long_name).toBe('Piata Garii - Cart. Zorilor');
  });

  it('falls back when route has empty long_name AND stop_times available', () => {
    const allStopTimeRows = [
      { trip_id: 't-99', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-99', stop_id: 'B', stop_sequence: 1 },
      { trip_id: 't-99', stop_id: 'C', stop_sequence: 2 },
    ];
    const tripToRoute = new Map([['t-99', '99']]);
    const routes = [
      { route_id: '99', route_short_name: '99', route_long_name: '', route_desc: '' },
    ];
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.longNameDerivedCount).toBe(1);
    expect(routes[0].route_long_name).toBe('Piata Garii - Cart. Zorilor');
  });

  it('counts unresolved routes (empty long_name AND no stop_times fallback)', () => {
    const routes = [
      { route_id: '99', route_short_name: '99', route_long_name: '', route_desc: '' },
    ];
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows: [], tripToRoute: new Map(), stopsByStopId, warnings,
    });
    expect(result.longNameUnresolvedCount).toBe(1);
    expect(routes[0].route_long_name).toBe('');
  });

  it('emits an INFO warning summarizing tagged / cleaned / derived counts + network counts', () => {
    // Fixture: TE1 (school network, no tag) + route 1 (normal, no tag).
    // Neither is tagged, so classifiedCount = 0, but the network
    // counts and the long_name/desc cleanup counts still surface
    // in the INFO line.
    const { routes, allStopTimeRows, tripToRoute } = setup();
    const warnings = [];
    applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    const info = warnings.find((w) => w.severity === 'info' && w.message.startsWith('routes:'));
    expect(info).toBeDefined();
    expect(info.message).toMatch(/tagged 0 route/);
    expect(info.message).toMatch(/networked 1 school \+ 2 normal/);
    expect(info.message).toMatch(/cleaned 1 long_name/);
  });

  it('emits multi-tag count in INFO when 1:many cases fire', () => {
    // Synthetic 1:many case: short_name M* (metroline) + long_name
    // with "untold" (festival). 1:many via tag surface, not network.
    const allStopTimeRows = [];
    const tripToRoute = new Map();
    const routes = [
      { route_id: '145', route_short_name: 'M26U', route_long_name: 'Some Endpoint - Liceul X (untold)', route_desc: '' },
      { route_id: '146', route_short_name: 'M99U', route_long_name: 'Other Endpoint - Scoala Y (untold)', route_desc: '' },
    ];
    const warnings = [];
    applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    const info = warnings.find((w) => w.severity === 'info' && w.message.startsWith('routes:'));
    expect(info.message).toMatch(/2 with multiple tags/);
  });

  it('does not emit a warning when nothing changes', () => {
    // After the desc-preservation change, this fixture does fire an
    // INFO warning ("preserved 1 desc on un-tagged routes"). To get
    // the no-warning case, all the desc needs to be empty too.
    const allStopTimeRows = [{ trip_id: 't-1', stop_id: 'A', stop_sequence: 0 }];
    const tripToRoute = new Map([['t-1', '1']]);
    const routes = [
      { route_id: '1', route_short_name: '1', route_long_name: 'A - B', route_desc: '' },
    ];
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.classifiedCount).toBe(0);
    expect(result.longNameCleanedCount).toBe(0);
    expect(result.descCleanedCount).toBe(0);
    expect(result.descFromCleanedCount).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe('applyRouteCategory — desc strategy', () => {
  // Pin the new behavior: for un-tagged routes, route_desc keeps
  // the descriptive text from Tranzy (after cleanup). For tagged
  // routes, route_desc is overwritten with the comma-joined tag
  // labels (school is NOT a tag label under the new model).
  // This avoids the previous data loss for D51 / M75A / etc. where
  // blind overwriting cleared Tranzy's endpoint info.

  const stopsByStopId = new Map([
    ['A', { stop_name: 'Piata Garii' }],
    ['B', { stop_name: 'Cart. Zorilor' }],
  ]);

  it('preserves cleaned desc as route_desc when no tag matches (D51 case)', () => {
    // D51 is un-tagged (employee-only service, no public tag
    // pattern). Its Tranzy desc "P-ta Mihai Viteazu - Gilau" should
    // survive as the desc portion of route_desc, joined with the
    // network label via " | " so consumers see BOTH the operator
    // identity AND the endpoint info.
    const routes = [
      { route_id: '190', route_short_name: 'D51', route_long_name: 'D51', route_desc: ' P-ta Mihai Viteazu - Gilau' },
    ];
    const warnings = [];
    const result = applyRouteCategory({ routes, warnings });
    expect(result.classifiedCount).toBe(0);
    expect(result.descFromCleanedCount).toBe(1);
    // Network label first, then the unique cleaned desc joined by " | ".
    expect(routes[0].route_desc).toBe('Normal | P-ta Mihai Viteazu - Gilau');
  });

  it('TE1 route_desc = school label + cleaned desc via " | " (network is in desc)', () => {
    // Under the new design, the network label IS in route_desc --
    // it's the operator identity surface. So TE1's route_desc is
    // "Transport Elevi" (school network label) + the cleaned desc
    // joined by " | ". The school designation is in BOTH
    // route_networks.txt (the structured join) and route_desc (the
    // human-readable surface).
    const routes = [
      { route_id: '93', route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur', route_desc: 'Some endpoint desc' },
    ];
    const warnings = [];
    const result = applyRouteCategory({ routes, warnings });
    expect(result.routeNetworks.get('93')).toEqual({ id: 'school', label: 'Transport Elevi' });
    // School label first, then the cleaned desc (un-tagged, but
    // desc has unique info -> joins via " | ").
    expect(routes[0].route_desc).toBe('Transport Elevi | Some endpoint desc');
  });

  it('uses cleaned desc when long_name is empty but desc has data (M75A case)', () => {
    // M75A scenario: TE1 Floresti long_name gets stripped to empty,
    // so long_name falls back to the cleaned desc. Note: the parenthetical
    // in this desc is mid-string (not trailing), so the cleanup regex
    // — which only strips TRAILING parentheticals — leaves it intact.
    // That's the intended behavior — mid-string " (Floresti)" is
    // meaningful content, not annotation noise.
    //
    // Under the new model, M75A is metroline-only tag (school is
    // network-only and the M7x long_name TE prefix is no longer a
    // school signal). route_desc is the network label + the metroline
    // tag -- not "Transport Elevi, Metropolitan" as before.
    const routes = [
      {
        route_id: '144',
        route_short_name: 'M75A',
        route_long_name: 'TE1 Floresti',
        route_desc: 'Avram Iancu (Floresti) - Liceul DumitruTautan',
      },
    ];
    const warnings = [];
    const result = applyRouteCategory({ routes, warnings });
    // Network = normal (M75A is not TE*); tags = [metroline] only.
    expect(result.routeNetworks.get('144')).toEqual({ id: 'normal', label: 'Normal' });
    expect(result.routeTags.get('144')).toEqual([
      { id: 'metroline', label: 'Metropolitan', priority: 0 },
    ]);
    // long_name falls back to cleaned desc (parenthetical preserved)
    expect(routes[0].route_long_name).toBe('Avram Iancu (Floresti) - Liceul DumitruTautan');
    // desc = network label + tag label, comma-joined.
    expect(routes[0].route_desc).toBe('Normal, Metropolitan');
  });

  it('falls through to stop_times when both long_name and desc are empty (CS case)', () => {
    const allStopTimeRows = [
      { trip_id: 't-cs', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-cs', stop_id: 'B', stop_sequence: 1 },
    ];
    const tripToRoute = new Map([['t-cs', '205']]);
    const routes = [
      { route_id: '205', route_short_name: 'CS', route_long_name: 'CURSA SPECIALA', route_desc: '' },
    ];
    const warnings = [];
    const result = applyRouteCategory({ routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings });
    // CS is in the `special` tag -- here special is the only tag.
    // Network = normal (CS is not TE*). route_desc = network + tag.
    expect(routes[0].route_desc).toBe('Normal, Cursa Speciala');
    // long_name cleared by CS rule, desc is empty -> fallback to stops
    expect(routes[0].route_long_name).toMatch(/^.+ - .+$/);
  });

  it('captures parenthetical content from long_name cleanup into desc for un-tagged routes (88A case)', () => {
    // The signature example from PR review. Route 88A is un-tagged
    // (88A starts with 8, not M, so no metroline match). Tranzy's
    // long_name + desc are identical: "Floresti Cetate - Emerson (traseu M21)".
    // After cleanup, the parenthetical "traseu M21" is stripped from
    // long_name (-> "Floresti Cetate - Emerson"). The stripped content
    // becomes the desc since cleanedDesc happens to match cleanedLong
    // (no unique info there) AND we want the parenthetical surfaced
    // as informational annotation.
    const routes = [
      {
        route_id: '88',
        route_short_name: '88A',
        route_long_name: 'Floresti Cetate - Emerson (traseu M21)',
        route_desc: 'Floresti Cetate - Emerson (traseu M21)',
      },
    ];
    const warnings = [];
    applyRouteCategory({ routes, warnings });
    // Both fields had the same content, so cleanedDesc == cleanedLong.
    // The parenthetical content is the only unique info. route_desc
    // is the network label + parenthetical joined via " | ".
    expect(routes[0].route_long_name).toBe('Floresti Cetate - Emerson');
    expect(routes[0].route_desc).toBe('Normal | Traseu M21');
  });

  it('combines cleaned desc with stripped parenthetical when both contribute unique info', () => {
    // Synthesize: cleanedDesc has unique info AND long_name has a
    // stripped parenthetical. Both should land in desc with a separator.
    // Terminals use 4+ char tokens ("Garii", "Campului", "Someșului")
    // so the structural-check heuristic can find them on the route
    // pattern via tokenOverlap.
    const routes = [
      {
        route_id: 'X',
        route_short_name: 'X1',
        route_long_name: 'P-ta Garii - Str. Somesului (note 1)',
        route_desc: 'P-ta Garii - Str. Campului',
      },
    ];
    // Build a minimal stop_times fixture where the desc's terminals
    // ("P-ta Garii" + "Str. Campului") ARE on the route pattern.
    const allStopTimeRows = [
      { trip_id: 't-X-a', stop_id: 'S1', stop_sequence: 0 },
      { trip_id: 't-X-a', stop_id: 'S2', stop_sequence: 1 },
      { trip_id: 't-X-a', stop_id: 'S3', stop_sequence: 2 },
    ];
    const tripToRoute = new Map([['t-X-a', 'X']]);
    const stopsByStopId = new Map([
      ['S1', { stop_name: 'P-ta Garii' }],
      ['S2', { stop_name: 'Str. Campului' }],
      ['S3', { stop_name: 'Str. Somesului' }],
    ]);
    const warnings = [];
    applyRouteCategory({ routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings });
    expect(routes[0].route_long_name).toBe('P-ta Garii - Str. Somesului');
    // Network label first, then cleaned desc + parenthetical joined by " | ".
    expect(routes[0].route_desc).toBe('Normal | P-ta Garii - Str. Campului | Note 1');
  });

  it('title-cases parenthetical content (lowercase first letter -> caps)', () => {
    // "(traseu M21)" -> "Traseu M21". Uses "(traseu M21)" rather than
    // "(untold)" because the latter would tag the route as festival
    // before cleanup, defeating the test purpose.
    const routes = [
      {
        route_id: 'X',
        route_short_name: 'X1',
        route_long_name: 'Endpoint A - Endpoint B (traseu M21)',
        route_desc: 'Some unique desc',
      },
    ];
    const warnings = [];
    applyRouteCategory({ routes, warnings });
    // Network label "Normal" + cleaned desc "Some unique desc" + parenthetical "Traseu M21".
    expect(routes[0].route_desc).toBe('Normal | Some unique desc | Traseu M21');
  });

  it('filters out stripped content that matches a tag label (defensive)', () => {
    // The category-filter guard in desc-building is defensive: when a
    // parenthetical happens to contain text that matches a tag label
    // (case-insensitive) but the route isn't otherwise tagged, we
    // drop it from desc so we don't accidentally surface a tag
    // signal that classification declined to apply.
    //
    // Construction: short_name "X1" doesn't trigger any short_name
    // regex. long_name uses "(Metropolitan)" — the metroline pattern
    // is `/^M\d/.test(short_name)`, NOT a substring check on
    // long_name, so the route reaches the un-tagged branch.
    // The filter catches "Metropolitan" against the metroline label
    // "Metropolitan" and drops it.
    //
    // (Why not "(Noapte)" or "(Untold)"? The night and festival
    // patterns do substring-check long_name, so those would
    // tag the route before reaching the filter — defeating the
    // test.)
    const routes = [
      {
        route_id: 'X',
        route_short_name: 'X1',
        route_long_name: 'Endpoint A - Endpoint B (Metropolitan)',
        route_desc: 'Some desc',
      },
    ];
    const warnings = [];
    applyRouteCategory({ routes, warnings });
    expect(routes[0].route_long_name).toBe('Endpoint A - Endpoint B');
    // Network label "Normal" + cleaned desc "Some desc" joined by " | ".
    // "Metropolitan" is still filtered out from the parenthetical pool.
    expect(routes[0].route_desc).toBe('Normal | Some desc');
  });

  it('dedupes stripped content when both fields capture the same parenthetical', () => {
    // 88A case again — Tranzy duplicated "(traseu M21)" in both
    // long_name and desc. The capture should dedupe so the desc
    // doesn't show "Traseu M21 | Traseu M21".
    const routes = [
      {
        route_id: '88',
        route_short_name: '88A',
        route_long_name: 'A - B (traseu M21)',
        route_desc: 'A - B (traseu M21)',
      },
    ];
    const warnings = [];
    applyRouteCategory({ routes, warnings });
    expect(routes[0].route_long_name).toBe('A - B');
    // Network label + deduped parenthetical joined by " | ".
    // Single "Traseu M21", not duplicated.
    expect(routes[0].route_desc).toBe('Normal | Traseu M21');
  });

  it('drops stale long_name variant from desc (Tranzy desc has different destination than long_name)', () => {
    // Live-data bug: Tranzy publishes a desc whose terminal pair differs
    // from long_name (e.g. line was restructured, only one of the two
    // got updated). Without the stale-detection guard, cleanedDesc !=
    // cleanedLong would surface the contradictory terminal to consumers
    // (route 23's long_name="P-ta M. Viteazul - C.U.G" but
    // desc="P-ta M. Viteazul - EMERSON" — confusing riders).
    const routes = [
      {
        route_id: '23',
        route_short_name: '23',
        route_long_name: 'P-ta M. Viteazul - C.U.G',
        route_desc: 'P-ta M. Viteazul - EMERSON',
      },
      {
        route_id: '21',
        route_short_name: '21',
        route_long_name: 'P-ta M. Viteazul Vest - Dacia Service',
        route_desc: 'P-ta M. Viteazul - Cart. Buna Ziua',
      },
      // Parenthetical content (88A): the heuristic must NOT drop this,
      // because the "(traseu M21)" annotation is real info.
      {
        route_id: '88A',
        route_short_name: '88A',
        route_long_name: 'A - B (traseu M21)',
        route_desc: 'A - B (traseu M21)',
      },
      // D51: long_name is just a code, desc has the real terminal info.
      // The heuristic must NOT drop this.
      {
        route_id: 'D51',
        route_short_name: 'D51',
        route_long_name: 'D51',
        route_desc: 'P-ta Mihai Viteazu - Gilau',
      },
    ];
    const warnings = [];
    applyRouteCategory({ routes, warnings });
    // 23 and 21: stale variants dropped. route_desc falls through
    // to the network label only ("Normal") -- no unique info to
    // surface from the stale desc.
    expect(routes[0].route_desc).toBe('Normal'); // route 23
    expect(routes[1].route_desc).toBe('Normal'); // route 21
    // 88A: parenthetical content preserved. route_desc = network | parenthetical.
    expect(routes[2].route_desc).toBe('Normal | Traseu M21');
    // D51: terminal info preserved (long_name is just the code).
    // route_desc = network | cleaned desc.
    expect(routes[3].route_desc).toBe('Normal | P-ta Mihai Viteazu - Gilau');
  });

  it('keeps desc when its terminal IS on the route pattern (structural validation)', () => {
    // Stronger fix than the format-only check: when the desc's second
    // terminal DOES appear on the route's actual stop pattern, the
    // operator intentionally references that stop — keep the desc.
    //
    // Synthesized: route "X" with stop_names {P-ta Floresti, Pod Someșeni,
    // EMERSON}. The desc's second terminal is "EMERSON" — appears on
    // the pattern → keep.
    const routes = [
      {
        route_id: 'X',
        route_short_name: 'X1',
        route_long_name: 'P-ta Floresti - Pod Someșeni',
        route_desc: 'P-ta Floresti - EMERSON', // EMERSON is a real stop on this route
      },
    ];
    const allStopTimeRows = [
      { trip_id: 't-X-a', stop_id: 'X1', stop_sequence: 0 },
      { trip_id: 't-X-a', stop_id: 'X2', stop_sequence: 1 },
      { trip_id: 't-X-a', stop_id: 'X3', stop_sequence: 2 },
    ];
    const tripToRoute = new Map([['t-X-a', 'X']]);
    const stopsByStopId = new Map([
      ['X1', { stop_name: 'P-ta Floresti' }],
      ['X2', { stop_name: 'Pod Someșeni' }],
      ['X3', { stop_name: 'EMERSON' }],
    ]);
    const warnings = [];
    applyRouteCategory({ routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings });
    // EMERSON is on the route → desc is valid → preserved.
    // route_desc = network label | cleaned desc.
    expect(routes[0].route_desc).toBe('Normal | P-ta Floresti - EMERSON');
  });

  it('drops desc when its terminal is NOT on the route pattern (structural validation)', () => {
    // Stronger fix: when the desc's second terminal does NOT appear on
    // the route's pattern at all, it's stale — the operator's desc
    // references a stop this line doesn't serve.
    //
    // Synthesized: route "23" with stop_names {P-ta M. Viteazul, C.U.G}.
    // The desc says "P-ta M. Viteazul - EMERSON" but EMERSON isn't on
    // route 23's pattern (it IS on route 52L's pattern, but that
    // doesn't count) → desc is stale.
    const routes = [
      {
        route_id: '23',
        route_short_name: '23',
        route_long_name: 'P-ta M. Viteazul - C.U.G',
        route_desc: 'P-ta M. Viteazul - EMERSON', // EMERSON not on route 23
      },
    ];
    const allStopTimeRows = [
      { trip_id: 't-23-a', stop_id: 'S1', stop_sequence: 0 },
      { trip_id: 't-23-a', stop_id: 'S2', stop_sequence: 1 },
    ];
    const tripToRoute = new Map([['t-23-a', '23']]);
    const stopsByStopId = new Map([
      ['S1', { stop_name: 'P-ta M. Viteazul' }],
      ['S2', { stop_name: 'C.U.G' }],
      // EMERSON exists in the network (e.g. route 52L), but NOT here.
    ]);
    const warnings = [];
    applyRouteCategory({ routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings });
    // EMERSON is not on this route → desc is stale → dropped.
    // route_desc falls through to the network label only.
    expect(routes[0].route_desc).toBe('Normal');
  });

  it('appends non-tag parenthetical to tagged routes (metroline + Floresti)', () => {
    // Under the new model, a TE-prefixed short_name ("TE1F") is the
    // school network (no tag). A non-TE-prefixed short_name ("M75B")
    // with a TE prefix in long_name ("TE1F") is metroline-only.
    // Here we test the metroline + Floresti parenthetical case: the
    // route is tagged as metroline, the desc has "(Floresti)" which
    // is non-redundant (Floresti isn't a tag label), so it joins
    // the network + tag labels via " | ".
    const routes = [
      {
        route_id: 'M75B',
        route_short_name: 'M75B',
        route_long_name: 'str. Avram Iancu - Liceul Dumitru Tautan (Floresti)',
        route_desc: '',
      },
    ];
    const warnings = [];
    const result = applyRouteCategory({ routes, warnings });
    // Network = normal (M75B is not TE*); tags = [metroline].
    expect(result.routeNetworks.get('M75B')).toEqual({ id: 'normal', label: 'Normal' });
    expect(result.routeTags.get('M75B')).toEqual([
      { id: 'metroline', label: 'Metropolitan', priority: 0 },
    ]);
    // Network label + tag label + non-redundant parenthetical joined
    // with " | ".
    expect(routes[0].route_desc).toBe('Normal, Metropolitan | Floresti');
  });
});

describe('getAllCategories / getAllTags / getAllNetworks — surface accessors', () => {
  it('getAllCategories returns the full list with surface flag', () => {
    const all = getAllCategories();
    expect(all.length).toBe(CATEGORIES.length);
    for (const c of all) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('label');
      expect(c).toHaveProperty('surface');
      expect(['tag', 'network']).toContain(c.surface);
    }
  });

  it('getAllTags returns tag-surface entries only (excludes networks)', () => {
    const tags = getAllTags();
    const tagIds = tags.map((c) => c.id);
    expect(tagIds).toEqual(['special', 'festival', 'night', 'airport', 'metroline']);
    for (const t of tags) {
      expect(t.surface).toBe('tag');
    }
  });

  it('getAllNetworks returns network-surface entries only (school + normal)', () => {
    const nets = getAllNetworks();
    const netIds = nets.map((c) => c.id);
    expect(netIds).toEqual(['school', 'normal']);
    for (const n of nets) {
      expect(n.surface).toBe('network');
    }
  });

  it('exposes the tag ids neary will need to render', () => {
    const ids = getAllTags().map((c) => c.id);
    expect(ids).toContain('festival');
    expect(ids).toContain('night');
    expect(ids).toContain('airport');
    expect(ids).toContain('metroline');
    expect(ids).toContain('special');
    // School is a network, not a tag.
    expect(ids).not.toContain('school');
    expect(ids).not.toContain('normal');
    // Commuter was removed — D51 isn't a public commuter rail route.
    expect(ids).not.toContain('commuter');
  });

  it('exposes the network ids neary will need to render', () => {
    const ids = getAllNetworks().map((c) => c.id);
    expect(ids).toContain('school');
    expect(ids).toContain('normal');
    // Tags are not networks.
    expect(ids).not.toContain('special');
    expect(ids).not.toContain('festival');
    expect(ids).not.toContain('night');
    expect(ids).not.toContain('airport');
    expect(ids).not.toContain('metroline');
  });

  it('uses Romanian labels (matches ctpcj.ro terminology)', () => {
    const labels = Object.fromEntries(getAllCategories().map((c) => [c.id, c.label]));
    expect(labels.night).toBe('Noapte');
    expect(labels.metroline).toBe('Metropolitan');
    expect(labels.school).toBe('Transport Elevi');
    expect(labels.festival).toBe('Untold');
    expect(labels.airport).toBe('Aeroport Expres');
    expect(labels.special).toBe('Cursa Speciala');
    expect(labels.normal).toBe('Normal');
  });
});
