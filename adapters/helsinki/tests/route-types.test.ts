import { describe, it, expect } from 'vitest';
import {
  hslRouteType,
  computeHslBrandColor,
  type HslMode,
} from '../src/static/route-types.ts';

describe('hslRouteType', () => {
  it('returns metro when pathway_mode=1 even with route_type=0', () => {
    // HSL's metro lines use route_type=0 (tram) historically,
    // with pathway_mode=1 as the real signal.
    expect(hslRouteType({ route_type: 0, pathway_mode: 1 })).toBe('metro');
  });

  it('returns tram when route_type=0 and pathway_mode=0', () => {
    expect(hslRouteType({ route_type: 0, pathway_mode: 0 })).toBe('tram');
  });

  it('returns train when pathway_mode=2', () => {
    expect(hslRouteType({ pathway_mode: 2 })).toBe('train');
  });

  it('returns ferry when pathway_mode=3', () => {
    expect(hslRouteType({ pathway_mode: 3 })).toBe('ferry');
  });

  it('returns bus when route_type=3', () => {
    expect(hslRouteType({ route_type: 3 })).toBe('bus');
  });

  it('returns bus for extended route types (11, 12)', () => {
    expect(hslRouteType({ route_type: 11 })).toBe('bus');
    expect(hslRouteType({ route_type: 12 })).toBe('tram');
  });

  it('falls back to bus for unknown types', () => {
    expect(hslRouteType({ route_type: 99 })).toBe('bus');
    expect(hslRouteType({})).toBe('bus');
  });
});

describe('computeHslBrandColor', () => {
  it('returns the bus blue for buses', () => {
    expect(computeHslBrandColor('bus')).toBe('007AC9');
  });

  it('returns the tram green for trams', () => {
    expect(computeHslBrandColor('tram')).toBe('00985F');
  });

  it('returns the metro orange for metro', () => {
    expect(computeHslBrandColor('metro')).toBe('FF6319');
  });

  it('returns the train purple for trains', () => {
    expect(computeHslBrandColor('train')).toBe('8C4799');
  });

  it('returns the ferry cyan for ferries', () => {
    expect(computeHslBrandColor('ferry')).toBe('00B9E4');
  });

  it('returns 6-char hex without leading #', () => {
    const modes: HslMode[] = ['bus', 'tram', 'metro', 'train', 'ferry'];
    for (const m of modes) {
      const color = computeHslBrandColor(m);
      expect(color).toMatch(/^[0-9A-F]{6}$/);
    }
  });
});
