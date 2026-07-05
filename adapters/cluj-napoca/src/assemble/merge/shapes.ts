// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
import { ShapeRowSchema, serializeRows, type ShapeRow } from '@n3ary/gtfs-spec/spec';
import { haversineMeters } from '@n3ary/gtfs-spec/shape';
/**
 * Shapes reconciliation.
 *
 * **Tranzy is the primary catalog** (same rationale as routes.js and
 * stops.js). Tranzy's shape_ids are the operator's authoritative ones;
 * Transitous's mirror uses its own IDs and is often missing shapes
 * for routes the Transitous upstream doesn't publish.
 *
 * When both sources have a shape with the same `shape_id`, we
 * preserve the Tranzy version (it's the live source). When only
 * Transitous has the shape, we keep Transitous's. When only Tranzy
 * has it, we use Tranzy's.
 *
 * When neither has a shape for a pattern, the build proceeds without
 * `shape_dist_traveled` values being meaningful (haversine fallback
 * in `lib/timing.js`).
 *
 * Tranzy returns shape points as `ShapeRow` (see @n3ary/gtfs-spec).
 * We group by shape_id and emit rows ordered by sequence.
 *
 * Note: `haversineMeters` comes from `@n3ary/gtfs-spec/shape` (the
 * canonical math, shared with the orchestrator's GTFS worker).
 * The previous local copy here was identical but vendored; the spec
 * is the single source of truth.
 */

import { info } from '../../lib/log-severity.ts';

export function reconcileShapes({ seed, tranzy, warnings }) {
  /** @type {Map<string, Array<{lat:number, lon:number, dist?:number}>>} */
  const byShapeId = new Map();

  // ── Step 1: Tranzy is the base catalog. Group points by shape_id,
  // sort by upstream sequence. Tranzy's points are authoritative when
  // both sources publish the same shape_id.
  let tranzyShapeCount = 0;
  if (tranzy && Array.isArray(tranzy.shapes)) {
    /** @type {Map<string, Array<{lat, lon, seq, dist?}>>} */
    const grouped = new Map();
    for (const p of tranzy.shapes) {
      const id = p.shape_id;
      if (!id) continue;
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push({
        lat: parseFloat(p.shape_pt_lat),
        lon: parseFloat(p.shape_pt_lon),
        seq: parseInt(p.shape_pt_sequence, 10),
        dist: parseFloat(p.shape_dist_traveled),
      });
    }
    for (const [id, pts] of grouped.entries()) {
      pts.sort((a, b) => a.seq - b.seq);
      const cleaned = pts
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .map((p) => ({ lat: p.lat, lon: p.lon }));
      if (cleaned.length === 0) continue;
      byShapeId.set(id, cleaned);
      tranzyShapeCount++;
    }
  }

  // ── Step 2: Transitous fills shapes Tranzy doesn't publish. Use
  // Transitous's shape_id as-is (no id remap — Transitous shapes are
  // referenced only by their published shape_id, never by Transitous
  // route_id downstream).
  let transitousAdded = 0;
  for (const [shapeId, pts] of seed.shapesById.entries()) {
    if (!shapeId) continue;
    if (byShapeId.has(shapeId)) continue;
    const cleaned = [];
    for (const p of pts) cleaned.push({ lat: p.lat, lon: p.lon });
    if (cleaned.length === 0) continue;
    byShapeId.set(shapeId, cleaned);
    transitousAdded++;
  }

  // Build-log summary. The previous per-shape warnings (one line per
  // new shape) were too noisy — single line per source now.
  if (tranzyShapeCount > 0) {
    warnings.push(info(`shapes: Tranzy primary catalog — ${tranzyShapeCount} shapes from Tranzy`));
  }
  if (transitousAdded > 0) {
    warnings.push(info(`shapes: ${transitousAdded} Transitous-only shapes (not in Tranzy)`));
  }

  // Flatten to GTFS rows with fresh sequence numbers.
  /** @type {ShapeRow[]} */
  const rows = [];
  for (const [shapeId, pts] of byShapeId.entries()) {
    let cum = 0;
    let prev = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (prev) {
        cum += haversineMeters(prev.lat, prev.lon, p.lat, p.lon);
      }
      rows.push({
        shape_id: shapeId,
        shape_pt_lat: p.lat.toFixed(6),
        shape_pt_lon: p.lon.toFixed(6),
        shape_pt_sequence: String(i + 1),
        shape_dist_traveled: i === 0 ? '' : Math.round(cum).toString(),
      });
      prev = p;
    }
  }

  return { shapesById: byShapeId, rows };
}

export async function shapesToTxt(rows) {
  // Spec-driven serializer — same pattern as stopsToTxt/routesToTxt.
  return serializeRows(ShapeRowSchema, rows);
}