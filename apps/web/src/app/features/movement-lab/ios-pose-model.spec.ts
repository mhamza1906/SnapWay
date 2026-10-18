import { describe, expect, it } from 'vitest';
import { IOSPoseModel, type IOSPose } from './ios-pose-model';
import type { LabPlan } from './movement-model';

const plan: LabPlan = {
  title: 'Synthetic corridor geometry',
  floor: '1',
  width: 20,
  height: 20,
  entryId: 'a',
  entryLabel: '19',
  entryEvidence: 'Fixture only',
  metresPerUnit: null,
  northDegrees: null,
  underlay: '/fixture.svg',
  nearby: [],
  outdoor: {
    lat: 0,
    lng: 0,
    radiusM: 10,
    maxAccuracyM: 2,
    label: '',
    coordinateEvidence: '',
    coordinateSource: '',
    addressSource: '',
  },
  nodes: [
    ['a', 0, 0],
    ['b', 10, 0],
    ['c', 10, 10],
    ['d', 0, 10],
    ['g', 0, 2],
    ['h', 10, 2],
    ['isolated1', 0, -1],
    ['isolated2', 10, -1],
  ].map(([id, x, y]) => ({
    id: String(id),
    label: String(id),
    kind: 'photo',
    x: Number(x),
    y: Number(y),
  })),
  edges: [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'd'],
    ['d', 'g'],
    ['g', 'h'],
    ['isolated1', 'isolated2'],
  ].map(([from, to]) => ({ from, to })),
};
const pose = (x: number, z: number, time: number, changes: Partial<IOSPose> = {}): IOSPose => ({
  x,
  y: 1.5,
  z,
  timestamp: time * 1000,
  monotonicSeconds: time,
  epoch: 'epoch-a',
  tracking: 'normal',
  ...changes,
});
function registered(): IOSPoseModel {
  const model = new IOSPoseModel(plan);
  model.firstAnchor('a', pose(0, 0, 10), 10000);
  expect(model.secondAnchor('b', pose(5, 0, 11), 11000).status).toBe('registered');
  return model;
}

describe('iOS ARKit to SVG registration and corridor constraints', () => {
  it('offers only compatible straight connected second anchors', () => {
    const candidates = new IOSPoseModel(plan).calibrationCandidates('a').map((node) => node.id);
    expect(candidates).toContain('b');
    expect(candidates).not.toContain('a');
    expect(candidates).not.toContain('c');
    expect(candidates).not.toContain('isolated2');
  });
  it('registers arbitrary world rotation and metre scale, then follows a connected turn', () => {
    const model = new IOSPoseModel(plan);
    model.firstAnchor('a', pose(10, 10, 10), 10000);
    const calibration = model.secondAnchor('b', pose(10, 15, 11), 11000);
    expect(calibration.metresPerUnit).toBeCloseTo(0.5);
    const result = model.project(pose(9, 15, 12), 12000);
    expect(result.status).toBe('tracking');
    expect(result.position!.x).toBeCloseTo(10);
    expect(result.position!.y).toBeCloseTo(2);
    expect(result.rawPosition!.y).toBeCloseTo(2);
    expect(result.lateralErrorM).toBeCloseTo(0);
  });

  it('rejects short, disconnected, curved and vertically different calibration baselines', () => {
    const model = new IOSPoseModel(plan);
    model.firstAnchor('a', pose(0, 0, 10), 10000);
    expect(model.secondAnchor('b', pose(1, 0, 11), 11000).status).toBe('held');
    expect(model.secondAnchor('isolated2', pose(5, 0, 11), 11000).status).toBe('held');
    expect(model.secondAnchor('c', pose(5, 5, 11), 11000).status).toBe('held');
    expect(model.secondAnchor('b', pose(5, 0, 11, { y: 3.1 }), 11000).status).toBe(
      'anchor-required',
    );
    expect(model.registered).toBe(false);
  });

  it('never snaps to an adjacent disconnected corridor or a nearby distant loop segment', () => {
    const model = registered();
    // Isolated y=-1 is the exact raw match, but cannot be reached from the current edge.
    const acrossWall = model.project(pose(4, -0.5, 12), 12000);
    expect(acrossWall.position).toEqual({ x: 8, y: 0 });
    // The y=2 loop is also nearby but its graph distance exceeds actual camera displacement.
    const distantLoop = model.project(pose(4, 1, 13), 13000);
    expect(distantLoop.position).toEqual({ x: 8, y: 0 });
    expect(distantLoop.lateralErrorM).toBe(1);
  });

  it('freezes off corridor, rejects old poses, and invalidates on tracking loss or epoch change', () => {
    const model = registered();
    const held = model.project(pose(7, -3, 12), 12000);
    expect(held.status).toBe('held');
    expect(held.position).toEqual({ x: 10, y: 0 });
    expect(model.project(pose(5, 0, 11.5), 11500).status).toBe('held');
    expect(model.project(pose(5, 0, 13, { tracking: 'limited' }), 13000).status).toBe(
      'anchor-required',
    );
    expect(model.project(pose(5, 0, 14), 14000).status).toBe('anchor-required');
    const restart = registered();
    expect(restart.project(pose(5, 0, 12, { epoch: 'epoch-b' }), 12000).status).toBe(
      'anchor-required',
    );
    expect(restart.registered).toBe(false);
  });

  it('invalidates stale poses and possible floor changes without resuming automatically', () => {
    const stale = registered();
    expect(stale.project(pose(5, 0, 12), 13001).status).toBe('anchor-required');
    expect(stale.registered).toBe(false);
    const floor = registered();
    const result = floor.project(pose(5, 0, 12, { y: 3.1 }), 12000);
    expect(result.position).toEqual({ x: 10, y: 0 });
    expect(floor.registered).toBe(false);
  });

  it('invalidates a normal-tracking world jump rather than teleporting along a connected corridor', () => {
    const longCorridor: LabPlan = {
      ...plan,
      nodes: [...plan.nodes, { id: 'far', label: 'Far', kind: 'photo', x: 100, y: 0 }],
      edges: [...plan.edges, { from: 'b', to: 'far' }],
    };
    const model = new IOSPoseModel(longCorridor);
    model.firstAnchor('a', pose(0, 0, 10), 10000);
    model.secondAnchor('b', pose(5, 0, 11), 11000);
    const jump = model.project(pose(35, 0, 11.1), 11100);
    expect(jump.status).toBe('anchor-required');
    expect(jump.position).toEqual({ x: 10, y: 0 });
    expect(model.registered).toBe(false);
  });

  it('applies explicit paired visual correction without changing scale or rewinding pose ordering', () => {
    const model = registered();
    model.project(pose(5, 1, 12), 12000);
    model.project(pose(5, 2, 13), 13000);
    const corrected = model.confirm('b', pose(5, 1, 12), 12000);
    expect(corrected.trailBreak).toBe(true);
    expect(corrected.metresPerUnit).toBe(0.5);
    expect(corrected.position).toEqual({ x: 10, y: 0 });
    // Replaying the latest already-observed pose accounts for movement since the camera frame.
    const latest = model.project(pose(5, 2, 13), 13000);
    expect(latest.status).toBe('tracking');
    expect(latest.position).toEqual({ x: 10, y: 2 });
    expect(model.project(pose(5, 2, 13), 13000).status).toBe('held');
    expect(model.confirm('a', pose(0, 0, 9), 9000).status).toBe('held');
  });
});
