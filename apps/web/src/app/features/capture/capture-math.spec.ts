import {
  angleOf,
  backoffMs,
  closestOnPath,
  corridorEnds,
  derivePointState,
  forwardAngleAt,
  normalizeAngle,
  progressSummary,
  renumber,
  SLOTS,
  slotAngle,
  slotInstruction,
  walkingPath,
  type LocalPhotoState,
} from './capture-math';
import type { Corridor, ServerPhoto } from './capture.models';
import { sha256Js } from './capture-utils';

// A corridor running right (+x), then turning down (+y), in forward orientation.
const corridor: Corridor = {
  id: 'c1',
  label: 'Main hall',
  lengthPx: 300,
  lengthM: null,
  path: [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
  ],
  segments: [],
  nodeIds: ['n-start', 'n-end'],
};

describe('capture angle and slot math', () => {
  it('uses the map frame: 0 = +x, clockwise on screen (y down)', () => {
    expect(angleOf({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(0);
    expect(angleOf({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe(90);
    expect(angleOf({ x: 0, y: 0 }, { x: -10, y: 0 })).toBe(180);
    expect(angleOf({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe(270);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(720)).toBe(0);
  });

  it('derives the four slots from the forward angle (right = +90, left = +270)', () => {
    expect(SLOTS.map((s) => slotAngle(0, s))).toEqual([0, 270, 180, 90]);
    // Walking down the plan: left is +x (screen right), right is -x.
    expect(SLOTS.map((s) => slotAngle(90, s))).toEqual([90, 0, 270, 180]);
    expect(slotAngle(350, 'right')).toBe(80);
  });

  it('flips forward and backward and swaps left/right when walking in reverse', () => {
    const fwd = walkingPath(corridor, 'forward'),
      rev = walkingPath(corridor, 'reverse');
    expect(rev[0]).toEqual({ x: 200, y: 100 });
    // On the straight first stretch: forward 0°, reverse 180°.
    const forwardAtStart = forwardAngleAt(fwd, 50);
    const reverseThere = forwardAngleAt(rev, 100 + 150);
    expect(forwardAtStart).toBe(0);
    expect(reverseThere).toBe(180);
    expect(slotAngle(reverseThere, 'forward')).toBe(slotAngle(forwardAtStart, 'backward'));
    expect(slotAngle(reverseThere, 'left')).toBe(slotAngle(forwardAtStart, 'right'));
    expect(slotAngle(reverseThere, 'left')).toBe(90);
    // After the turn, walking forward faces down; in reverse the first segment faces up.
    expect(forwardAngleAt(fwd, 250)).toBe(90);
    expect(forwardAngleAt(rev, 10)).toBe(270);
    // The last point uses the incoming segment.
    expect(forwardAngleAt(fwd, 300)).toBe(90);
  });

  it('names where each walking direction leads and words the instructions', () => {
    const nodes = [
      { id: 'n-start', kind: 'end', label: 'Main entrance', x: 0, y: 0 },
      { id: 'n-end', kind: 'junction', label: '', x: 200, y: 100 },
    ];
    const landmarks = [{ kind: 'room', id: 'r1', label: 'Room 301', x: 210, y: 110 }];
    expect(corridorEnds(corridor, 'forward', nodes, landmarks)).toEqual({
      towards: 'Room 301',
      from: 'Main entrance',
    });
    const reverse = corridorEnds(corridor, 'reverse', nodes, landmarks);
    expect(reverse.towards).toBe('Main entrance');
    expect(slotInstruction('forward', reverse)).toBe(
      'Face along the corridor towards Main entrance.',
    );
    expect(slotInstruction('backward', reverse)).toContain('towards Room 301');
  });

  it('snaps a tap to the closest point on the path', () => {
    const hit = closestOnPath(corridor.path, { x: 190, y: 50 });
    expect(hit.point).toEqual({ x: 200, y: 50 });
    expect(hit.along).toBe(250);
    expect(hit.distance).toBe(10);
  });

  it('numbers points in walking order and backs off retries up to 60 s', () => {
    const list = renumber([
      { id: 'b', corridorDistancePx: 50, order: 1 },
      { id: 'a', corridorDistancePx: 10, order: 2 },
    ]);
    expect(list.map((p) => [p.id, p.order])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect([1, 2, 3, 10].map(backoffMs)).toEqual([2000, 4000, 8000, 60000]);
  });

  it('hashes like SHA-256', () => {
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    expect(hex(sha256Js(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hex(sha256Js(new Uint8Array()))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('capture point state', () => {
  const point = { id: 'p1' };
  const server = (slot: ServerPhoto['slot'], extra: Partial<ServerPhoto> = {}): ServerPhoto => ({
    id: `s-${slot}`,
    pointId: 'p1',
    slot,
    viewingAngleDeg: 0,
    uploadStatus: 'uploaded',
    reviewStatus: 'pending',
    ...extra,
  });
  const local = (slot: LocalPhotoState['slot'], state: LocalPhotoState['state']) => ({
    id: `l-${slot}-${state}`,
    pointId: 'p1',
    slot,
    state,
  });

  it('is empty without photos and partial with some', () => {
    expect(derivePointState(point, [], []).state).toBe('empty');
    const partial = derivePointState(point, [server('forward')], [local('left', 'upload-pending')]);
    expect(partial.state).toBe('partial');
    expect(partial.uploaded).toEqual(['forward']);
    expect(partial.pending).toBe(1);
    expect(partial.hasPhotos).toBe(true);
  });

  it('never shows complete while a photo of the point is pending or failed', () => {
    const four = SLOTS.map((s) => server(s));
    expect(derivePointState(point, four, []).state).toBe('complete');
    // A retake of one slot is still on the phone: not complete.
    const retake = derivePointState(point, four, [local('left', 'upload-pending')]);
    expect(retake.state).toBe('partial');
    expect(retake.pending).toBe(1);
    const failed = derivePointState(point, four, [local('extra', 'failed')]);
    expect(failed.state).toBe('partial');
    expect(failed.failed).toBe(1);
    // Three on the server plus one only captured locally: not complete either.
    const local3 = derivePointState(
      point,
      SLOTS.slice(0, 3).map((s) => server(s)),
      [local('right', 'captured-locally')],
    );
    expect(local3.state).toBe('partial');
    // Once the queue confirms it, it counts.
    expect(
      derivePointState(
        point,
        SLOTS.slice(0, 3).map((s) => server(s)),
        [local('right', 'uploaded')],
      ).state,
    ).toBe('complete');
  });

  it('ignores replaced photos and flags needs-review', () => {
    const replaced = SLOTS.map((s) => server(s, { reviewStatus: 'replaced' }));
    expect(derivePointState(point, replaced, []).state).toBe('empty');
    expect(
      derivePointState(point, [server('forward', { reviewStatus: 'needs-review' })], []).state,
    ).toBe('needs-review');
    const review = derivePointState(
      { id: 'p1', status: 'needs-review', reviewReason: 'map revision changed' },
      [],
      [],
    );
    expect(review.state).toBe('needs-review');
    expect(review.needsReviewReason).toBe('map revision changed');
  });

  it('summarises progress', () => {
    const done = derivePointState(
      point,
      SLOTS.map((s) => server(s)),
      [],
    );
    const busy = derivePointState(
      point,
      [],
      [local('forward', 'upload-pending'), local('left', 'failed')],
    );
    expect(progressSummary([done, busy, derivePointState({ id: 'x' }, [], [])])).toBe(
      '1 of 3 points complete · 1 photo pending · 1 failed',
    );
  });
});
