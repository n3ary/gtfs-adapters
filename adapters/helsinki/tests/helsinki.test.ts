import { describe, it, expect } from 'vitest';
import {
  helsinkiQuirk,
  syntheticHslTripId,
  splitHslVehicleId,
} from '../src/rt/helsinki.js';

// We cast through `unknown` for the FeedMessage / FeedEntity
// shapes because the 1.1.1 bindings types are stricter than the
// runtime protobuf shape (e.g. they require `id` on every
// entity, and they don't expose `StopTimeUpdate.vehicle` at
// all). The runtime quirk only reads/writes the fields HSL
// actually populates, so a loose cast is appropriate here.
type FeedMessage = Parameters<typeof helsinkiQuirk>[0];

describe('syntheticHslTripId', () => {
  it('builds the expected composite key', () => {
    expect(
      syntheticHslTripId({
        routeId: '1003',
        startDate: '20260820',
        startTime: '14:30:00',
        directionId: 0,
      }),
    ).toBe('hsl:1003:20260820:14:30:00:0');
  });

  it('returns null when routeId is empty', () => {
    expect(
      syntheticHslTripId({
        routeId: '',
        startDate: '20260820',
        startTime: '14:30:00',
        directionId: 0,
      }),
    ).toBeNull();
  });

  it('returns null when startDate is empty', () => {
    expect(
      syntheticHslTripId({
        routeId: '1003',
        startDate: '',
        startTime: '14:30:00',
        directionId: 0,
      }),
    ).toBeNull();
  });

  it('returns null when startTime is empty', () => {
    expect(
      syntheticHslTripId({
        routeId: '1003',
        startDate: '20260820',
        startTime: '',
        directionId: 0,
      }),
    ).toBeNull();
  });

  it('returns null when directionId is not 0 or 1', () => {
    expect(
      syntheticHslTripId({
        routeId: '1003',
        startDate: '20260820',
        startTime: '14:30:00',
        directionId: 2,
      }),
    ).toBeNull();
    expect(
      syntheticHslTripId({
        routeId: '1003',
        startDate: '20260820',
        startTime: '14:30:00',
        directionId: -1,
      }),
    ).toBeNull();
  });
});

describe('splitHslVehicleId', () => {
  it('splits HSL operator prefix', () => {
    expect(splitHslVehicleId('HSL/1234')).toEqual({
      operator: 'HSL',
      vehicleNumber: '1234',
    });
  });

  it('splits HRT operator prefix', () => {
    expect(splitHslVehicleId('HRT/5678')).toEqual({
      operator: 'HRT',
      vehicleNumber: '5678',
    });
  });

  it('returns null operator when no slash', () => {
    expect(splitHslVehicleId('1234')).toEqual({
      operator: null,
      vehicleNumber: '1234',
    });
  });

  it('handles empty operator (leading slash)', () => {
    expect(splitHslVehicleId('/1234')).toEqual({
      operator: null,
      vehicleNumber: '1234',
    });
  });

  it('handles empty vehicle number (trailing slash)', () => {
    expect(splitHslVehicleId('HSL/')).toEqual({
      operator: 'HSL',
      vehicleNumber: 'HSL/',
    });
  });
});

