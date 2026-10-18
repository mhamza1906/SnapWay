import { describe, expect, it } from 'vitest';
import { cameraFix, cameraFixIsCurrent } from './ios-camera-fix';
import type { LabPlan } from './movement-model';
import type { CameraCandidate } from './camera-lab';
import type { IOSPose } from './ios-pose-model';
import type { IOSCapturedPoseFrame } from './indoor-pose';
const node = { id: 'old-node', label: 'Point 19', x: 713, y: 142, kind: 'photo' };
const plan = { nodes: [node] } as LabPlan;
const frame: IOSCapturedPoseFrame = {
  jpegBase64: '/9j/',
  timestamp: 10000,
  monotonicSeconds: 10,
  epoch: 'run',
  pose: { x: 0, y: 1, z: 0 },
};
const pose: IOSPose = {
  ...frame.pose,
  timestamp: 10500,
  monotonicSeconds: 10.5,
  epoch: 'run',
  tracking: 'normal',
};
const candidate = { nodeId: node.id, status: 'candidate' } as CameraCandidate;
describe('Camera-first saved-node estimates', () => {
  it('places a supported visual node without any AR-to-map registration', () => {
    const fix = cameraFix(plan, candidate, frame, pose, 10500)!;
    expect(fix.node).toBe(node);
    expect(cameraFixIsCurrent(fix, pose, 10500)).toBe(true);
  });
  it('keeps visual matching independent of limited AR motion', () => {
    const fix = cameraFix(plan, candidate, frame, { ...pose, tracking: 'limited' }, 10500)!;
    expect(cameraFixIsCurrent(fix, { ...pose, tracking: 'limited' }, 10500)).toBe(true);
  });
  it('does not make an uncertain or unknown camera winner into a map fix', () => {
    expect(cameraFix(plan, { ...candidate, status: 'uncertain' }, frame, pose, 10500)).toBeNull();
    expect(cameraFix(plan, { ...candidate, nodeId: 'unknown' }, frame, pose, 10500)).toBeNull();
  });
  it('keeps delayed or moved-since-capture results historical', () => {
    const delayed = cameraFix(plan, candidate, frame, { ...pose, timestamp: 18000 }, 18000)!;
    expect(delayed).not.toBeNull();
    expect(cameraFixIsCurrent(delayed, { ...pose, timestamp: 18000 }, 18000)).toBe(false);
    expect(cameraFixIsCurrent(delayed, { ...pose, x: 2 }, 10500)).toBe(false);
  });
  it('rejects old, future and restarted-session results', () => {
    expect(cameraFix(plan, candidate, frame, pose, 26000)).toBeNull();
    expect(cameraFix(plan, candidate, frame, pose, 9999)).toBeNull();
    expect(cameraFix(plan, candidate, frame, { ...pose, epoch: 'new' }, 10500)).toBeNull();
  });
});
