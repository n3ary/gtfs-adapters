import Database from 'better-sqlite3';
import { makeSqlite } from '/Users/marius.ciotlos/git/personal/n3ary/gtfs/packages/gtfs-static/src/make-sqlite.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Build a zip with the EXACT same agency.txt the cluj adapter would produce.
// Transitous agency.txt has 1 row. After ensureAgencyTimezone, only the
// timezone column changes.
const dir = join(tmpdir(), 'cluj-test-' + Date.now());
mkdirSync(dir, { recursive: true });

writeFileSync(join(dir, 'agency.txt'),
  'agency_id,agency_name,agency_url,agency_timezone,agency_lang,agency_phone,agency_fare_url\n' +
  '2,CTP Cluj,https://ctpcj.ro/,Europe/Bucharest,ro,+40264430917,https://ctpcj.ro/index.php/ro/tarife/transport-urban\n');

// Minimum other tables so make-sqlite doesn't reject the zip
writeFileSync(join(dir, 'stops.txt'), 'stop_id\nS1\n');
writeFileSync(join(dir, 'routes.txt'), 'route_id,route_type\nR1,3\n');
writeFileSync(join(dir, 'calendar.txt'), 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSVC,1,1,1,1,1,0,0,20260701,20261231\n');
writeFileSync(join(dir, 'trips.txt'), 'route_id,service_id,trip_id\nR1,SVC,T1\n');
writeFileSync(join(dir, 'stop_times.txt'), 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,S1,1\n');

const zipPath = `${dir}.zip`;
spawnSync('zip', ['-j', zipPath, ...['agency.txt', 'stops.txt', 'routes.txt', 'calendar.txt', 'trips.txt', 'stop_times.txt'].map(f => join(dir, f))]);

try {
  const result = await makeSqlite(zipPath, 'test-feed');
  console.log('SUCCESS:', result?.localPath);
  // Read back to verify
  const db = new Database(result!.localPath);
  const rows = db.prepare('SELECT * FROM agency').all();
  console.log('agency rows:', rows);
} catch (err) {
  console.error('FAIL:', err.message);
}