describe('helsinkiQuirk', () => {
  function makeFeedMessage(
    entities: unknown[],
  ): FeedMessage {
    return {
      entity: entities.map((e, i) => ({ id: String(i), ...e as object })),
    } as unknown as FeedMessage;
  }

  it('synthesizes trip_id when missing on VehiclePosition', () => {
    const trip = {
      tripId: '',
      routeId: '1003',
      startDate: '20260820',
      startTime: '14:30:00',
      directionId: 0,
    };
    const vehicle = { id: 'HSL/1234', label: '' };
    const fm = makeFeedMessage([{ vehicle: { trip, vehicle } }]);
    helsinkiQuirk(fm);
    const v = (fm as unknown as { entity: Array<{ vehicle: { trip: { tripId: string } } }> })
      .entity[0]!.vehicle;
    expect(v.trip.tripId).toBe('hsl:1003:20260820:14:30:00:0');
  });

  it('does not clobber an existing trip_id', () => {
    const trip = {
      tripId: 'existing-trip',
      routeId: '1003',
      startDate: '20260820',
      startTime: '14:30:00',
      directionId: 0,
    };
    const vehicle = { id: 'HSL/1234', label: '' };
    const fm = makeFeedMessage([{ vehicle: { trip, vehicle } }]);
    helsinkiQuirk(fm);
    const v = (fm as unknown as { entity: Array<{ vehicle: { trip: { tripId: string } } }> })
      .entity[0]!.vehicle;
    expect(v.trip.tripId).toBe('existing-trip');
  });

  it('splits vehicle.id into label when label is empty', () => {
    const trip = {
      tripId: '',
      routeId: '1003',
      startDate: '20260820',
      startTime: '14:30:00',
      directionId: 0,
    };
    const vehicle = { id: 'HSL/1234', label: '' };
    const fm = makeFeedMessage([{ vehicle: { trip, vehicle } }]);
    helsinkiQuirk(fm);
    const v = (fm as unknown as { entity: Array<{ vehicle: { vehicle: { id: string; label: string } } }> })
      .entity[0]!.vehicle.vehicle;
    expect(v.id).toBe('HSL/1234');
    expect(v.label).toBe('1234');
  });

  it('does not clobber an existing vehicle.label', () => {
    const trip = {
      tripId: '',
      routeId: '1003',
      startDate: '20260820',
      startTime: '14:30:00',
      directionId: 0,
    };
    const vehicle = { id: 'HSL/1234', label: 'already-set' };
    const fm = makeFeedMessage([{ vehicle: { trip, vehicle } }]);
    helsinkiQuirk(fm);
    const v = (fm as unknown as { entity: Array<{ vehicle: { vehicle: { id: string; label: string } } }> })
      .entity[0]!.vehicle.vehicle;
    expect(v.label).toBe('already-set');
  });

  it('handles TripUpdate entities with missing trip_id', () => {
    const trip = {
      tripId: '',
      routeId: '2007',
      startDate: '20260820',
      startTime: '08:00:00',
      directionId: 1,
    };
    const fm = makeFeedMessage([{ tripUpdate: { trip } }]);
    helsinkiQuirk(fm);
    const t = (fm as unknown as { entity: Array<{ tripUpdate: { trip: { tripId: string } } }> })
      .entity[0]!.tripUpdate.trip;
    expect(t.tripId).toBe('hsl:2007:20260820:08:00:00:1');
  });

  it('handles TripUpdate.StopTimeUpdate vehicle descriptors', () => {
    const trip = {
      tripId: 'existing',
      routeId: '1003',
      startDate: '20260820',
      startTime: '14:30:00',
      directionId: 0,
    };
    const stuVehicle = { id: 'HRT/5678', label: '' };
    const fm = makeFeedMessage([
      { tripUpdate: { trip, stopTimeUpdate: [{ vehicle: stuVehicle }] } },
    ]);
    helsinkiQuirk(fm);
    const v = (
      (fm as unknown as {
        entity: Array<{
          tripUpdate: { stopTimeUpdate: Array<{ vehicle: { id: string; label: string } }> };
        }>;
      }).entity[0]!.tripUpdate.stopTimeUpdate[0]!.vehicle
    );
    expect(v.id).toBe('HRT/5678');
    expect(v.label).toBe('5678');
  });

  it('does not synthesize trip_id when the composite is incomplete', () => {
    const trip = {
      tripId: '',
      routeId: '',
      startDate: '',
      startTime: '',
      directionId: 0,
    };
    const vehicle = { id: 'HSL/1234', label: '' };
    const fm = makeFeedMessage([{ vehicle: { trip, vehicle } }]);
    helsinkiQuirk(fm);
    const v = (fm as unknown as { entity: Array<{ vehicle: { trip: { tripId: string } } }> })
      .entity[0]!.vehicle;
    // Empty composite → no synthetic key. tripId stays empty.
    expect(v.trip.tripId).toBe('');
  });

  it('returns the same FeedMessage (mutates in place)', () => {
    const trip = {
      tripId: '',
      routeId: '1003',
      startDate: '20260820',
      startTime: '14:30:00',
      directionId: 0,
    };
    const vehicle = { id: 'HSL/1234', label: '' };
    const fm = makeFeedMessage([{ vehicle: { trip, vehicle } }]);
    const result = helsinkiQuirk(fm);
    expect(result).toBe(fm);
  });
});
