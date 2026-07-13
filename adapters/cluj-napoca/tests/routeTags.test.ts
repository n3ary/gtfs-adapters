// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity.
import { describe, it, expect } from 'vitest';

import { buildRouteTags, formatRouteTagsSummary } from '../src/assemble/emit/routeTags.ts';

/**
 * Unit tests for the `_route_tags` producer extension. The emitter
 * reads the structured `routeTags` map produced by
 * `applyRouteCategory` (see `routeCategory.ts`) and emits a CSV
 * body. These tests pin the column order, the sort stability, and
 * the empty-case behavior. End-to-end coverage (CSV in the zip +
 * SQLite table) lives in `tests/static/extension.test.ts`.
 */

describe('buildRouteTags — _route_tags producer extension', () => {
  it('returns empty string for an empty map', () => {
    expect(buildRouteTags(new Map())).toBe('');
  });

  it('returns empty string for null/undefined (defensive against orchestrator bugs)', () => {
    // Defensive: the orchestrator is supposed to always pass a
    // Map, but a missing destructure in a future refactor should
    // not throw — graceful "no output" is the safer default.
    expect(buildRouteTags(null)).toBe('');
    expect(buildRouteTags(undefined)).toBe('');
  });

  it('emits the CSV header + one row per (tag_id, route_id) for 1:1 routes', () => {
    const routeTags = new Map();
    routeTags.set('93', [{ id: 'school', label: 'Transport Elevi', priority: 1, icon: 'graduation-cap' }]);
    routeTags.set('15', [{ id: 'night', label: 'Noapte', priority: 3, icon: 'moon' }]);
    const csv = buildRouteTags(routeTags);
    const lines = csv.trim().split('\n');
    // Header + 2 rows.
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('tag_id,route_id,tag_label,priority,icon');
    // Rows are sorted by (route_id, priority) — see the next test for
    // sort behavior. The first row alphabetically is route '15'.
    expect(lines[1]).toBe('night,15,Noapte,3,moon');
    expect(lines[2]).toBe('school,93,Transport Elevi,1,graduation-cap');
  });

  it('emits one row per (tag_id, route_id) for 1:many routes (n:m)', () => {
    // The signature 1:many case: an M26U is both `festival` AND
    // `metroline`. The full n:m mapping must appear here, not just
    // the priority-pick (which is what `route_networks.txt` carries).
    const routeTags = new Map();
    routeTags.set('26', [
      { id: 'festival', label: 'Untold', priority: 2, icon: 'music' },
      { id: 'metroline', label: 'Metropolitan', priority: 5, icon: 'map-pin' },
    ]);
    const csv = buildRouteTags(routeTags);
    const lines = csv.trim().split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe('tag_id,route_id,tag_label,priority,icon');
    // 1:many route's rows are in TAGS declaration order
    // (priority ascending). festival is index 2, metroline is index 5.
    expect(lines[1]).toBe('festival,26,Untold,2,music');
    expect(lines[2]).toBe('metroline,26,Metropolitan,5,map-pin');
  });

  it('emits rows sorted by (route_id, priority) for diff stability', () => {
    // Insertion order should NOT affect the output — Map iteration
    // order is insertion order, which depends on the upstream route
    // order, and we don't want re-orderings of the input to cause
    // spurious CSV diffs. The sort is part of the contract.
    const routeTags = new Map();
    routeTags.set('Z', [{ id: 'metroline', label: 'Metropolitan', priority: 5, icon: 'map-pin' }]);
    routeTags.set('A', [{ id: 'school', label: 'Transport Elevi', priority: 1, icon: 'graduation-cap' }]);
    routeTags.set('M', [
      { id: 'school', label: 'Transport Elevi', priority: 1, icon: 'graduation-cap' },
      { id: 'metroline', label: 'Metropolitan', priority: 5, icon: 'map-pin' },
    ]);
    const csv = buildRouteTags(routeTags);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('tag_id,route_id,tag_label,priority,icon');
    expect(lines[1]).toBe('school,A,Transport Elevi,1,graduation-cap');
    expect(lines[2]).toBe('school,M,Transport Elevi,1,graduation-cap');
    expect(lines[3]).toBe('metroline,M,Metropolitan,5,map-pin');
    expect(lines[4]).toBe('metroline,Z,Metropolitan,5,map-pin');
  });

  it('preserves tag_label verbatim in the row (denormalized for fast reads)', () => {
    // Consumers should NOT have to join `networks.txt` to get the
    // human label — the row carries the label as a producer
    // convenience. Pin the verbatim copy.
    const routeTags = new Map();
    routeTags.set('R', [{ id: 'festival', label: 'Untold', priority: 2, icon: 'music' }]);
    const csv = buildRouteTags(routeTags);
    const lines = csv.trim().split('\n');
    expect(lines[1]).toBe('festival,R,Untold,2,music');
  });

  it('pins the CSV header order: tag_id, route_id, tag_label, priority, icon', () => {
    // Column order is part of the producer-extension contract (the
    // spec doesn't define it). Consumers (e.g. neary's chip
    // rendering) parse by column name, but the order matters for
    // human readers + downstream SQLite imports. Pin it.
    const routeTags = new Map();
    routeTags.set('R', [{ id: 'school', label: 'Transport Elevi', priority: 1, icon: 'graduation-cap' }]);
    const csv = buildRouteTags(routeTags);
    expect(csv).toMatch(/^tag_id,route_id,tag_label,priority,icon\n/);
  });

  it('omits icon column when the tag has no icon (defensive: empty string)', () => {
    // A future tag entry without an `icon` field should not crash
    // the emitter and should produce an empty cell. Pin the
    // column-count + non-crash contract; the empty cell is the
    // signal to the consumer to fall back to its default icon.
    const routeTags = new Map();
    routeTags.set('R', [{ id: 'festival', label: 'Untold', priority: 2 }]);
    const csv = buildRouteTags(routeTags);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('tag_id,route_id,tag_label,priority,icon');
    expect(lines[1]).toBe('festival,R,Untold,2,');
  });
});

describe('formatRouteTagsSummary — build-log helper', () => {
  it('formats row count + route count + 1:many count', () => {
    const routeTags = new Map();
    routeTags.set('A', [{ id: 'school', label: 'Transport Elevi', priority: 1 }]);
    routeTags.set('B', [
      { id: 'school', label: 'Transport Elevi', priority: 1 },
      { id: 'metroline', label: 'Metropolitan', priority: 5 },
    ]);
    routeTags.set('C', [
      { id: 'school', label: 'Transport Elevi', priority: 1 },
      { id: 'metroline', label: 'Metropolitan', priority: 5 },
      { id: 'festival', label: 'Untold', priority: 2 },
    ]);
    // 1 + 2 + 3 = 6 rows, 3 routes, 2 are 1:many.
    expect(formatRouteTagsSummary(routeTags)).toBe('6 rows covering 3 route(s) (2 1:many)');
  });

  it('returns empty string for empty map', () => {
    expect(formatRouteTagsSummary(new Map())).toBe('');
  });

  it('returns "0 1:many" when no route matches multiple tags', () => {
    const routeTags = new Map();
    routeTags.set('A', [{ id: 'school', label: 'Transport Elevi', priority: 1 }]);
    routeTags.set('B', [{ id: 'night', label: 'Noapte', priority: 3 }]);
    expect(formatRouteTagsSummary(routeTags)).toBe('2 rows covering 2 route(s) (0 1:many)');
  });

  it('returns empty string for null/undefined (defensive)', () => {
    expect(formatRouteTagsSummary(null)).toBe('');
    expect(formatRouteTagsSummary(undefined)).toBe('');
  });
});
