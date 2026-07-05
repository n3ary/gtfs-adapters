// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity.
import { describe, it, expect } from 'vitest';

import {
  CATEGORIES,
  classifyRoute,
  cleanLongName,
  cleanDesc,
  deriveLongNameFromStops,
  applyRouteCategory,
  getAllCategories,
} from '../src/assemble/merge/routeCategory.ts';

describe('classifyRoute — pattern → category', () => {
  // classifyRoute returns an array (1:many) — empty for regular urban.

  it('classifies TE-prefixed school buses as "Transport Elevi"', () => {
    expect(classifyRoute({ route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur' }))
      .toEqual([{ id: 'school', label: 'Transport Elevi' }]);
    expect(classifyRoute({ route_short_name: 'TE14' })).toEqual([{ id: 'school', label: 'Transport Elevi' }]);
    expect(classifyRoute({ route_short_name: 'TE-OG' })).toEqual([{ id: 'school', label: 'Transport Elevi' }]);
  });

  it('classifies M7x routes as BOTH school + metroline (TE prefix in long_name)', () => {
    // The M7x school-bus family carries the school designation as
    // long_name (`TE2 Floresti ...`, `TE1F`) while Tranzy catalogs them
    // with the M* metroline prefix. Both signals are real — they're
    // Floresti metroline services that also serve school destinations
    // (Liceul Dumitru Tautan, Cetatea Fetei, etc.). The TE-prefix
    // check on long_name catches the school signal that the M* prefix
    // check alone would miss.
    expect(classifyRoute({
      route_short_name: 'M76A',
      route_long_name: 'TE2 Floresti str. Somesului',
    })).toEqual([
      { id: 'school', label: 'Transport Elevi' },
      { id: 'metroline', label: 'Metropolitan' },
    ]);
    expect(classifyRoute({
      route_short_name: 'M75B',
      route_long_name: 'TE1F',
    })).toEqual([
      { id: 'school', label: 'Transport Elevi' },
      { id: 'metroline', label: 'Metropolitan' },
    ]);
  });

  it('catches "Elevi" substring case-insensitively across all 3 fields', () => {
    expect(classifyRoute({ route_short_name: 'X1', route_long_name: 'Some elevi variant' }))
      .toEqual([{ id: 'school', label: 'Transport Elevi' }]);
    expect(classifyRoute({ route_short_name: 'X2', route_long_name: '', route_desc: 'Elevi route' }))
      .toEqual([{ id: 'school', label: 'Transport Elevi' }]);
    expect(classifyRoute({ route_short_name: 'ELEVI-99', route_long_name: '' }))
      .toEqual([{ id: 'school', label: 'Transport Elevi' }]);
  });

  it('classifies *U suffix + "(untold)" annotation as "Untold"', () => {
    expect(classifyRoute({ route_short_name: '30U', route_long_name: 'Grigorescu - IRA' }))
      .toEqual([{ id: 'festival', label: 'Untold' }]);
    // M26U is also metroline (M* prefix) → 1:many.
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

  it('returns 1:many for routes that match multiple categories (M76A = school + metroline)', () => {
    // New 1:many signature case: a route whose long_name AND route_desc
    // both carry category signals. e.g. route_id='X' has long_name with
    // "Transport Elevi" + short_name "M26" with "untold" in route_desc.
    // Use a synthetic shape that exercises the comma-join without the
    // M7x-specific M76A case (see the dedicated M7x test for that
    // route's reduced-to-metroline classification).
    const result = classifyRoute({
      route_short_name: 'X1',
      route_long_name: 'Str. X - Liceul Y (Transport Elevi)',
      route_desc: 'Untold',
    });
    expect(result).toEqual([
      { id: 'school', label: 'Transport Elevi' },
      { id: 'festival', label: 'Untold' },
    ]);
  });

  it('returns empty array for regular urban routes that match no category', () => {
    expect(classifyRoute({ route_short_name: '1', route_long_name: 'Str. Bucium - P-ta 1 Mai' }))
      .toEqual([]);
    expect(classifyRoute({ route_short_name: '24', route_long_name: 'Str. Unirii - Str. Bucium' }))
      .toEqual([]);
    expect(classifyRoute({ route_short_name: '101', route_long_name: 'Tram line 101' }))
      .toEqual([]);
  });

  it('respects priority order (matches in CATEGORIES order)', () => {
    // 1:many results preserve CATEGORIES declaration order.
    expect(CATEGORIES.map((c) => c.id)).toEqual([
      'special', 'school', 'festival', 'night', 'airport', 'metroline',
    ]);
    // For a school + festival 1:many case, school comes first because
    // it's declared earlier in CATEGORIES.
    const result = classifyRoute({
      route_short_name: 'X1',
      route_long_name: 'Str. X - Liceul Y (Transport Elevi)',
      route_desc: 'Untold',
    });
    expect(result.map((c) => c.id)).toEqual(['school', 'festival']);
  });

  it('treats missing/undefined fields as empty strings', () => {
    expect(() => classifyRoute({})).not.toThrow();
    expect(classifyRoute({})).toEqual([]);
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
    // as route_desc when no category matches.
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

  it('cleans long_name, classifies (1:many), and mutates route_desc with comma-separated labels', () => {
    const { routes, allStopTimeRows, tripToRoute } = setup();
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.classifiedCount).toBe(1); // TE1 only
    expect(result.multiNetworkCount).toBe(0);
    expect(routes[0].route_long_name).toBe('Manastur');
    expect(routes[0].route_desc).toBe('Transport Elevi');
    expect(routes[1].route_long_name).toBe('Str. Bucium - P-ta 1 Mai');
    expect(routes[1].route_desc).toBe(''); // regular urban
  });

  it('classifies BEFORE cleanup so a 1:many case survives the cleanup pass', () => {
    // Regression test for the order-change. If classification ran AFTER
    // cleanup, signals embedded in long_name (e.g. "Transport Elevi" or
    // a parenthetical) would be stripped before classification could
    // match them. The 1:many route here exercises a long_name signal
    // ("Transport Elevi" inside parens) plus a short_name signal (M*
    // prefix for metroline) — both must survive.
    //
    // Note: M76A itself (the original 1:many case) is no longer 1:many
    // because we dropped the M7x short_name regex from the school pattern.
    // This test uses a synthetic shape that still produces 1:many via the
    // long_name "elevi" check + short_name M* check.
    const allStopTimeRows = [
      { trip_id: 't-145', stop_id: 'A', stop_sequence: 0 },
      { trip_id: 't-145', stop_id: 'B', stop_sequence: 1 },
    ];
    const tripToRoute = new Map([['t-145', '145']]);
    const routes = [
      {
        route_id: '145',
        route_short_name: 'M99',
        route_long_name: 'Some Endpoint - Liceul X (Transport Elevi)',
        route_desc: '',
      },
    ];
    const warnings = [];
    const result = applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    expect(result.classifiedCount).toBe(1); // 1 route
    expect(result.multiNetworkCount).toBe(1); // with 2 networks
    // route_desc is comma-separated in CATEGORIES order: school first,
    // metroline second.
    expect(routes[0].route_desc).toBe('Transport Elevi, Metropolitan');
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

  it('emits an INFO warning summarizing classified / cleaned / derived / multi-network counts', () => {
    const { routes, allStopTimeRows, tripToRoute } = setup();
    const warnings = [];
    applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    const info = warnings.find((w) => w.severity === 'info' && w.message.includes('classified'));
    expect(info).toBeDefined();
    expect(info.message).toMatch(/classified 1 route\(s\)/);
    expect(info.message).toMatch(/cleaned 1/);
  });

  it('emits multi-network count in INFO when 1:many cases fire', () => {
    // Synthetic 1:many case: short_name M* (metroline) + long_name with
    // "Transport Elevi" (school). After we dropped the M7x short_name
    // regex, this is the canonical 1:many fixture.
    const allStopTimeRows = [];
    const tripToRoute = new Map();
    const routes = [
      { route_id: '145', route_short_name: 'M99', route_long_name: 'Some Endpoint - Liceul X (Transport Elevi)', route_desc: '' },
      { route_id: '146', route_short_name: 'M98', route_long_name: 'Other Endpoint - Scoala Y (Transport Elevi)', route_desc: '' },
    ];
    const warnings = [];
    applyRouteCategory({
      routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings,
    });
    const info = warnings.find((w) => w.severity === 'info');
    expect(info.message).toMatch(/2 with multiple networks/);
  });

  it('does not emit a warning when nothing changes', () => {
    // After the desc-preservation change, this fixture does fire an
    // INFO warning ("preserved 1 desc on un-categorized routes"). To get
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
  // Pin the new behavior: for un-categorized routes, route_desc keeps
  // the descriptive text from Tranzy (after cleanup). For categorized
  // routes, route_desc is overwritten with the category labels.
  // This avoids the previous data loss for D51 / M75A / etc. where
  // blind overwriting cleared Tranzy's endpoint info.

  const stopsByStopId = new Map([
    ['A', { stop_name: 'Piata Garii' }],
    ['B', { stop_name: 'Cart. Zorilor' }],
  ]);

  it('preserves cleaned desc as route_desc when no category matches (D51 case)', () => {
    // D51 is un-categorized (employee-only service, no public category
    // pattern). Its Tranzy desc "P-ta Mihai Viteazu - Gilau" should
    // survive as the route_desc so consumers see endpoint info instead
    // of an empty string.
    const routes = [
      { route_id: '190', route_short_name: 'D51', route_long_name: 'D51', route_desc: ' P-ta Mihai Viteazu - Gilau' },
    ];
    const warnings = [];
    const result = applyRouteCategory({ routes, warnings });
    expect(result.classifiedCount).toBe(0);
    expect(result.descFromCleanedCount).toBe(1);
    expect(routes[0].route_desc).toBe('P-ta Mihai Viteazu - Gilau');
  });

  it('uses category labels for categorized routes (desc gets overwritten)', () => {
    // TE1 is categorized as school. The Tranzy desc "" is empty so
    // there's nothing to lose — but verify the category label wins
    // even if desc had data.
    const routes = [
      { route_id: '93', route_short_name: 'TE1', route_long_name: 'Transport Elevi Manastur', route_desc: 'Some endpoint desc' },
    ];
    const warnings = [];
    applyRouteCategory({ routes, warnings });
    expect(routes[0].route_desc).toBe('Transport Elevi');
  });

  it('uses cleaned desc when long_name is empty but desc has data (M75A case)', () => {
    // M75A scenario: TE1 Floresti long_name gets stripped to empty,
    // so long_name falls back to the cleaned desc. Note: the parenthetical
    // in this desc is mid-string (not trailing), so the cleanup regex
    // — which only strips TRAILING parentheticals — leaves it intact.
    // That's the intended behavior — mid-string " (Floresti)" is
    // meaningful content, not annotation noise.
    const routes = [
      {
        route_id: '144',
        route_short_name: 'M75A',
        route_long_name: 'TE1 Floresti',
        route_desc: 'Avram Iancu (Floresti) - Liceul DumitruTautan',
      },
    ];
    const warnings = [];
    applyRouteCategory({ routes, warnings });
    // long_name falls back to cleaned desc (parenthetical preserved)
    expect(routes[0].route_long_name).toBe('Avram Iancu (Floresti) - Liceul DumitruTautan');
    // desc is overwritten with BOTH school + metroline (1:many) — the
    // long_name "TE1 Floresti" matches the school TE-prefix check; the
    // short_name "M75A" matches the metroline M\d check.
    expect(routes[0].route_desc).toBe('Transport Elevi, Metropolitan');
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
    applyRouteCategory({ routes, allStopTimeRows, tripToRoute, stopsByStopId, warnings });
    // CS gets its category as desc
    expect(routes[0].route_desc).toBe('Cursa Speciala');
    // long_name cleared by CS rule, desc is empty → fallback to stops
    expect(routes[0].route_long_name).toMatch(/^.+ - .+$/);
  });

  it('captures parenthetical content from long_name cleanup into desc for un-categorized routes (88A case)', () => {
    // The signature example from PR review. Route 88A is un-categorized
    // (88A starts with 8, not M, so no metroline match). Tranzy's
    // long_name + desc are identical: "Floresti Cetate - Emerson (traseu M21)".
    // After cleanup, the parenthetical "traseu M21" is stripped from
    // long_name (→ "Floresti Cetate - Emerson"). The stripped content
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
    // The parenthetical content is the only unique info.
    expect(routes[0].route_long_name).toBe('Floresti Cetate - Emerson');
    expect(routes[0].route_desc).toBe('Traseu M21');
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
    expect(routes[0].route_desc).toBe('P-ta Garii - Str. Campului | Note 1');
  });

  it('title-cases parenthetical content (lowercase → first letter caps)', () => {
    // "(traseu M21)" → "Traseu M21". Uses "(traseu M21)" rather than
    // "(untold)" because the latter would categorize the route as
    // festival before cleanup, defeating the test purpose.
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

  it('filters out stripped content that matches a category label (defensive)', () => {
    // The category-filter guard in desc-building is defensive: when a
    // parenthetical happens to contain text that matches a category
    // label (case-insensitive) but the route isn't otherwise
    // categorized, we drop it from desc so we don't accidentally
    // surface a category signal that classification declined to apply.
    //
    // Construction: short_name "X1" doesn't trigger any short_name
    // regex. long_name uses "(Metropolitan)" — the metroline pattern
    // is `/^M\d/.test(short_name)`, NOT a substring check on
    // long_name, so the route reaches the un-categorized branch.
    // The filter catches "Metropolitan" against the metroline label
    // "Metropolitan" and drops it.
    //
    // (Why not "(Noapte)" or "(Untold)"? The night and festival
    // patterns do substring-check long_name, so those would
    // categorize the route before reaching the filter — defeating
    // the test.)
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
    expect(routes[0].route_desc).toBe('Some desc'); // "Metropolitan" filtered out
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
    // Single "Traseu M21", not duplicated.
    expect(routes[0].route_desc).toBe('Traseu M21');
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
    // 23 and 21: stale variants dropped.
    expect(routes[0].route_desc).toBe(''); // route 23
    expect(routes[1].route_desc).toBe(''); // route 21
    // 88A: parenthetical content preserved.
    expect(routes[2].route_desc).toBe('Traseu M21');
    // D51: terminal info preserved (long_name is just the code).
    expect(routes[3].route_desc).toBe('P-ta Mihai Viteazu - Gilau');
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
    expect(routes[0].route_desc).toBe('P-ta Floresti - EMERSON');
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
    expect(routes[0].route_desc).toBe('');
  });

  it('appends non-category parenthetical to categorized routes (TE + Floresti)', () => {
    // Marius's PR feedback: "route_desc default = category labels +
    // captured parenthetical content (human-readable title case), only
    // when the parenthetical isn't already a category label." The TE
    // routes whose Tranzy desc ends in "(Floresti)" — the Floresti
    // commune is the destination of the school bus — get category
    // label "Transport Elevi" PLUS the captured "Floresti" so riders
    // see which corridor the school bus serves.
    //
    // Reproduces the live data shape: long_name = "TE1F" (the cleanup
    // already happened upstream; desc still carries the original).
    const routes = [
      {
        route_id: 'M75B',
        route_short_name: 'TE1F',
        route_long_name: 'TE1F',
        route_desc: 'Liceul Dumitru Tautan - str. Avram Iancu (Floresti)',
      },
    ];
    const warnings = [];
    applyRouteCategory({ routes, warnings });
    expect(routes[0].route_long_name).toBe('TE1F');
    // Category label + non-redundant parenthetical joined with " | ".
    expect(routes[0].route_desc).toBe('Transport Elevi | Floresti');
  });
});

describe('getAllCategories — networks emission input', () => {
  it('returns the full category list with id + label', () => {
    const all = getAllCategories();
    expect(all.length).toBe(CATEGORIES.length);
    for (const c of all) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('label');
      expect(typeof c.id).toBe('string');
      expect(typeof c.label).toBe('string');
    }
  });

  it('exposes the categories neary will need to render', () => {
    const ids = getAllCategories().map((c) => c.id);
    expect(ids).toContain('school');
    expect(ids).toContain('festival');
    expect(ids).toContain('night');
    expect(ids).toContain('airport');
    expect(ids).toContain('metroline');
    expect(ids).toContain('special');
    // Commuter was removed — D51 isn't a public commuter rail route.
    expect(ids).not.toContain('commuter');
  });

  it('uses Romanian labels (matches ctpcj.ro terminology)', () => {
    const labels = Object.fromEntries(getAllCategories().map((c) => [c.id, c.label]));
    expect(labels.night).toBe('Noapte');
    expect(labels.metroline).toBe('Metropolitan');
    expect(labels.school).toBe('Transport Elevi');
    expect(labels.festival).toBe('Untold');
    expect(labels.airport).toBe('Aeroport Expres');
    expect(labels.special).toBe('Cursa Speciala');
  });
});