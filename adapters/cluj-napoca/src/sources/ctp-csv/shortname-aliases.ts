// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Tranzy → CTP shortName alias map.
 *
 * Tranzy sometimes shortens route names in a way that doesn't match CTP's
 * CSV URL convention. The known case today: Tranzy publishes route 186
 * as `39C`, but CTP's CSV is at `orar_39CREIC_lv.csv` (no space,
 * full "CREIC" suffix). Transitous carries it as `39 CREIC` (with space).
 *
 * We don't want to depend on Transitous for URL translation — Tranzy is
 * authoritative for what CTP operates. So: maintain a small explicit
 * map of Tranzy's shortName → CTP's CSV shortName.
 *
 * Add entries here when a Tranzy route's shortName 404s on CSV fetch.
 * The smoke stage's WAF-classified 404 list will surface them — wire
 * those findings into this map and the next build resolves cleanly.
 *
 * @type {Record<string, string>}
 */
export const TRANZY_TO_CTP_SHORTNAME = Object.freeze({
  // Tranzy: "39C" → CTP: "39CREIC" (route_id 186).
  // Verified 2026-06-29: `ctpcj.ro/orare/csv/orar_39CREIC_lv.csv` returns
  // a real CSV; `orar_39C_lv.csv` returns 404.
  '39C': '39CREIC',
});

/**
 * Resolve any catalog-side route_short_name to its canonical CTP form.
 *
 * The canonical form is what CTP uses in its CSV URLs and what every
 * CSV-IO function should use as its identifier key (file name,
 * byRouteService map key, manifest entries, route lookup). All four
 * funnel through here so we only have one place that knows about the
 * alias map + whitespace rule.
 *
 *   - Tranzy publishes `39C`          → canonical `39CREIC`
 *   - Transitous publishes `39 CREIC` → canonical `39CREIC`
 *   - Tranzy publishes `22`           → canonical `22`
 *
 * The result is also used as the filename inside `.build-input/csv/`,
 * so e.g. `csv/39CREIC_lv.csv` is the only file written for route 186
 * regardless of which catalog entry the fetch-stage started from.
 *
 * Catalog-side names (the values Tranzy and Transitous actually
 * publish) are still preserved in the `route_short_name` column of
 * `routes.txt` — this helper only touches CSV-IO identifiers.
 *
 * @param {string} shortName
 * @returns {string}
 */
export function canonicalShortName(shortName) {
  const aliased = TRANZY_TO_CTP_SHORTNAME[shortName] ?? shortName;
  return aliased.replace(/\s+/g, '');
}