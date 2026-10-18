import { describe, expect, it } from 'vitest';
import { ArrivalGate, CorridorEstimate, type LabPlan } from './movement-model';

const plan: LabPlan = {
  title: 'Test floor',
  floor: '1',
  width: 100,
  height: 100,
  entryId: 'entry',
  entryLabel: 'Point 19',
  entryEvidence: 'Test fixture',
  metresPerUnit: null,
  northDegrees: null,
  underlay: '/test.svg',
  nodes: [
    { id: 'entry', label: '19', kind: 'photo', x: 0, y: 0 },
    { id: 'turn', label: '20', kind: 'photo', x: 10, y: 0 },
    { id: 'end', label: '21', kind: 'photo', x: 10, y: 10 },
    { id: 'across-wall', label: '22', kind: 'photo', x: 0, y: 2 },
  ],
  edges: [
    { from: 'entry', to: 'turn' },
    { from: 'turn', to: 'end' },
  ],
  nearby: [],
  outdoor: {
    lat: 43.78838,
    lng: -79.19103,
    radiusM: 70,
    maxAccuracyM: 20,
    label: 'Provisional building centre',
    coordinateEvidence: 'Fixture',
    coordinateSource: '',
    addressSource: '',
  },
};
const fix = (timestamp: number, accuracy = 5) => ({
  lat: plan.outdoor.lat,
  lng: plan.outdoor.lng,
  accuracy,
  timestamp,
});

describe('GPS proximity gate', () => {
  it('requires accurate, separate fixes and two seconds of dwell', () => {
    const gate = new ArrivalGate();
    expect(gate.update(fix(10000), plan.outdoor, 10000)).toBe(false);
    expect(gate.update(fix(11000), plan.outdoor, 11000)).toBe(false);
    expect(gate.update(fix(12000), plan.outdoor, 12000)).toBe(true);
  });
  it('rejects stale, out of order, future and invalid fixes', () => {
    const gate = new ArrivalGate();
    expect(gate.update(fix(10000), plan.outdoor, 30000)).toBe(false);
    expect(gate.update(fix(30000), plan.outdoor, 30000)).toBe(false);
    expect(gate.update(fix(29000), plan.outdoor, 30000)).toBe(false);
    expect(gate.update(fix(40000), plan.outdoor, 30000)).toBe(false);
    expect(gate.update({ ...fix(32000), lat: NaN }, plan.outdoor, 32000)).toBe(false);
  });
  it('resets dwell on poor accuracy, leaving the geofence, or a long gap', () => {
    const gate = new ArrivalGate();
    gate.update(fix(10000), plan.outdoor, 10000);
    expect(gate.update(fix(12000, 40), plan.outdoor, 12000)).toBe(false);
    expect(gate.update(fix(14000), plan.outdoor, 14000)).toBe(false);
    expect(gate.update({ ...fix(16000), lat: 44 }, plan.outdoor, 16000)).toBe(false);
    expect(gate.update(fix(18000), plan.outdoor, 18000)).toBe(false);
    expect(gate.update(fix(40000), plan.outdoor, 40000)).toBe(false);
    expect(gate.update(fix(42000), plan.outdoor, 42000)).toBe(true);
  });
  it('requires the whole accuracy circle inside the radius', () => {
    const gate = new ArrivalGate();
    const edge = { ...fix(10000, 20), lat: plan.outdoor.lat + 0.0005 };
    expect(gate.update(edge, plan.outdoor, 10000)).toBe(false);
    expect(gate.update({ ...edge, timestamp: 13000 }, plan.outdoor, 13000)).toBe(false);
    expect(gate.update(fix(14000), { ...plan.outdoor, radiusM: -1 }, 14000)).toBe(false);
  });
});

describe('corridor constrained movement estimate', () => {
  it('does not move before measured scale and facing calibration', () => {
    const walk = new CorridorEstimate(plan);
    expect(walk.step(90).advanced).toBe(false);
    expect(walk.position).toEqual({ x: 0, y: 0 });
    expect(() => walk.calibrate('across-wall', 10, 90)).toThrow();
    expect(() => walk.calibrate('turn', -1, 90)).toThrow();
  });
  it('moves along connected edges, holds at a corner, then follows a turn', () => {
    const walk = new CorridorEstimate(plan);
    walk.calibrate('turn', 10, 90);
    for (let i = 0; i < 12; i++) walk.step(90, 1);
    expect(walk.position).toEqual({ x: 10, y: 0 });
    expect(walk.step(180, 1).position).toEqual({ x: 10, y: 1 });
    expect(walk.step(0, 1).position).toEqual({ x: 10, y: 0 });
    expect(walk.step(270, 1).position).toEqual({ x: 9, y: 0 });
  });
  it('rejects a sideways shortcut and requires re-anchoring for new calibration', () => {
    const walk = new CorridorEstimate(plan);
    walk.calibrate('turn', 10, 0);
    expect(walk.step(90, 1).advanced).toBe(false);
    walk.step(0, 1);
    expect(() => walk.calibrate('end', 19, 0)).toThrow(/Re-anchor/);
    walk.anchor();
    expect(walk.headingOffset).toBeNull();
    expect(walk.step(0).advanced).toBe(false);
  });
  it('cannot jump to a physically nearby disconnected component', () => {
    const walk = new CorridorEstimate(plan);
    walk.anchor('across-wall');
    expect(walk.pathTo('entry')).toBeNull();
    expect(() => walk.calibrate('entry', 2, 0)).toThrow();
  });
});
