import { gap, type LabNode, type LabPlan, type Position } from './movement-model';

/** ARKit horizontal world coordinates are metres. This is a relative pose, never GPS. */
export interface IOSPose {
  x: number;
  y: number;
  z: number;
  timestamp: number;
  monotonicSeconds: number;
  epoch: string;
  tracking: 'normal' | 'limited' | 'unavailable';
}
export interface IOSPoseResult {
  position: Position | null;
  rawPosition: Position | null;
  status: 'unregistered' | 'anchor-required' | 'registered' | 'held' | 'tracking';
  reason: string;
  metresPerUnit: number | null;
  lateralErrorM: number | null;
  trailBreak: boolean;
}
interface Segment {
  from: LabNode;
  to: LabNode;
  length: number;
}
interface OnSegment {
  segment: Segment;
  t: number;
  position: Position;
}
interface Registration {
  scale: number;
  cos: number;
  sin: number;
  offset: Position;
  height: number;
  epoch: string;
}

/**
 * Two explicitly confirmed points on one straight corridor register ARKit to the SVG.
 * The display estimate stays on existing nearby connected edges. Neither the graph nor
 * a localization token is changed. Corridor snapping is a constraint, not an accuracy claim.
 */
export class IOSPoseModel {
  private nodes = new Map<string, LabNode>();
  private adjacency = new Map<string, { id: string; length: number }[]>();
  private segments: Segment[] = [];
  private first: { node: LabNode; pose: IOSPose } | null = null;
  private registration: Registration | null = null;
  private previous: OnSegment | null = null;
  private acceptedPose: IOSPose | null = null;
  private lastMonotonic = -Infinity;
  private lastTimestamp = -Infinity;
  private correctionReplay = false;
  private shown: Position | null = null;

  constructor(plan: LabPlan) {
    for (const node of plan.nodes) {
      if (Number.isFinite(node.x) && Number.isFinite(node.y)) this.nodes.set(node.id, node);
    }
    const seen = new Set<string>();
    for (const edge of plan.edges) {
      const a = this.nodes.get(edge.from),
        b = this.nodes.get(edge.to);
      if (!a || !b || a.id === b.id) continue;
      const key = [a.id, b.id].sort().join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      const length = gap(a, b);
      if (length < 0.001) continue;
      this.segments.push({ from: a, to: b, length });
      this.adjacency.set(a.id, [...(this.adjacency.get(a.id) ?? []), { id: b.id, length }]);
      this.adjacency.set(b.id, [...(this.adjacency.get(b.id) ?? []), { id: a.id, length }]);
    }
  }

  get registered(): boolean {
    return this.registration !== null;
  }

  reset(): void {
    this.first = null;
    this.registration = null;
    this.previous = null;
    this.acceptedPose = null;
    this.lastMonotonic = -Infinity;
    this.lastTimestamp = -Infinity;
    this.correctionReplay = false;
    this.shown = null;
  }

  firstAnchor(nodeId: string, pose: IOSPose, now = Date.now()): IOSPoseResult {
    this.reset();
    const error = this.poseError(pose, now);
    const node = this.nodes.get(nodeId);
    if (error || !node || !this.adjacency.has(nodeId))
      return this.result('anchor-required', error ?? 'Choose a known connected map point.');
    this.first = { node, pose: { ...pose } };
    this.shown = { x: node.x, y: node.y };
    this.lastMonotonic = pose.monotonicSeconds;
    return this.result(
      'unregistered',
      'First point confirmed. Walk straight to a second known point at least 2 metres away.',
      null,
      null,
      true,
    );
  }

