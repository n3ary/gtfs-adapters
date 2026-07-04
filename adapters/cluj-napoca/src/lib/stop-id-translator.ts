// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Transitous → Tranzy stop_id translation.
 *
 * The two sources use **different `stop_id` namespaces** for the same
 * physical stops:
 *   - Tranzy uses small numeric IDs (1, 2, 3, ...)
 *   - Transitous uses larger numeric IDs (247, 248, 215, ...)
 *
 * Since Tranzy is the primary catalog (per `docs/assemble-rules.md`),
 * `byStopId` is keyed by Tranzy's stop_ids. But Transitous's patterns
 * (`seedPatternsByRouteDir`) reference stops by Transitous's stop_ids.
 * Without translation, the pattern → orderedStops lookup in trips.js
 * silently misses for every trip and the CSV-driven output collapses
 * to ~342 trips instead of ~14,000.
 *
 * Match strategy:
 *   1. Normalize stop names (lowercase, strip diacritics + punctuation)
 *      and group both sources by normalized name.
 *   2. For each Transitous stop, find the Tranzy stop with the same
 *      normalized name AND a coordinate distance under `MAX_MATCH_M`.
 *   3. If multiple matches, pick the closest. If zero matches, leave
 *      unmapped (the Transitous stop is likely Tranzy-omitted).
 *
 * Heuristic thresholds (tunable):
 *   - MAX_MATCH_M = 50 — generous enough to catch stops that have been
 *     moved a few meters between snapshots of the operator's data.
 *   - NORMALIZE_STRIP_RE = non-word chars (keep letters + digits only)
 */

/**
 * Max coordinate distance (degrees) for a Transitous→Tranzy stop match.
 * Used only as a tiebreaker when MULTIPLE Tranzy stops share the same
 * normalized name (rare — same name across opposite platforms). NOT
 * used to gate name-based matches, because urban stops are densely
 * packed: two stops on opposite sides of the same street can be 5-10
 * meters apart, well within any reasonable haversine threshold.
 *
 * ≈0.0001° ≈ 11m at Cluj's latitude — tight enough to distinguish
 * platforms, loose enough to absorb GPS jitter (typically 3-8m).
 */
const MAX_MATCH_DEG = 0.0001;

/** Normalize a stop name for grouping. */
function normalizeName(s) {
  return (s ?? '').toString().toLowerCase()
    .replace(/ă/g, 'a').replace(/â/g, 'a').replace(/î/g, 'i')
    .replace(/ș/g, 's').replace(/ț/g, 't')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Squared euclidean distance in degree-space. Avoids haversine
 * overhead — we only use this as a tiebreaker between name-matching
 * candidates that are already known to be nearby. */
function degDistSq(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Build a Map<transitousStopId, tranzyStopId> for the stops that
 * Transitous and Tranzy both publish under different ids. Stops that
 * one source omits (e.g. Tranzy-only newer metropolitan stops,
 * Transitous-only legacy stops) are unmapped.
 *
 * Matching policy:
 *   - PRIMARY: normalized name match. The two sources publish the
 *     same name for the same physical stop almost always (verified
 *     empirically — see src/lib/stop-id-translator.js comment).
 *   - TIEBREAKER (only when MULTIPLE Tranzy candidates share the name):
 *     pick the Tranzy stop closest in coordinates, capped at
 *     MAX_MATCH_DEG. We intentionally do NOT gate on coords alone —
 *     see the haversine warning in the module doc.
 *
 * @param {Array<{stop_id, stop_name, stop_lat, stop_lon}>} tranzyStops
 * @param {Array<{stopId, name, lat, lon}>} transitousStops
 * @returns {Map<string, string>}
 */
export function buildTransitousToTranzyMap(tranzyStops, transitousStops) {
  const map = new Map();
  if (!Array.isArray(tranzyStops) || !Array.isArray(transitousStops)) return map;

  // Bucket Tranzy by normalized name.
  const tranzyByName = new Map();
  for (const ts of tranzyStops) {
    const name = normalizeName(ts.stop_name);
    if (!name) continue;
    const lat = parseFloat(ts.stop_lat);
    const lon = parseFloat(ts.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!tranzyByName.has(name)) tranzyByName.set(name, []);
    tranzyByName.get(name).push({ id: String(ts.stop_id), lat, lon });
  }

  for (const xs of transitousStops) {
    const name = normalizeName(xs.name);
    if (!name) continue;
    const lat = parseFloat(xs.lat);
    const lon = parseFloat(xs.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const candidates = tranzyByName.get(name);
    if (!candidates || candidates.length === 0) continue;
    // Single candidate → unambiguous match. Most stops fall in this
    // bucket; name is enough.
    if (candidates.length === 1) {
      map.set(String(xs.stopId), candidates[0].id);
      continue;
    }
    // Multiple Tranzy stops share the name — pick closest, capped.
    let best = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const d = degDistSq(lat, lon, c.lat, c.lon);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    }
    if (best && bestD <= MAX_MATCH_DEG * MAX_MATCH_DEG) {
      map.set(String(xs.stopId), best.id);
    }
  }
  return map;
}