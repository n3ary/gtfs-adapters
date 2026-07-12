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

describe('classifyRoute -- tag-surface pattern -> category', () => {
  // classifyRoute returns tag matches only (not networks). School is
  // a network under the new model (gtfs-adapters#26), not a tag, so
  // school-classified routes return [] for tags.

  it('classifies TE-prefixed school buses as school network (no tag match)', () => {
    // School is a network, not a tag. TE* short_name matches the
    // school network; classifyRoute returns no tags. The school
    // designation lives in route_networks.txt + (via the empty-desc
    // fallback) route_desc.
    expect(classifyRoute({ route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur' })).toEqual([]);
    expect(classifyNetwork({ route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyRoute({ route_short_name: 'TE14' })).toEqual([]);
    expect(classifyNetwork({ route_short_name: 'TE14' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyRoute({ route_short_name: 'TE-OG' })).toEqual([]);
    expect(classifyNetwork({ route_short_name: 'TE-OG' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('classifies M7x routes as school network + metroline tag (broad school match)', () => {
    // The M7x school-bus family has "TE\d+ Floresti" in long_name.
    // Under the broad school match, this counts as school network.
    // M* short_name is metroline tag. So M7x routes are 1 network
    // (school) + 1 tag (metroline).
    const r1 = classifyRoute({
      route_short_name: 'M76A',
      route_long_name: 'TE2 Floresti str. Somesului',
    });
    expect(r1).toEqual([{ id: 'metroline', label: 'Metropolitan' }]);
    expect(classifyNetwork({
      route_short_name: 'M76A',
      route_long_name: 'TE2 Floresti str. Somesului',
    })).toEqual({ id: 'school', label: 'Transport Elevi' });

    const r2 = classifyRoute({
      route_short_name: 'M75B',
      route_long_name: 'TE1F',
    });
    expect(r2).toEqual([{ id: 'metroline', label: 'Metropolitan' }]);
    expect(classifyNetwork({
      route_short_name: 'M75B',
      route_long_name: 'TE1F',
    })).toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('catches "Elevi" substring case-insensitively across all 3 fields (broad school match)', () => {
    // School is a network, not a tag. The broad school match catches
    // "elevi" in any of the three fields. classifyRoute returns tags
    // only -- the school network is verified via classifyNetwork.
    expect(classifyRoute({ route_short_name: 'X1', route_long_name: 'Some elevi variant' }))
      .toEqual([]);
    expect(classifyNetwork({ route_short_name: 'X1', route_long_name: 'Some elevi variant' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });

    expect(classifyRoute({ route_short_name: 'X2', route_long_name: '', route_desc: 'Elevi route' }))
      .toEqual([]);
    expect(classifyNetwork({ route_short_name: 'X2', route_long_name: '', route_desc: 'Elevi route' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });

    expect(classifyRoute({ route_short_name: 'ELEVI-99', route_long_name: '' }))
      .toEqual([]);
    expect(classifyNetwork({ route_short_name: 'ELEVI-99', route_long_name: '' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('classifies X1 (elevi in long_name + untold in desc) as school + festival (1 network + 1 tag)', () => {
    // The synthetic 1:many case from the original test. Long_name
    // has "Transport Elevi" (catches school network via the elevi
    // substring). Desc has "Untold" (catches festival tag). Result:
    // school network + festival tag.
    const result = classifyRoute({
      route_short_name: 'X1',
      route_long_name: 'Str. X - Liceul Y (Transport Elevi)',
      route_desc: 'Untold',
    });
    // Only festival is a tag; school is a network.
    expect(result).toEqual([{ id: 'festival', label: 'Untold' }]);
    // School is a network classification.
    expect(classifyNetwork({
      route_short_name: 'X1',
      route_long_name: 'Str. X - Liceul Y (Transport Elevi)',
      route_desc: 'Untold',
    })).toEqual({ id: 'school', label: 'Transport Elevi' });
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

  it('classifies M* (non-school) as "Metropolitan"', () => {
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

  it('returns 1:many tag list for routes that match multiple tags (festival + metroline)', () => {
    // The canonical 1:many tag case: M26U-like routes. school is a
    // network (not a tag), so the 1:many here is purely on the tag
    // surface. M26U is in the normal network (no TE prefix anywhere).
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

  it('returns empty array for regular urban routes that match no tag AND no school network', () => {
    // Regular urban: no tag, no school network match. classifyRoute
    // returns []. classifyNetwork returns normal.
    expect(classifyRoute({ route_short_name: '1', route_long_name: 'Str. Bucium - P-ta 1 Mai' }))
      .toEqual([]);
    expect(classifyNetwork({ route_short_name: '1', route_long_name: 'Str. Bucium - P-ta 1 Mai' }))
      .toEqual({ id: 'normal', label: 'Normal' });
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
    expect(classifyNetwork({})).toEqual({ id: 'normal', label: 'Normal' });
  });
});

describe('classifyNetwork -- 1:1 network assignment', () => {
  // Per gtfs-adapters#26: every route belongs to exactly one of two
  // networks -- `school` (broad match: TE* s/l, elevi s/l/d) or
  // `normal` (the fallback for everything else). The 1:1 constraint
  // of the public GTFS spec is satisfied by construction.

  it('assigns school network to TE* short_name routes', () => {
    expect(classifyNetwork({ route_short_name: 'TE1' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyNetwork({ route_short_name: 'TE14', route_long_name: 'whatever' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyNetwork({ route_short_name: 'TE-OG' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('assigns school network to M7x family (TE* in long_name)', () => {
    // The M7x family has "TE\d+ Floresti" in long_name. With the
    // broad school match, they're school-network routes.
    expect(classifyNetwork({ route_short_name: 'M76A', route_long_name: 'TE2 Floresti str. Somesului' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyNetwork({ route_short_name: 'M75B', route_long_name: 'TE1F' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('assigns school network via the elevi substring defensive catch', () => {
    // "elevi" in any of the 3 fields is a school-network hit.
    expect(classifyNetwork({ route_short_name: 'X1', route_long_name: 'Some elevi variant' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyNetwork({ route_short_name: 'X2', route_long_name: '', route_desc: 'Elevi route' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(classifyNetwork({ route_short_name: 'ELEVI-99', route_long_name: '' }))
      .toEqual({ id: 'school', label: 'Transport Elevi' });
  });

  it('assigns normal network to routes with no school signal', () => {
    expect(classifyNetwork({ route_short_name: '1' }))
      .toEqual({ id: 'normal', label: 'Normal' });
    expect(classifyNetwork({ route_short_name: 'CS' }))
      .toEqual({ id: 'normal', label: 'Normal' });
    expect(classifyNetwork({ route_short_name: '25N' }))
      .toEqual({ id: 'normal', label: 'Normal' });
    expect(classifyNetwork({ route_short_name: 'A1' }))
      .toEqual({ id: 'normal', label: 'Normal' });
    // M26 (no TE prefix, no elevi) is normal network.
    expect(classifyNetwork({ route_short_name: 'M26', route_long_name: 'Gara - Selimbar' }))
      .toEqual({ id: 'normal', label: 'Normal' });
  });

  it('treats missing/undefined fields as empty strings (falls back to normal)', () => {
    expect(classifyNetwork({})).toEqual({ id: 'normal', label: 'Normal' });
    expect(classifyNetwork({ route_short_name: undefined, route_long_name: 'foo' }))
      .toEqual({ id: 'normal', label: 'Normal' });
  });
});

describe('cleanLongName -- start-end format', () => {
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
    // Kept even though those routes are now in the school network
    // (broad match). The cleanup pass still strips the Tranzy noise
    // from long_name for readability.
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

describe('deriveLongNameFromStops -- fallback when cleanup leaves long_name empty', () => {
  // Minimal shape -- only fields actually used.
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
      { trip_id: 'short', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 'short', stop_id: 'B', stop_sequence: 1 },
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

describe('cleanDesc -- symmetric cleanup with cleanLongName', () => {
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
    // D51's desc from Tranzy is " P-ta Mihai Viteazu - Gilau" -- already
    // clean. The cleanup pass leaves it intact so the orchestrator
    // can use it as route_desc when no classification overwrites it.
    expect(cleanDesc({ route_short_name: 'D51', route_desc: ' P-ta Mihai Viteazu - Gilau' }))
      .toBe('P-ta Mihai Viteazu - Gilau');
  });
});

describe('applyRouteCategory -- orchestrator entry point', () => {
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
      { route_id: '99', route_short_name: '99', route_long_name: '', route_desc: '' },
    ];
    return { routes, allStopTimeRows, tripToRoute };
  }

  it('classifies long_name + network + route_desc per the new model (gtfs-adapters#26)', () => {
    // TE1: school network (TE* short_name). No tag. The original
    // desc strategy produces an empty desc. The empty-desc fallback
    // fills it with "Transport Elevi" (school label, since "Normal"
    // is omitted).
    // Route 1: normal network. No tag, no useful desc. Empty desc.
    //   (The "Normal" label is omitted in the fallback -- regular
    //    urban routes get an empty desc to avoid noise.)
    // Route 99: normal network. No tag, no cleaned desc (uses stops
    //   fallback for long_name). route_desc empty.
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
    // TE1: school network, no tag, no useful desc. Empty-desc
    // fallback fills with "Transport Elevi" (omitting "Normal").
    expect(routes[0].route_desc).toBe('Transport Elevi');
    expect(routes[1].route_long_name).toBe('Str. Bucium - P-ta 1 Mai');
    // Regular urban: empty desc. "Normal" omitted from the fallback.
    expect(routes[1].route_desc).toBe('');
    // routeNetworks map: 1:1 by route_id, every route assigned.
    expect(result.routeNetworks.get('93')).toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(result.routeNetworks.get('1')).toEqual({ id: 'normal', label: 'Normal' });
    expect(result.routeNetworks.get('99')).toEqual({ id: 'normal', label: 'Normal' });
    // routeTags map: empty (no route is tagged in this fixture).
    expect(result.routeTags.size).toBe(0);
  });

  it('handles 1:many tag cases via route_desc comma-join (festival + metroline)', () => {
    // The canonical 1:many tag case: short_name M26U (M* prefix ->
    // metroline), long_name with "untold" (festival). route_desc
    // is the comma-joined tag labels -- no school label, since
    // school isn't a tag. (M26U is in the normal network; "M*"
    // short_name doesn't match the school pattern.)
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
    expect(result.networkCounts.normal).toBe(1); // M26U is normal (no TE)
    // route_desc is comma-separated in CATEGORIES order: festival
    // first, metroline second. School is NOT in the comma-join
    // (school is a network, not a tag).
    expect(routes[0].route_desc).toBe('Untold, Metropolitan');
  });

  it('falls back to stop_times when long_name is empty after cleanup', () => {
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

describe('applyRouteCategory -- desc strategy + empty-desc fallback', () => {
  // "Don't override good data" -- the original desc strategy takes
  // priority. The new-model classification is an ADDITIVE surface
  // -- it only fills in route_desc when the original strategy
  // produced an empty string. The empty-desc fallback (omitting
  // "Normal") handles the "route has a classification but no good
  // desc" case (TE routes, ELEVI-99, etc.).

  const stopsByStopId = new Map([
    ['A', { stop_name: 'Piata Garii' }],
    ['B', { stop_name: 'Cart. Zorilor' }],
  ]);

  it('preserves cleaned desc as route_desc when no tag matches (D51 case)', () => {
    // D51 is un-tagged (employee-only service, no public tag
    // pattern). Its Tranzy desc "P-ta Mihai Viteazu - Gilau" should
    // survive as the desc portion of route_desc. The "Normal" label
    // is omitted (D51 is normal network, but the "good data" desc
    // wins over the empty-desc fallback).
    const routes = [
      { route_id: '190', route_short_name: 'D51', route_long_name: 'D51', route_desc: ' P-ta Mihai Viteazu - Gilau' },
    ];
    const warnings = [];
    const result = applyRouteCategory({ routes, warnings });
    expect(result.classifiedCount).toBe(0);
    expect(result.descFromCleanedCount).toBe(1);
    // The desc is preserved as-is -- the empty-desc fallback doesn't
    // fire because route_desc is already non-empty.
    expect(routes[0].route_desc).toBe('P-ta Mihai Viteazu - Gilau');
  });

  it('TE1 (school network, no tag, no cleaned desc) gets the empty-desc fallback: "Transport Elevi"', () => {
    // The canonical empty-desc fallback case. TE1 is in the school
    // network, no tag, no cleaned desc, no parenthetical. The
    // original desc strategy leaves route_desc empty. The fallback
    // fires: labels = ["Transport Elevi"], filter "Normal" (not in
    // list) -> ["Transport Elevi"], join -> "Transport Elevi".
    const routes = [
      { route_id: '93', route_short_name: 'TE1', route_long_name: 'Manastur', route_desc: '' },
    ];
    const warnings = [];
    const result = applyRouteCategory({ routes, warnings });
    // School network, no tag.
    expect(result.routeNetworks.get('93')).toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(result.routeTags.get('93')).toBeUndefined();
    // Empty-desc fallback surfaces the school label.
    expect(routes[0].route_desc).toBe('Transport Elevi');
  });

  it('ELEVI-99 (school via elevi substring) gets the empty-desc fallback: "Transport Elevi"', () => {
    // The defensive "elevi" substring catch puts ELEVI-99 in the
    // school network. No tag, no cleaned desc, no parenthetical --
    // empty-desc fallback fires.
    const routes = [
      { route_id: 'E99', route_short_name: 'ELEVI-99', route_long_name: '', route_desc: '' },
    ];
    const warnings = [];
    const result = applyRouteCategory({ routes, warnings });
    expect(result.routeNetworks.get('E99')).toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(routes[0].route_desc).toBe('Transport Elevi');
  });

  it('uses cleaned desc when long_name is empty but desc has data (M75A case)', () => {
    // M75A: M* prefix matches metroline tag. The "TE1 Floresti"
    // long_name prefix is stripped (cleanup). route_desc is the
    // metroline tag only -- "Metropolitan". The cleaned desc
    // ("Avram Iancu (Floresti) - Liceul DumitruTautan") is the
    // long_name fallback, not the desc.
    //
    // Under the broad school match, M75A is also in the school
    // network (long_name starts with "TE1 Floresti" -- catches the
    // TE* in long_name predicate). So network = school, tag = metroline.
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
    // Network = school (broad match); tag = [metroline].
    expect(result.routeNetworks.get('144')).toEqual({ id: 'school', label: 'Transport Elevi' });
    expect(result.routeTags.get('144')).toEqual([
      { id: 'metroline', label: 'Metropolitan', priority: 0 },
    ]);
    // long_name falls back to cleaned desc (parenthetical preserved).
    expect(routes[0].route_long_name).toBe('Avram Iancu (Floresti) - Liceul DumitruTautan');
    // route_desc is the metroline tag only -- not prepended with the
    // school label (school is a network, not a tag, and the
    // tagged branch is already non-empty so the fallback doesn't
    // fire).
    expect(routes[0].route_desc).toBe('Metropolitan');
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
    // CS: special tag. route_desc = "Cursa Speciala" (tag, no prepend).
    expect(routes[0].route_desc).toBe('Cursa Speciala');
    // long_name cleared by CS rule, desc is empty -> fallback to stops
    expect(routes[0].route_long_name).toMatch(/^.+ - .+$/);
  });

  it('captures parenthetical content from long_name cleanup into desc for un-tagged routes (88A case)', () => {
    // Route 88A is un-tagged (88A starts with 8, not M, so no
    // metroline match; no TE prefix anywhere, no elevi). The
    // long_name + desc are identical: "Floresti Cetate - Emerson
    // (traseu M21)". After cleanup, the parenthetical "traseu M21"
    // is stripped from long_name -> "Floresti Cetate - Emerson".
    // The parenthetical content becomes the desc since
    // cleanedDesc == cleanedLong (no unique info there).
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
    // is the parenthetical alone -- no network prepending.
    expect(routes[0].route_long_name).toBe('Floresti Cetate - Emerson');
    expect(routes[0].route_desc).toBe('Traseu M21');
  });

  it('combines cleaned desc with stripped parenthetical when both contribute unique info', () => {
    const routes = [
      {
        route_id: 'X',
        route_short_name: 'X1',
        route_long_name: 'P-ta Garii - Str. Somesului (note 1)',
        route_desc: 'P-ta Garii - Str. Campului',
      },
    ];
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
    // Cleaned desc + parenthetical joined by " | ". No network
    // prepending -- the "good data" desc wins.
    expect(routes[0].route_desc).toBe('P-ta Garii - Str. Campului | Note 1');
  });

  it('title-cases parenthetical content (lowercase first letter -> caps)', () => {
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
    expect(routes[0].route_desc).toBe('Some unique desc | Traseu M21');
  });

  it('filters out stripped content that matches a tag label (defensive)', () => {
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
    // "Metropolitan" filtered out from parenthetical pool; the
    // good desc wins; no network prepending.
    expect(routes[0].route_desc).toBe('Some desc');
  });

  it('dedupes stripped content when both fields capture the same parenthetical', () => {
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
    // Single "Traseu M21", not duplicated. No network prepending.
    expect(routes[0].route_desc).toBe('Traseu M21');
  });

  it('drops stale long_name variant from desc (Tranzy desc has different destination than long_name)', () => {
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
      {
        route_id: '88A',
        route_short_name: '88A',
        route_long_name: 'A - B (traseu M21)',
        route_desc: 'A - B (traseu M21)',
      },
      {
        route_id: 'D51',
        route_short_name: 'D51',
        route_long_name: 'D51',
        route_desc: 'P-ta Mihai Viteazu - Gilau',
      },
    ];
    const warnings = [];
    applyRouteCategory({ routes, warnings });
    // 23 and 21: stale variants dropped. route_desc stays empty
    // (no useful desc, no parenthetical, normal network -- fallback
    // empty after omitting "Normal").
    expect(routes[0].route_desc).toBe(''); // route 23
    expect(routes[1].route_desc).toBe(''); // route 21
    // 88A: parenthetical content preserved.
    expect(routes[2].route_desc).toBe('Traseu M21');
    // D51: terminal info preserved (long_name is just the code).
    expect(routes[3].route_desc).toBe('P-ta Mihai Viteazu - Gilau');
  });

  it('keeps desc when its terminal IS on the route pattern (structural validation)', () => {
    const routes = [
      {
        route_id: 'X',
        route_short_name: 'X1',
        route_long_name: 'P-ta Floresti - Pod Someseni',
        route_desc: 'P-ta Floresti - EMERSON',
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
      ['X2', { stop_name: 'Pod Someseni' }],
      ['X3', { stop_name: 'EMERSON' }],
    ]);
    const warnings = [];
    applyRouteCategory({ routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings });
    // EMERSON is on the route -> desc is valid -> preserved.
    expect(routes[0].route_desc).toBe('P-ta Floresti - EMERSON');
  });

  it('drops desc when its terminal is NOT on the route pattern (structural validation)', () => {
    const routes = [
      {
        route_id: '23',
        route_short_name: '23',
        route_long_name: 'P-ta M. Viteazul - C.U.G',
        route_desc: 'P-ta M. Viteazul - EMERSON',
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
    ]);
    const warnings = [];
    applyRouteCategory({ routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings });
    // EMERSON not on this route -> desc is stale -> dropped.
    // route_desc stays empty (normal network, fallback empty after
    // omitting "Normal").
    expect(routes[0].route_desc).toBe('');
  });

  it('appends non-tag parenthetical to tagged routes (metroline + Floresti)', () => {
    // M75B: M* prefix matches metroline tag. long_name has
    // "(Floresti)" trailing parenthetical. route_desc = "Metropolitan"
    // (tag) + " | Floresti" (parenthetical). Network = normal
    // (M75B short_name doesn't match school -- no TE prefix, no
    // elevi substring).
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
    // Network = normal (M75B has no school signal).
    expect(result.routeNetworks.get('M75B')).toEqual({ id: 'normal', label: 'Normal' });
    expect(result.routeTags.get('M75B')).toEqual([
      { id: 'metroline', label: 'Metropolitan', priority: 0 },
    ]);
    // Tag label + non-redundant parenthetical joined with " | ".
    expect(routes[0].route_desc).toBe('Metropolitan | Floresti');
  });
});

describe('getAllCategories / getAllTags / getAllNetworks -- surface accessors', () => {
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
    // Commuter was removed -- D51 isn't a public commuter rail route.
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
