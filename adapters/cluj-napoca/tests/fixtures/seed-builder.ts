// @ts-nocheck - full typing is a follow-up; this file was converted to .ts for tooling parity.
/**
 * Builds a Transitous seed zip from canned fixtures in `tests/fixtures`.
 * Used by reconcile/CLI tests so they don't hit the network.
 */

import { createWriteStream } from 'node:fs';
import { ZipArchive } from 'archiver';
import { fixtures } from './index';

export async function buildFixtureSeedZip(outPath) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(outPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.append(fixtures.agencyTxt, { name: 'agency.txt' });
    archive.append(fixtures.routesTxt, { name: 'routes.txt' });
    archive.append(fixtures.stopsTxt, { name: 'stops.txt' });
    archive.append(fixtures.tripsTxt, { name: 'trips.txt' });
    archive.append(fixtures.stopTimesTxt, { name: 'stop_times.txt' });
    archive.append(fixtures.shapesTxt, { name: 'shapes.txt' });
    archive.finalize();
  });
}

export function buildFixtureSeedMemory() {
  // Returns an in-memory representation directly, avoiding unzip.
  return {
    agencyTxt: fixtures.agencyTxt,
    routes: parseRoutes(fixtures.routesTxt),
    stops: parseStops(fixtures.stopsTxt),
    trips: parseTrips(fixtures.tripsTxt),
    stopTimes: parseStopTimes(fixtures.stopTimesTxt),
    shapesById: parseShapes(fixtures.shapesTxt),
    seedDir: '<memory>',
  };
}

function parseRoutes(txt) {
  return splitCsv(txt).slice(1).map((cols) => ({
    routeId: cols[0],
    shortName: cols[2],
    longName: cols[3],
    type: cols[4],
    color: cols[5] || '',
  }));
}

function parseStops(txt) {
  return splitCsv(txt).slice(1).map((cols) => ({
    stopId: cols[0],
    name: cols[2],
    lat: parseFloat(cols[3]),
    lon: parseFloat(cols[4]),
  }));
}

function parseTrips(txt) {
  return splitCsv(txt).slice(1).map((cols) => ({
    routeId: cols[0],
    serviceId: cols[1],
    tripId: cols[2],
    headsign: cols[3],
    directionId: cols[4] ? Number(cols[4]) : 0,
    shapeId: cols[5],
  }));
}

function parseStopTimes(txt) {
  /** @type {Map<string, any[]>} */
  const map = new Map();
  for (const cols of splitCsv(txt).slice(1)) {
    const entry = { stopId: cols[3], sequence: Number(cols[4]) };
    if (!map.has(cols[0])) map.set(cols[0], []);
    map.get(cols[0]).push(entry);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.sequence - b.sequence);
  return map;
}

function parseShapes(txt) {
  /** @type {Map<string, any[]>} */
  const map = new Map();
  for (const cols of splitCsv(txt).slice(1)) {
    const id = cols[0];
    if (!map.has(id)) map.set(id, []);
    map.get(id).push({
      lat: parseFloat(cols[1]),
      lon: parseFloat(cols[2]),
      seq: Number(cols[3]),
    });
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.seq - b.seq);
    for (const p of arr) delete p.seq;
  }
  return map;
}

function splitCsv(txt) {
  const lines = txt.trim().split(/\r?\n/);
  return lines.map((l) => {
    const out = [];
    let cur = '';
    let inQ = false;
    for (const c of l) {
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  });
}