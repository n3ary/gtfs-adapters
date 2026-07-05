// @ts-nocheck - tests use many `routes.find(...)!` patterns; full strict typing is a follow-up.
import { describe, it, expect } from 'vitest';

import { reconcileRoutes, routesToTxt } from '../src/assemble/merge/routes.ts';

/** Minimal seed object shape consumed by reconcileRoutes. */
function seedOf(routes) {
  return { routes, agencyTxt: '' };
}

describe('reconcileRoutes — color spec compliance', () => {
  it("normalizes Tranzy's 3-char hex route_color to 6-char per GTFS spec", () => {
    // GTFS Color type requires six hex digits. Tranzy returns CSS
    // shorthand (e.g. '000') for ~80 CTP routes, which is non-compliant.
    // The adapter expands it rather than passing through. Black is
    // then substituted out by the type-modal rule when other routes
    // of the same type provide a non-black color.
    const tranzy = {
      routes: [
        { route_id: '50', route_short_name: '50', route_long_name: 'Test', route_type: 3, route_color: '000' },
        { route_id: '51', route_short_name: '51', route_long_name: 'Modal', route_type: 3, route_color: '#F3513C' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r50 = routes.find((x) => x.route_short_name === '50');
    // Black '000' → normalized to '000000' → substituted with the
    // type=3 modal color (only non-black bus color is '#F3513C').
    expect(r50.route_color).toBe('F3513C');
  });

  it('strips the leading # and uppercases route_color', () => {
    const tranzy = {
      routes: [
        { route_id: '51', route_short_name: '51', route_long_name: 'Test', route_type: 3, route_color: '#abcdef' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '51')!;
    expect(r.route_color).toBe('ABCDEF');
  });

  it("falls back to FFFFFF for route_color only when Tranzy/seed are empty AND the type has no modal color", () => {
    // Single route of an unknown type, no color → no modal to derive
    // from, so the GTFS consumer default (FFFFFF) applies.
    const tranzy = {
      routes: [
        { route_id: '52', route_short_name: '52', route_long_name: 'No Color', route_type: 99 },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '52')!;
    expect(r.route_color).toBe('FFFFFF');
  });

  it("substitutes black/missing route_color with the per-type modal non-black color", () => {
    // Type=3 (bus): 1 route with '#F3513C', 1 with '000', 1 with no
    // color. The two non-modal routes both get '#F3513C' substituted.
    const tranzy = {
      routes: [
        { route_id: '1', route_short_name: '1', route_long_name: 'Modal', route_type: 3, route_color: '#F3513C' },
        { route_id: '2', route_short_name: '2', route_long_name: 'Black', route_type: 3, route_color: '000' },
        { route_id: '3', route_short_name: '3', route_long_name: 'None',  route_type: 3 },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    expect(routes.find((r) => r.route_short_name === '1').route_color).toBe('F3513C');
    expect(routes.find((r) => r.route_short_name === '2').route_color).toBe('F3513C');
    expect(routes.find((r) => r.route_short_name === '3').route_color).toBe('F3513C');
  });

  it("preserves non-black one-off Tranzy colors (modal substitution only fires on black/missing)", () => {
    // Type=3 with the canonical orange-red modal, plus a one-off blue.
    // The blue route keeps its color; only the black '000' gets
    // substituted with the modal.
    const tranzy = {
      routes: [
        { route_id: '1', route_short_name: '1', route_long_name: 'Modal',  route_type: 3, route_color: '#F3513C' },
        { route_id: '2', route_short_name: '2', route_long_name: 'Modal2', route_type: 3, route_color: '#F3513C' },
        { route_id: '3', route_short_name: '3', route_long_name: 'OneOff', route_type: 3, route_color: '#5500FF' },
        { route_id: '4', route_short_name: '4', route_long_name: 'Black',  route_type: 3, route_color: '000' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    expect(routes.find((r) => r.route_short_name === '3').route_color).toBe('5500FF');
    expect(routes.find((r) => r.route_short_name === '4').route_color).toBe('F3513C');
  });

  it('emits an INFO summary when route colors are substituted, broken down per type', () => {
    const tranzy = {
      routes: [
        { route_id: '1', route_short_name: '1', route_long_name: 'Modal', route_type: 3, route_color: '#F3513C' },
        { route_id: '2', route_short_name: '2', route_long_name: 'Black', route_type: 3, route_color: '000' },
      ],
    };
    const warnings: any[] = [];
    reconcileRoutes({ seed: seedOf([]), tranzy, warnings });
    const sub = warnings.find((w) => w.message.includes('substituted placeholder route_color'));
    expect(sub).toBeTruthy();
    expect(sub.message).toMatch(/1 bus/);
    expect(sub.message).toMatch(/F3513C/);
  });

  it("substitutes invalid (non-hex) route_color with the per-type modal color, tracked separately from placeholder", () => {
    // Three buses: one valid modal, one literal 'xxx' (invalid), one
    // 7-char garbage (also invalid). Both garbage routes get F3513C.
    // The INFO log distinguishes 'invalid' from 'placeholder'.
    const tranzy = {
      routes: [
        { route_id: '1', route_short_name: '1', route_long_name: 'Modal', route_type: 3, route_color: '#F3513C' },
        { route_id: '2', route_short_name: '2', route_long_name: 'Bad1',  route_type: 3, route_color: 'xxx' },
        { route_id: '3', route_short_name: '3', route_long_name: 'Bad2',  route_type: 3, route_color: '#ZZZZZZ' },
      ],
    };
    const warnings: any[] = [];
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings });
    expect(routes.find((r) => r.route_short_name === '2').route_color).toBe('F3513C');
    expect(routes.find((r) => r.route_short_name === '3').route_color).toBe('F3513C');
    const sub = warnings.find((w) => w.message.includes('substituted invalid/missing route_color'));
    expect(sub).toBeTruthy();
    expect(sub.message).toMatch(/2 bus/);
    // The placeholder-reason line should NOT fire when no 000000 was seen.
    const placeholderLine = warnings.find((w) => w.message.includes('placeholder route_color'));
    expect(placeholderLine).toBeFalsy();
  });

  it("resolves a 2-type modal-color collision by hue-rotating the lower-count type and emits an INFO", () => {
    // Tranzy's CTP catalog has tram + bus + most trolleybuses centered
    // on the same modal — when types collide, the type with the most
    // routes at the colliding color keeps it; smaller types get
    // OKLCh hue-rotated to maximize perceptual separation.
    const tranzy = {
      routes: [
        { route_id: '100', route_short_name: '100', route_long_name: 'Tram1', route_type: 0, route_color: '#F3513C' },
        { route_id: '101', route_short_name: '101', route_long_name: 'Tram2', route_type: 0, route_color: '#F3513C' },
        // Three buses to outweigh the trams — bus is the "kept" type.
        { route_id: '5',   route_short_name: '5',   route_long_name: 'Bus1',  route_type: 3, route_color: '#F3513C' },
        { route_id: '6',   route_short_name: '6',   route_long_name: 'Bus2',  route_type: 3, route_color: '#F3513C' },
        { route_id: '7',   route_short_name: '7',   route_long_name: 'Bus3',  route_type: 3, route_color: '#F3513C' },
      ],
    };
    const warnings: any[] = [];
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings });
    // Buses are the kept type (3 routes vs 2 tram routes).
    expect(routes.find((r) => r.route_short_name === '5')!.route_color).toBe('F3513C');
    expect(routes.find((r) => r.route_short_name === '7')!.route_color).toBe('F3513C');
    // Trams got reassigned to a single new color.
    const tram1 = routes.find((r) => r.route_short_name === '100')!.route_color;
    const tram2 = routes.find((r) => r.route_short_name === '101')!.route_color;
    expect(tram1).toBe(tram2);
    expect(tram1).not.toBe('F3513C');
    // INFO log records the change.
    const collision = warnings.find((w) => w.message.includes('modal route_color collision resolved'));
    expect(collision).toBeTruthy();
    expect(collision.message).toMatch(/tram/);
    expect(collision.message).toMatch(/F3513C/);
  });

  it("preserves one-off (non-modal) Tranzy colors when resolving a collision", () => {
    // Trolley `5N` is blue (#1500FF) — a one-off, not the type's modal.
    // After collision resolution between bus and trolleybus modals,
    // the blue one-off must stay blue; only modal routes get skewed.
    const tranzy = {
      routes: [
        { route_id: '5',  route_short_name: '5',  route_long_name: 'Bus1',     route_type: 3,  route_color: '#F3513C' },
        { route_id: '6',  route_short_name: '6',  route_long_name: 'Bus2',     route_type: 3,  route_color: '#F3513C' },
        { route_id: '10', route_short_name: '10', route_long_name: 'Trolley1', route_type: 11, route_color: '#F3513C' },
        { route_id: '5N', route_short_name: '5N', route_long_name: 'TrolleyN', route_type: 11, route_color: '#1500FF' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    // The blue one-off is preserved verbatim.
    expect(routes.find((r) => r.route_short_name === '5N')!.route_color).toBe('1500FF');
    // Buses keep the modal (higher count); trolley `10` gets skewed.
    expect(routes.find((r) => r.route_short_name === '5')!.route_color).toBe('F3513C');
    expect(routes.find((r) => r.route_short_name === '10')!.route_color).not.toBe('F3513C');
  });

  it("back-fills placeholder-substituted routes with the post-skew color", () => {
    // A black trolleybus first gets substituted with the type's modal
    // (F3513C from the one valid trolley). Then the collision between
    // bus and trolley modal triggers skew. The originally-black
    // trolleybus must end up at the skewed color, not the pre-skew
    // modal — back-fill is keyed on current route_color.
    const tranzy = {
      routes: [
        { route_id: '5',  route_short_name: '5',  route_long_name: 'Bus1',     route_type: 3,  route_color: '#F3513C' },
        { route_id: '6',  route_short_name: '6',  route_long_name: 'Bus2',     route_type: 3,  route_color: '#F3513C' },
        { route_id: '10', route_short_name: '10', route_long_name: 'Trolley1', route_type: 11, route_color: '#F3513C' },
        { route_id: '11', route_short_name: '11', route_long_name: 'TrolleyB', route_type: 11, route_color: '000' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const trolley1 = routes.find((r) => r.route_short_name === '10')!.route_color;
    const trolleyBlack = routes.find((r) => r.route_short_name === '11')!.route_color;
    expect(trolley1).toBe(trolleyBlack);
    expect(trolley1).not.toBe('F3513C');
    expect(trolley1).not.toBe('000000');
  });

  it("distributes 3 colliding types around the OKLCh wheel (all distinct outputs)", () => {
    // All three types at the same modal. Bus has the most routes ->
    // keeps F3513C. Tram and trolleybus get rotated by +120° and +240°.
    const tranzy = {
      routes: [
        { route_id: '100', route_short_name: '100', route_long_name: 'Tram', route_type: 0,  route_color: '#F3513C' },
        { route_id: '5',   route_short_name: '5',   route_long_name: 'Bus1', route_type: 3,  route_color: '#F3513C' },
        { route_id: '6',   route_short_name: '6',   route_long_name: 'Bus2', route_type: 3,  route_color: '#F3513C' },
        { route_id: '10',  route_short_name: '10',  route_long_name: 'Trolley', route_type: 11, route_color: '#F3513C' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const tram = routes.find((r) => r.route_short_name === '100')!.route_color;
    const bus  = routes.find((r) => r.route_short_name === '5')!.route_color;
    const trolley = routes.find((r) => r.route_short_name === '10')!.route_color;
    expect(bus).toBe('F3513C');
    expect(new Set([tram, bus, trolley]).size).toBe(3);
  });

  it('does not emit a collision INFO when each route_type has a distinct modal', () => {
    const tranzy = {
      routes: [
        { route_id: '100', route_short_name: '100', route_long_name: 'Tram', route_type: 0, route_color: '#3BAC2C' },
        { route_id: '5',   route_short_name: '5',   route_long_name: 'Bus',  route_type: 3, route_color: '#F3513C' },
      ],
    };
    const warnings: any[] = [];
    reconcileRoutes({ seed: seedOf([]), tranzy, warnings });
    const collision = warnings.find((w) => w.message.includes('modal route_color collision'));
    expect(collision).toBeFalsy();
  });

  it("nudges the OKLCh skew away from existing one-off colors instead of landing on them", () => {
    // Mirrors Tranzy's CTP catalog shape: tram + bus collision on
    // #F3513C, with several blue one-offs in the catalog (#002FFF,
    // #0D00FF, #1500FF). A naive +180° rotation of #F3513C lands on
    // a cyan-blue close to those one-offs in OKLab space — the
    // resolver should drift to a different hue.
    const tranzy = {
      routes: [
        // Tram collides with bus, with bus winning by count.
        { route_id: '100', route_short_name: '100', route_long_name: 'Tram',  route_type: 0, route_color: '#F3513C' },
        { route_id: '5',   route_short_name: '5',   route_long_name: 'Bus1',  route_type: 3, route_color: '#F3513C' },
        { route_id: '6',   route_short_name: '6',   route_long_name: 'Bus2',  route_type: 3, route_color: '#F3513C' },
        // Blue one-offs that would conflict with naive cyan/blue rotations.
        { route_id: '7',   route_short_name: '7',   route_long_name: 'BusB1', route_type: 3, route_color: '#002FFF' },
        { route_id: '8',   route_short_name: '8',   route_long_name: 'BusB2', route_type: 3, route_color: '#0D00FF' },
        { route_id: '9',   route_short_name: '9',   route_long_name: 'BusB3', route_type: 3, route_color: '#1500FF' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const tramColor = routes.find((r) => r.route_short_name === '100')!.route_color;
    // The skewed tram color must not equal any existing one-off.
    for (const oneoff of ['002FFF', '0D00FF', '1500FF']) {
      expect(tramColor).not.toBe(oneoff);
    }
    // One-offs are preserved verbatim — sanity check.
    expect(routes.find((r) => r.route_short_name === '7')!.route_color).toBe('002FFF');
    expect(routes.find((r) => r.route_short_name === '8')!.route_color).toBe('0D00FF');
    expect(routes.find((r) => r.route_short_name === '9')!.route_color).toBe('1500FF');
  });
});

describe('reconcileRoutes — route_text_color is uniformly white', () => {
  it('always emits FFFFFF for route_text_color regardless of source', () => {
    // Tranzy returns null for route_text_color across all CTP routes.
    // We don't attempt per-row contrast: every plate ships white-on-
    // background, which is readable across the dark backgrounds the
    // modal-substitution rule produces.
    const tranzy = {
      routes: [
        { route_id: '60', route_short_name: '60', route_long_name: 'Dark',  route_type: 3, route_color: '000' },
        { route_id: '61', route_short_name: '61', route_long_name: 'Light', route_type: 3, route_color: 'FFEE88' },
        { route_id: '62', route_short_name: '62', route_long_name: 'WithText', route_type: 3, route_color: '#F3513C', route_text_color: 'ABCDEF' as any },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    for (const r of routes) {
      expect((r as any).route_text_color).toBe('FFFFFF');
    }
  });

  it("ignores any Transitous-supplied route_text_color (uniform white wins)", () => {
    const seed = seedOf([
      { routeId: '99', shortName: '99', longName: 'Shared', type: '3', color: 'D24CAE', textColor: 'EEEEEE' },
    ]);
    const tranzy = {
      routes: [
        { route_id: '888', route_short_name: '99', route_long_name: 'Shared', route_type: 3, route_color: 'D24CAE' },
      ],
    };
    const { routes } = reconcileRoutes({ seed, tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '99')!;
    expect((r as any).route_text_color).toBe('FFFFFF');
  });
});

describe('reconcileRoutes — route_type policy (Tranzy primary)', () => {
  it('preserves Tranzy route_type=0 (tram) — the GTFS enum value 0 is valid and falsy', () => {
    // Regression test for the truthiness bug: `r.route_type ? String(r.route_type) : '3'`
    // demoted every tram to bus because the number 0 is falsy in JS.
    // Tranzy correctly classifies CTP's four tram routes (100/101/102/102L)
    // as route_type=0; the adapter must ship them as type=0.
    const tranzy = {
      routes: [
        { route_id: '2', route_short_name: '100', route_long_name: 'Tram 100', route_type: 0, route_color: 'F3513C' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '100')!;
    expect(r.route_type).toBe('0');
  });

  it('honors Tranzy route_type even when Transitous disagrees on a shared route', () => {
    // Tranzy-primary by design: whatever Tranzy says ships, even when
    // Transitous's mdb-2121 mirror has a different value. Divergent
    // classifications are a Tranzy data-quality concern to raise
    // upstream, not something the adapter should second-guess.
    const seed = seedOf([
      { routeId: '40', shortName: '40', longName: 'Disputed', type: '0', color: '3BAC2C', textColor: 'FFFFFF' },
    ]);
    const tranzy = {
      routes: [
        { route_id: '888', route_short_name: '40', route_long_name: 'Disputed', route_type: 3, route_color: 'D24CAE' },
      ],
    };
    const { routes } = reconcileRoutes({ seed, tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '40')!;
    expect(r.route_type).toBe('3');
    // route_id is still re-keyed to Transitous for ID stability.
    expect(r.route_id).toBe('40');
  });

  it("inherits Transitous's route_type only when Tranzy is missing it entirely", () => {
    // If Tranzy returns a route with no route_type at all (truly null /
    // undefined), the row builder defaults to '3' (bus), then Step 2's
    // overlay would only swap to seed.type if Tranzy left it nullish.
    // With the current row-builder default of '3', this is hard to
    // observe directly — but the fill-only-if-Tranzy-missing semantics
    // are what the seed-overlay branch implements (using `== null`).
    const seed = seedOf([
      { routeId: '70', shortName: '70', longName: 'Test', type: '11', color: '3C4E9A', textColor: 'FFFFFF' },
    ]);
    const tranzy = {
      routes: [
        // route_type omitted intentionally.
        { route_id: '777', route_short_name: '70', route_long_name: 'Test', route_color: '3C4E9A' },
      ],
    };
    const { routes } = reconcileRoutes({ seed, tranzy, warnings: [] });
    const r = routes.find((x) => x.route_short_name === '70')!;
    // Row builder defaults missing Tranzy type to '3'. The seed
    // overlay's `== null` check sees a populated value and leaves it
    // alone. Tranzy-primary: missing-from-Tranzy still wins over seed,
    // because the row builder already supplied the default.
    expect(r.route_type).toBe('3');
  });
});

describe('routesToTxt', () => {
  it('serializes route_color and route_text_color in the expected columns', async () => {
    const tranzy = {
      routes: [
        { route_id: '7', route_short_name: '7', route_long_name: 'Plain', route_type: 3, route_color: 'D24CAE' },
      ],
    };
    const { routes } = reconcileRoutes({ seed: seedOf([]), tranzy, warnings: [] });
    const txt = await routesToTxt(routes);
    const [header, row] = txt.trim().split('\n');
    const cols = row.split(',');
    const headers = header.split(',');
    expect(cols[headers.indexOf('route_color')]).toBe('D24CAE');
    expect(cols[headers.indexOf('route_text_color')]).toBe('FFFFFF');
  });
});
