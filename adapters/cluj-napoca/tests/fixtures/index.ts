/**
 * Canned Transitous seed (mini).
 * Two routes: 35 (bus, magenta) and M26 (bus, magenta).
 * Routes are in the seed's `routes.txt`.
 *
 * trip 35_out / trip 35_back / trip M26_out — minimal but valid.
 */

const AGENCY_TXT = `agency_id,agency_name,agency_url,agency_timezone,agency_phone
2,Compania de Transport Public Cluj-Napoca,https://www.ctpcluj.ro/,Europe/Bucharest,+40 264 430 921
`;

const ROUTES_TXT = `route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_name
35,2,35,Piata Garii - Cart. Zorilor,3,D24CAE,
M26,2,M26,Gara - Selimbar,3,D24CAE,
`;

const STOPS_TXT = `stop_id,stop_code,stop_name,stop_lat,stop_lon
A,,Piata Garii,46.7710,23.6230
B,,Sala Sporturilor,46.7720,23.6280
C,,Cart. Zorilor,46.7700,23.6350
D,,Gara,46.7800,23.6200
E,,Selimbar,46.7850,23.6280
`;

const TRIPS_TXT = `route_id,service_id,trip_id,trip_headsign,direction_id,shape_id
35,LV,seed-35-out,Cart. Zorilor,0,35_0
35,LV,seed-35-back,Piata Garii,1,35_1
M26,LV,seed-M26-out,Selimbar,0,92_0
`;

const STOP_TIMES_TXT = `trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled
seed-35-out,06:00:00,06:00:00,A,0,0
seed-35-out,06:02:00,06:02:00,B,1,500
seed-35-out,06:05:00,06:05:00,C,2,1200
seed-35-back,06:30:00,06:30:00,C,0,0
seed-35-back,06:33:00,06:33:00,B,1,500
seed-35-back,06:35:00,06:35:00,A,2,1200
seed-M26-out,07:00:00,07:00:00,D,0,0
seed-M26-out,07:02:00,07:02:00,E,1,500
`;

const SHAPES_TXT = `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled
35_0,46.7710,23.6230,1,0
35_0,46.7720,23.6280,2,500
35_0,46.7700,23.6350,3,1200
35_1,46.7700,23.6350,1,0
35_1,46.7720,23.6280,2,500
35_1,46.7710,23.6230,3,1200
92_0,46.7800,23.6200,1,0
92_0,46.7850,23.6280,2,500
`;

/**
 * Tiny Tranzy canned response.
 * Adds route 22 (with the orange color — see `neary-gtfs#14`).
 * Adds direction_id=1 trip for M26 (the bug `neary-gtfs#15` is about).
 */
const TRANZY = {
  routes: [
    {
      route_id: '22',
      agency_id: 2,
      route_short_name: '22',
      route_long_name: 'Some Express',
      route_type: 3,
      route_color: 'EF8732', // orange — the exception flagged in #14
      route_text_color: '000000',
    },
    {
      route_id: '92',
      agency_id: 2,
      route_short_name: 'M26',
      route_long_name: 'Gara - Selimbar',
      route_type: 3,
      route_color: 'D24CAE',
    },
  ],
  stops: [],
  trips: [
    // Route 22 needs at least one trip or the phantom-route filter
    // (src/assemble/index.js) drops it from the published feed — the
    // fixture ships this minimal trip so the color-preservation test
    // below can still find route 22 in routes.txt.
    {
      trip_id: 'tranzy-22-fwd',
      route_id: '22',
      direction_id: 0,
      trip_headsign: 'Some Express',
    },
    // M26 direction=1 — only present in Tranzy, missing from seed.
    // Note: real Tranzy uses route_id='92' for M26, but our reconciler
    // matches by route_short_name (see assemble-rules.md § pattern
    // resolution), so for this fixture we use 'M26' to keep the test
    // focused on the "missing direction" path rather than the
    // "different IDs" path.
    {
      trip_id: 'tranzy-M26-back',
      route_id: 'M26',
      direction_id: 1,
      trip_headsign: 'Gara',
      shape_id: '92_1',
    },
  ],
  stop_times: [
    { trip_id: 'tranzy-22-fwd', stop_id: 'E', stop_sequence: 0 },
    { trip_id: 'tranzy-22-fwd', stop_id: 'D', stop_sequence: 1 },
    { trip_id: 'tranzy-M26-back', stop_id: 'E', stop_sequence: 0 },
    { trip_id: 'tranzy-M26-back', stop_id: 'D', stop_sequence: 1 },
  ],
  shapes: [
    { shape_id: '92_1', shape_pt_lat: 46.7850, shape_pt_lon: 23.6280, shape_pt_sequence: 1, shape_dist_traveled: 0 },
    { shape_id: '92_1', shape_pt_lat: 46.7800, shape_pt_lon: 23.6200, shape_pt_sequence: 2, shape_dist_traveled: 500 },
  ],
  calendar: [],
};

/**
 * Tiny CTP CSV canned response for routes 35 and M26 (3 service keys each).
 * M26's LV/dir0 has a frequency annotation cell that should be dropped.
 */
const CSV_35_LV = `route_long_name,"Piata Garii - Cart. Zorilor"
service_name,"Luni - Vineri"
service_start,"01.06.2026"
in_stop_name,"Piata Garii"
out_stop_name,"Cart. Zorilor"
06:00,06:30
06:30,07:00
`;

const CSV_35_S = `route_long_name,"Piata Garii - Cart. Zorilor"
service_name,"Sambata"
service_start,"01.06.2026"
in_stop_name,"Piata Garii"
out_stop_name,"Cart. Zorilor"
07:00,07:30
`;

const CSV_35_D = `route_long_name,"Piata Garii - Cart. Zorilor"
service_name,"Duminica"
service_start,"01.06.2026"
in_stop_name,"Piata Garii"
out_stop_name,"Cart. Zorilor"
08:00,08:30
`;

const CSV_M26_LV = `route_long_name,"Gara - Selimbar"
service_name,"Luni - Vineri"
service_start,"01.06.2026"
in_stop_name,"Selimbar"
out_stop_name,"Gara"
05:05-22:40,05:23
10-20min,05:32
05:41,05:50
`;

const CSV_M26_S = `route_long_name,"Gara - Selimbar"
service_name,"Sambata"
service_start,"01.06.2026"
in_stop_name,"Selimbar"
out_stop_name,"Gara"
06:00,06:30
`;

const CSV_M26_D = `route_long_name,"Gara - Selimbar"
service_name,"Duminica"
service_start,"01.06.2026"
in_stop_name,"Selimbar"
out_stop_name,"Gara"
07:00,07:30
`;

export const fixtures = {
  agencyTxt: AGENCY_TXT,
  routesTxt: ROUTES_TXT,
  stopsTxt: STOPS_TXT,
  tripsTxt: TRIPS_TXT,
  stopTimesTxt: STOP_TIMES_TXT,
  shapesTxt: SHAPES_TXT,
  tranzy: TRANZY,
  csv: {
    '35': { LV: CSV_35_LV, S: CSV_35_S, D: CSV_35_D },
    M26: { LV: CSV_M26_LV, S: CSV_M26_S, D: CSV_M26_D },
  },
};