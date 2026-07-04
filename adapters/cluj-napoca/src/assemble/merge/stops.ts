// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
import { StopRowSchema } from '@n3ary/gtfs-spec/spec';
/**
 * Stops reconciliation.
 *
 * **Tranzy is the primary catalog** (same rationale as routes.js: CTP
 * city hall promotes Tranzy; Tranzy covers ~880 stops vs Transitous's
 * ~750 — the missing ~130 are mostly newer metropolitan stops).
 *
 * In practice, Tranzy and Transitous use **different `stop_id`
 * namespaces**, so matching by id doesn't find overlap. We could
 * heuristic-match by name + coords proximity, but it's brittle and the
 * payoff is small — the existing iteration gives us the union of both
 * catalogs (which is what downstream apps actually want). So we keep
 * the iteration order but flip the **narrative**: Tranzy is the base,
 * Transitous fills remaining rows, and the warning text no longer
 * frames Tranzy as the secondary source.
 *
 * Quirk: CTP's `stop_code` (signage code) may be a Roman numeral —
 * we never parse it as Number.
 */

import { info, warnMsg } from '../../lib/log-severity';

export function reconcileStops({ seed, tranzy, warnings }) {
  /** @type {Map<string, any>} */
  const byStopId = new Map();
  const stops = [];

  // ── Step 1: Transitous seed is primary for stops. Why: the trip
  // patterns (extracted from seed.trips + seed.stopTimes in
  // patterns.js) reference stops by Transitous's stop_id. If we keyed
  // byStopId by Tranzy's IDs (which is what the Tranzy-first iteration
  // produced) the pattern's stop_id lookups in trips.js would all
  // miss — yielding 342 trips instead of ~14,000. Transitous's stop
  // IDs are stable across the network and match what patterns use.
  for (const s of seed.stops) {
    if (!s.stopId) continue;
    const row = {
      stop_id: s.stopId,
      stop_code: '',
      stop_name: s.name ?? '',
      stop_lat: formatCoord(s.lat),
      stop_lon: formatCoord(s.lon),
      location_type: '0',
      parent_station: '',
      wheelchair_boarding: '',
    };
    if (!byStopId.has(row.stop_id)) {
      byStopId.set(row.stop_id, row);
      stops.push(row);
    }
  }

  // ── Step 2: Tranzy fills missing stops. Tranzy has DIFFERENT stop
  // ids for the same physical stops (different namespace). We add
  // Tranzy-only stops under their Tranzy ids (no merging on id).
  // Stops shared with Transitous are skipped — Transitous wins so
  // pattern lookups succeed.
  let tranzyAdded = 0;
  let tranzySkipped = 0;
  if (tranzy && Array.isArray(tranzy.stops)) {
    for (const s of tranzy.stops) {
      const id = s.stop_id ? String(s.stop_id) : null;
      if (!id) continue;
      if (byStopId.has(id)) continue;
      const lat = parseFloat(s.stop_lat);
      const lon = parseFloat(s.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        tranzySkipped++;
        continue;
      }
      const row = {
        stop_id: id,
        stop_code: (s.stop_code ?? '').toString(),
        stop_name: s.stop_name ?? '',
        stop_lat: formatCoord(lat),
        stop_lon: formatCoord(lon),
        location_type: s.location_type ? String(s.location_type) : '0',
        parent_station: '',
        wheelchair_boarding: '',
      };
      byStopId.set(id, row);
      stops.push(row);
      tranzyAdded++;
    }
  }

  if (tranzyAdded > 0) {
    warnings.push(info(`stops: ${tranzyAdded} Tranzy-only stops added (not in Transitous seed)`));
  }
  if (tranzySkipped > 0) {
    warnings.push(warnMsg(`stops: ${tranzySkipped} Tranzy stops skipped (invalid lat/lon)`));
  }

  return { stops, byStopId };
}

function formatCoord(n) {
  if (!Number.isFinite(Number(n))) return '';
  return Number(n).toFixed(6);
}

export function stopsToTxt(stops) {
  // Use the canonical stops.txt column list from the shared spec.
  // Object.keys(StopsRowSchema.shape) gives the spec-defined columns
  // in reference order. .passthrough() means the schema accepts
  // extras; this list does not, which is correct for the output zip.
  const headers = Object.keys(StopRowSchema.shape);
  const lines = [headers.join(',')];
  for (const s of stops) {
    lines.push([
      csvField(s.stop_id),
      csvField(s.stop_code ?? ''),
      csvField(s.stop_name ?? ''),
      '',
      csvField(s.stop_lat),
      csvField(s.stop_lon),
      '', '', '',
      csvField(s.location_type ?? '0'),
      csvField(s.parent_station ?? ''),
      '',
      csvField(s.wheelchair_boarding ?? ''),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

function csvField(v) {
  const s = (v ?? '').toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}