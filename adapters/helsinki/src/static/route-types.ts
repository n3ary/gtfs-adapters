/**
 * Helsinki/HSL route-type helpers.
 *
 * HSL's static GTFS uses the standard `routes.route_type` values
 * (per the GTFS spec) but with one quirk: trams share the same
 * route_type=0 (tram) as the metro's older `pathway_mode`. The
 * metro lines are flagged in `routes.pathway_mode` (= 1 for metro,
 * 0 for tram, etc.) rather than via a separate `route_type`.
 *
 * `hslRouteType` is a thin convenience that returns the canonical
 * n3ary "mode" string the app uses, given the GTFS row. It's
 * used by the n3ary app's category/tag rendering, not the
 * adapter's pipeline, but lives here so the categorization
 * is owned by the feed's adapter (not the app).
 *
 * `computeHslBrandColor` returns the official HSL brand color
 * for a given mode, used by the app's category chip fallback
 * when a route ships no `route_color`. Mirrors the public HSL
 * brand palette at https://www.hsl.fi/en/hsl/brand.
 */

export type HslMode = 'bus' | 'tram' | 'metro' | 'train' | 'ferry';

/** GTFS row shape we read. Loosely typed because the adapter
 *  doesn't import the spec row type (the pipeline owns the
 *  strict typing). */
export interface HslRouteRow {
  route_id?: string;
  route_type?: number | null;
  route_short_name?: string | null;
  pathway_mode?: number | null;
}

/**
 * Map a HSL route row to its canonical mode. Falls back to 'bus'
 * (HSL's most common mode) when the row has no recognizable
 * type. Returns 'metro' when pathway_mode=1 even if route_type
 * says tram -- HSL's "metro" lines use this convention.
 */
export function hslRouteType(row: HslRouteRow): HslMode {
  if (row.pathway_mode === 1) return 'metro';
  if (row.pathway_mode === 2) return 'train';
  if (row.pathway_mode === 3) return 'ferry';
  if (row.pathway_mode === 4) return 'bus';
  switch (row.route_type) {
    case 0: return 'tram';
    case 1: return 'metro';
    case 2: return 'train';
    case 3: return 'bus';
    case 4: return 'ferry';
    case 11: return 'bus';
    case 12: return 'tram';
    default: return 'bus';
  }
}

/**
 * HSL official brand color per mode. 6-char uppercase hex (no #).
 * Returns the bus blue as the fallback for unknown modes.
 *
 * Sourced from HSL's public brand palette. Mode color, fallback
 * for when `route_color` is missing on the route row.
 */
export function computeHslBrandColor(mode: HslMode): string {
  switch (mode) {
    case 'bus': return '007AC9'; // HSL bus blue
    case 'tram': return '00985F'; // HSL tram green
    case 'metro': return 'FF6319'; // HSL metro orange
    case 'train': return '8C4799'; // HSL commuter rail purple
    case 'ferry': return '00B9E4'; // HSL ferry cyan
    default: return '007AC9';
  }
}
