import { describe, it, expect } from 'vitest';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { clujQuirk, parseClujTripId } from './cluj.ts';

function makeEntity(tripId: string, directionId: number, startTime: string) {
  return GtfsRealtimeBindings.transit_realtime.FeedEntity.create({
    id: 'e1',
    vehicle: GtfsRealtimeBindings.transit_realtime.VehiclePosition.create({
      trip: GtfsRealtimeBindings.transit_realtime.TripDescriptor.create({
        tripId,
        directionId,
        startTime,
      }),
    }),
  });
}

function makeMessage(entity: ReturnType<typeof makeEntity>) {
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.create({
    header: GtfsRealtimeBindings.transit_realtime.FeedHeader.create({
      gtfsRealtimeVersion: '2.0',
      incrementality: GtfsRealtimeBindings.transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
    }),
    entity: [entity],
  });
}

describe('parseClujTripId', () => {
  it('parses a well-formed id (lowercase service, from the static feed)', () => {
    expect(parseClujTripId('38_0_weekday_2_1430')).toEqual({
      routeId: '38',
      dirId: 0,
      serviceId: 'weekday',
      run: 2,
      startTime: '14:30:00',
    });
  });

  it('parses a well-formed id (uppercase service, from the live RT upstream)', () => {
    // Sampled live from https://cluj-rt-feed.gtfs.ro/vehiclePositions
    // on 2026-07-11. The upstream uses short uppercase service ids
    // (e.g. `S`); the quirk's regex must accept those, otherwise
    // every live trip is a silent pass-through - see
    // n3ary/gtfs-publisher#74 and n3ary/gtfs-publisher#36.
    expect(parseClujTripId('23_1_S_80_2138')).toEqual({
      routeId: '23',
      dirId: 1,
      serviceId: 'S',
      run: 80,
      startTime: '21:38:00',
    });
  });

  it('parses a mixed-case service id', () => {
    expect(parseClujTripId('23_1_Sat_2_1430')).toEqual({
      routeId: '23',
      dirId: 1,
      serviceId: 'Sat',
      run: 2,
      startTime: '14:30:00',
    });
  });

  it('returns null on a non-matching id', () => {
    expect(parseClujTripId('not-a-cluj-id')).toBeNull();
    expect(parseClujTripId('')).toBeNull();
  });
});

describe('clujQuirk', () => {
  it('recovers direction_id + start_time when upstream is wrong (lowercase service)', () => {
    const msg = makeMessage(makeEntity('38_0_weekday_2_1430', 0, ''));
    const out = clujQuirk(msg);
    expect(out.entity[0]!.vehicle!.trip!.directionId).toBe(0);
    expect(out.entity[0]!.vehicle!.trip!.startTime).toBe('14:30:00');
  });

  it('recovers direction_id + start_time when upstream is wrong (uppercase service from live RT)', () => {
    // This is the live-RT shape that shipped broken before the
    // regex fix. Direction comes in as 0 (the upstream's bug),
    // start_time is empty, and the service segment is `S`. Before
    // the fix the pattern `[a-z0-9]+` did not match and the quirk
    // bailed out without modifying the entity.
    const msg = makeMessage(makeEntity('23_1_S_80_2138', 0, ''));
    const out = clujQuirk(msg);
    expect(out.entity[0]!.vehicle!.trip!.directionId).toBe(1);
    expect(out.entity[0]!.vehicle!.trip!.startTime).toBe('21:38:00');
  });

  it('leaves already-correct entities alone', () => {
    const msg = makeMessage(makeEntity('38_0_weekday_2_1430', 1, '14:30:00'));
    const out = clujQuirk(msg);
    expect(out.entity[0]!.vehicle!.trip!.directionId).toBe(1);
    expect(out.entity[0]!.vehicle!.trip!.startTime).toBe('14:30:00');
  });

  it('leaves unparseable trip_ids alone', () => {
    const msg = makeMessage(makeEntity('weird-trip-id', 0, ''));
    const out = clujQuirk(msg);
    expect(out.entity[0]!.vehicle!.trip!.directionId).toBe(0);
    expect(out.entity[0]!.vehicle!.trip!.startTime).toBe('');
  });
});
