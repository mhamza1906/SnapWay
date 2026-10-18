import type { LabNode, LabPlan } from './movement-model';
import type { IOSPose } from './ios-pose-model';
import type { IOSCapturedPoseFrame } from './indoor-pose';
import type { CameraCandidate } from './camera-lab';

export interface IOSCameraFix {
  node: LabNode;
  frame: IOSCapturedPoseFrame;
}
/** Visual evidence chooses the node. AR coordinates never choose a map position. */
export function cameraFix(
  plan: LabPlan,
  candidate: CameraCandidate,
  frame: IOSCapturedPoseFrame,
  latest: IOSPose,
  now: number,
): IOSCameraFix | null {
  const age = now - frame.timestamp;
  if (
    candidate.status !== 'candidate' ||
    !candidate.nodeId ||
    frame.epoch !== latest.epoch ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 15000
  )
    return null;
  const node = plan.nodes.find(
    (value) => value.id === candidate.nodeId && /^Point \d+$/.test(value.label),
  );
  return node ? { node, frame } : null;
}
/** Delayed camera fixes remain historical landmarks, never current locations. */
export function cameraFixIsCurrent(
  fix: IOSCameraFix,
  latest: IOSPose | null,
  now: number,
): boolean {
  if (!latest || latest.epoch !== fix.frame.epoch) return false;
  const age = now - fix.frame.timestamp,
    poseAge = now - latest.timestamp;
  const movement = Math.hypot(latest.x - fix.frame.pose.x, latest.z - fix.frame.pose.z);
  return (
    age >= 0 &&
    age <= 3000 &&
    poseAge >= 0 &&
    poseAge <= 1000 &&
    (latest.tracking !== 'normal' || movement <= 1.5)
  );
}