  secondAnchor(nodeId: string, pose: IOSPose, now = Date.now()): IOSPoseResult {
    const error = this.poseError(pose, now);
    if (error) return this.invalidate(error);
    const first = this.first,
      node = this.nodes.get(nodeId);
    if (!first || !node)
      return this.result('anchor-required', 'Confirm the first known point again.');
    if (pose.epoch !== first.pose.epoch)
      return this.invalidate('ARKit restarted. Confirm both map points again.');
    if (pose.monotonicSeconds <= first.pose.monotonicSeconds)
      return this.result('held', 'Wait for a new camera pose at the second point.');
    const worldX = pose.x - first.pose.x,
      worldZ = pose.z - first.pose.z;
    const baselineM = Math.hypot(worldX, worldZ);
    const direct = gap(first.node, node),
      path = this.distances(first.node.id).get(node.id);
    if (baselineM < 2)
      return this.result('held', 'Use a straight measured baseline of at least 2 metres.');
    if (Math.abs(pose.y - first.pose.y) > 1.5)
      return this.invalidate('Height changed. This registration supports one floor only.');
    if (!path || direct < 0.001 || path / direct > 1.15)
      return this.result(
        'held',
        'Choose two connected points along one straight corridor, without a turn.',
      );
    const metresPerUnit = baselineM / direct;
    if (metresPerUnit < 0.01 || metresPerUnit > 5)
      return this.result(
        'held',
        'The baseline gives an implausible map scale. Confirm the two points again.',
      );
    const rotation =
      Math.atan2(node.y - first.node.y, node.x - first.node.x) - Math.atan2(worldZ, worldX);
    const scale = direct / baselineM,
      cos = Math.cos(rotation),
      sin = Math.sin(rotation);
    this.registration = {
      scale,
      cos,
      sin,
      offset: {
        x: first.node.x - scale * (cos * first.pose.x - sin * first.pose.z),
        y: first.node.y - scale * (sin * first.pose.x + cos * first.pose.z),
      },
      height: first.pose.y,
      epoch: pose.epoch,
    };
    this.setAtNode(node, pose);
    return this.result(
      'registered',
      'Two-point registration ready. Position remains an unverified camera-and-motion estimate.',
      { x: node.x, y: node.y },
      0,
      true,
    );
  }

  project(pose: IOSPose, now = Date.now()): IOSPoseResult {
    const error = this.poseError(pose, now);
    if (error) return this.invalidate(error);
    const r = this.registration;
    if (!r || !this.previous || !this.acceptedPose)
      return this.result(
        'anchor-required',
        'Confirm two known points before using camera movement.',
      );
    if (pose.epoch !== r.epoch)
      return this.invalidate('ARKit restarted. Confirm both map points again.');
    if (
      pose.monotonicSeconds < this.lastMonotonic ||
      (pose.monotonicSeconds === this.lastMonotonic && !this.correctionReplay)
    )
      return this.result('held', 'Ignored an out-of-order camera pose.');
    this.lastMonotonic = pose.monotonicSeconds;
    this.lastTimestamp = pose.timestamp;
    this.correctionReplay = false;
    if (Math.abs(pose.y - r.height) > 1.5)
      return this.invalidate(
        'Possible floor change. Position held; confirm the floor and both anchors.',
      );
    const raw = this.transform(pose);
    const deltaM = Math.hypot(pose.x - this.acceptedPose.x, pose.z - this.acceptedPose.z);
    const elapsedSeconds = pose.monotonicSeconds - this.acceptedPose.monotonicSeconds;
    // A world-origin jump may briefly arrive with normal tracking. This conservative
    // walking-mode guard is an outlier rejection rule, not a measured speed guarantee.
    if (elapsedSeconds < 0 || deltaM > Math.max(2, 4 * elapsedSeconds + 0.5))
      return this.invalidate('Implausible camera pose jump. Confirm both map points again.');
    const budget = (deltaM * 1.25 + 0.5) * r.scale;
    const fromDistances = this.distances(this.previous.segment.from.id);
    const toDistances = this.distances(this.previous.segment.to.id);
    const startFrom = this.previous.t * this.previous.segment.length;
    const startTo = (1 - this.previous.t) * this.previous.segment.length;
    let best: { location: OnSegment; errorM: number } | null = null;
    for (const segment of this.segments) {
      const location = this.nearest(segment, raw);
      let travel = Math.min(
        startFrom + (fromDistances.get(segment.from.id) ?? Infinity) + location.t * segment.length,
        startFrom +
          (fromDistances.get(segment.to.id) ?? Infinity) +
          (1 - location.t) * segment.length,
        startTo + (toDistances.get(segment.from.id) ?? Infinity) + location.t * segment.length,
        startTo + (toDistances.get(segment.to.id) ?? Infinity) + (1 - location.t) * segment.length,
      );
      if (segment === this.previous.segment)
        travel = Math.min(travel, Math.abs(location.t - this.previous.t) * segment.length);
      const errorM = gap(raw, location.position) / r.scale;
      if (travel <= budget && errorM <= 1.5 && (!best || errorM < best.errorM))
        best = { location, errorM };
    }
    if (!best)
      return this.result(
        'held',
        'Camera estimate is outside the nearby connected corridor. Confirm a known point.',
        raw,
      );
    this.previous = best.location;
    this.acceptedPose = { ...pose };
    this.shown = { ...best.location.position };
    return this.result(
      'tracking',
      'Relative camera movement constrained to the saved corridor graph.',
      raw,
      best.errorM,
    );
  }

