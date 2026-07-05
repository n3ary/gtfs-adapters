// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).

import { CalendarRowSchema, serializeRows } from '@n3ary/gtfs-spec/spec';

// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity (tsc check, tsx run).
/**
 * Calendar reconciliation.
 *
 * Source: the service_id keys we actually scraped from CSV.
 * Mapping (LV/S/D/LD → weekday bits) is hard-coded — Cluj uses the
 * standard Romanian service-day naming:
 *
 *   LV (Luni-Vineri) = Mon-Fri
 *   S  (Sâmbătă)    = Sat
 *   D  (Duminică)   = Sun
 *   LD (Zilnic)     = every day
 *
 * Date window: today + `GTFS_CALENDAR_DAYS` (default 180). The feed is
 * published daily, so this is "next 6 months from build date".
 *
 * Routes that don't have any trips (suspended, no CSV, no pattern) are
 * silently absent from calendar.txt — that's correct, GTFS doesn't
 * require every service_id to appear.
 */

const SERVICE_WEEKDAYS = {
  LV: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 0, sun: 0 },
  S:  { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 1, sun: 0 },
  D:  { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 1 },
  LD: { mon: 1, tue: 1, wed: 1, thu: 1, fri: 1, sat: 1, sun: 1 },
};

/**
 * @param {{
 *   serviceIds: Set<string>,
 *   daysAhead?: number,
 *   buildDate?: Date,
 * }} input
 * @returns {{
 *   rows: Array<{
 *     service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
 *     start_date, end_date,
 *   }>,
 *   unknownServiceIds: string[],
 * }}
 */
export function reconcileCalendar({ serviceIds, daysAhead = 180, buildDate = new Date() }) {
  const rows = [];
  const unknownServiceIds = [];
  for (const serviceId of serviceIds) {
    const wd = SERVICE_WEEKDAYS[serviceId];
    if (!wd) {
      unknownServiceIds.push(serviceId);
      continue;
    }
    rows.push({
      service_id: serviceId,
      monday: String(wd.mon),
      tuesday: String(wd.tue),
      wednesday: String(wd.wed),
      thursday: String(wd.thu),
      friday: String(wd.fri),
      saturday: String(wd.sat),
      sunday: String(wd.sun),
      start_date: yyyymmdd(buildDate),
      end_date: yyyymmdd(addDays(buildDate, daysAhead)),
    });
  }
  return { rows, unknownServiceIds };
}

function yyyymmdd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export async function calendarToTxt(rows) {
  // Spec-driven serializer — same pattern as stopsToTxt/routesToTxt.
  return serializeRows(CalendarRowSchema, rows);
}

export const SUPPORTED_SERVICE_IDS = Object.keys(SERVICE_WEEKDAYS);