  /** Only call after the person explicitly confirms a trustworthy visual/map match. */
  confirm(nodeId: string, pose: IOSPose, now = Date.now()): IOSPoseResult {
    const error = this.poseError(pose, now);
    if (error) return this.invalidate(error);
    const r = this.registration,
      node = this.nodes.get(nodeId);
    if (!r || !node || !this.adjacency.has(nodeId))
      return this.result(
        'anchor-required',
        'A valid registration and connected confirmed point are required.',
      );
    if (pose.epoch !== r.epoch)
      return this.invalidate('ARKit restarted. Confirm both map points again.');
    if (Math.abs(pose.y - r.height) > 1.5)
      return this.invalidate(
        'Possible floor change. Re-register both points on the correct floor.',
      );
    if (
      this.lastTimestamp - pose.timestamp > 3000 ||
      this.lastMonotonic - pose.monotonicSeconds > 3
    )
      return this.result(
        'held',
        'The paired visual pose is too old. Capture a fresh visual correction.',
      );
    const raw = this.transform(pose);
    r.offset.x += node.x - raw.x;
    r.offset.y += node.y - raw.y;
    const newestMonotonic = this.lastMonotonic,
      newestTimestamp = this.lastTimestamp;
    this.setAtNode(node, pose);
    this.lastMonotonic = Math.max(newestMonotonic, pose.monotonicSeconds);
    this.lastTimestamp = Math.max(newestTimestamp, pose.timestamp);
    // Re-project the already observed latest pose once after an asynchronous visual match.
    this.correctionReplay = true;
    return this.result(
      'registered',
      'Explicit visual correction applied. Rotation and measured scale preserved.',
      { x: node.x, y: node.y },
      0,
      true,
    );
  }

  private poseError(pose: IOSPose, now: number): string | null {
    if (
      ![pose.x, pose.y, pose.z, pose.timestamp, pose.monotonicSeconds, now].every(
        Number.isFinite,
      ) ||
      !pose.epoch ||
      pose.monotonicSeconds < 0
    )
      return 'Invalid camera pose. Confirm both map points again.';
    if (pose.tracking !== 'normal')
      return 'Camera tracking is limited or unavailable. Confirm both map points after tracking recovers.';
    if (now - pose.timestamp > 1000 || pose.timestamp - now > 250)
      return 'Camera pose is stale. Confirm both map points with a fresh camera pose.';
    return null;
  }
  private invalidate(reason: string): IOSPoseResult {
    this.first = null;
    this.registration = null;
    this.previous = null;
    this.acceptedPose = null;
    return this.result('anchor-required', reason);
  }
  private transform(pose: IOSPose): Position {
    const r = this.registration!;
    return {
      x: r.offset.x + r.scale * (r.cos * pose.x - r.sin * pose.z),
      y: r.offset.y + r.scale * (r.sin * pose.x + r.cos * pose.z),
    };
  }
  private setAtNode(node: LabNode, pose: IOSPose): void {
    const segment = this.segments.find((s) => s.from.id === node.id || s.to.id === node.id)!;
    this.previous = {
      segment,
      t: segment.from.id === node.id ? 0 : 1,
      position: { x: node.x, y: node.y },
    };
    this.shown = { x: node.x, y: node.y };
    this.acceptedPose = { ...pose };
    this.lastMonotonic = pose.monotonicSeconds;
    this.lastTimestamp = pose.timestamp;
  }
  private nearest(segment: Segment, point: Position): OnSegment {
    const dx = segment.to.x - segment.from.x,
      dy = segment.to.y - segment.from.y;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((point.x - segment.from.x) * dx + (point.y - segment.from.y) * dy) / segment.length ** 2,
      ),
    );
    return { segment, t, position: { x: segment.from.x + dx * t, y: segment.from.y + dy * t } };
  }
  private distances(origin: string): Map<string, number> {
    const distances = new Map([[origin, 0]]),
      open = new Set(this.nodes.keys());
    while (open.size) {
      let current: string | undefined,
        distance = Infinity;
      for (const id of open)
        if ((distances.get(id) ?? Infinity) < distance) {
          current = id;
          distance = distances.get(id)!;
        }
      if (!current) break;
      open.delete(current);
      for (const next of this.adjacency.get(current) ?? []) {
        const candidate = distance + next.length;
        if (candidate < (distances.get(next.id) ?? Infinity)) distances.set(next.id, candidate);
      }
    }
    return distances;
  }
  private result(
    status: IOSPoseResult['status'],
    reason: string,
    rawPosition: Position | null = null,
    lateralErrorM: number | null = null,
    trailBreak = false,
  ): IOSPoseResult {
    return {
      position: this.shown ? { ...this.shown } : null,
      rawPosition,
      status,
      reason,
      metresPerUnit: this.registration ? 1 / this.registration.scale : null,
      lateralErrorM,
      trailBreak,
    };
  }
}
