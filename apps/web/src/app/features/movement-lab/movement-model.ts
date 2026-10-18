/** Local-only navigation experiment. It never emits a localization token or edits a graph. */
export interface Position {
  x: number;
  y: number;
}
export interface LabNode extends Position {
  id: string;
  label: string;
  kind: string;
}
export interface LabEdge {
  from: string;
  to: string;
}
export interface LabPlace extends Position {
  id: string;
  label: string;
  kind: string;
}
export interface GpsFix {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}
export interface HeadingFix {
  degrees: number;
  timestamp: number;
  reference: string;
}
export interface LabPlan {
  title: string;
  floor: string;
  width: number;
  height: number;
  entryId: string;
  entryLabel: string;
  entryEvidence: string;
  metresPerUnit: number | null;
  northDegrees: number | null;
  underlay: string;
  nodes: LabNode[];
  edges: LabEdge[];
  nearby: LabPlace[];
  outdoor: {
    lat: number;
    lng: number;
    radiusM: number;
    maxAccuracyM: number;
    label: string;
    coordinateEvidence: string;
    coordinateSource: string;
    addressSource: string;
  };
}
export const wrap = (degrees: number): number => ((degrees % 360) + 360) % 360;
export const angleGap = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);
export const mapBearing = (a: Position, b: Position): number =>
  wrap((Math.atan2(b.x - a.x, a.y - b.y) * 180) / Math.PI);
export const gap = (a: Position, b: Position): number => Math.hypot(a.x - b.x, a.y - b.y);
export function gpsDistance(
  a: Pick<GpsFix, 'lat' | 'lng'>,
  b: Pick<GpsFix, 'lat' | 'lng'>,
): number {
  const rad = Math.PI / 180,
    p1 = a.lat * rad,
    p2 = b.lat * rad;
  const h =
    Math.sin((p2 - p1) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
/** Two fresh, accurate fixes at least 2s apart. Accuracy circle must fit the arrival radius. */
export class ArrivalGate {
  private first: number | null = null;
  private last = -Infinity;
  reset(): void {
    this.first = null;
    this.last = -Infinity;
  }
  update(fix: GpsFix, destination: LabPlan['outdoor'], now = Date.now()): boolean {
    if (
      ![destination.lat, destination.lng, destination.radiusM, destination.maxAccuracyM].every(
        Number.isFinite,
      ) ||
      Math.abs(destination.lat) > 90 ||
      Math.abs(destination.lng) > 180 ||
      destination.radiusM <= 0 ||
      destination.maxAccuracyM <= 0
    ) {
      this.reset();
      return false;
    }
    if (
      ![fix.lat, fix.lng, fix.accuracy, fix.timestamp].every(Number.isFinite) ||
      Math.abs(fix.lat) > 90 ||
      Math.abs(fix.lng) > 180 ||
      fix.accuracy < 0 ||
      fix.timestamp <= this.last ||
      now - fix.timestamp > 10000 ||
      fix.timestamp - now > 1000
    )
      return false;
    if (fix.timestamp - this.last > 10000) this.first = null;
    this.last = fix.timestamp;
    if (
      fix.accuracy > destination.maxAccuracyM ||
      gpsDistance(fix, destination) + fix.accuracy > destination.radiusM
    ) {
      this.first = null;
      return false;
    }
    if (this.first === null) this.first = fix.timestamp;
    return fix.timestamp - this.first >= 2000;
  }
}
export interface WalkResult {
  position: Position;
  advanced: boolean;
  reason: string;
}
/** Step distance advances only over existing connected edges; never across walls or floors. */
export class CorridorEstimate {
  readonly nodes = new Map<string, LabNode>();
  readonly adjacency = new Map<string, string[]>();
  position: Position;
  steps = 0;
  uncertaintyM = 2;
  metresPerUnit: number | null = null;
  headingOffset: number | null = null;
  private vertex: string;
  private segment: { from: string; to: string; progress: number; length: number } | null = null;
  constructor(readonly plan: LabPlan) {
    for (const node of plan.nodes) this.nodes.set(node.id, node);
    for (const edge of plan.edges) {
      const a = this.nodes.get(edge.from),
        b = this.nodes.get(edge.to);
      if (!a || !b || gap(a, b) < 0.001) continue;
      this.adjacency.set(a.id, [...new Set([...(this.adjacency.get(a.id) ?? []), b.id])]);
      this.adjacency.set(b.id, [...new Set([...(this.adjacency.get(b.id) ?? []), a.id])]);
    }
    const entry = this.nodes.get(plan.entryId);
    if (!entry) throw new Error('The requested entrance is missing from this saved graph.');
    this.vertex = entry.id;
    this.position = { x: entry.x, y: entry.y };
  }
  anchor(id = this.plan.entryId): void {
    const node = this.nodes.get(id);
    if (!node) throw new Error('Unknown reference point.');
    this.vertex = id;
    this.segment = null;
    this.position = { x: node.x, y: node.y };
    this.steps = 0;
    this.uncertaintyM = 2;
    this.headingOffset = null;
  }
  /** Existing graph distance and first edge, used for a measured calibration walk. */
  pathTo(target: string): { distance: number; first: string } | null {
    const dist = new Map([[this.vertex, 0]]),
      first = new Map<string, string>(),
      open = new Set(this.nodes.keys());
    while (open.size) {
      const current = [...open]
        .filter((id) => dist.has(id))
        .sort((a, b) => dist.get(a)! - dist.get(b)!)[0];
      if (!current) return null;
      if (current === target)
        return first.has(current)
          ? { distance: dist.get(current)!, first: first.get(current)! }
          : null;
      open.delete(current);
      for (const next of this.adjacency.get(current) ?? []) {
        const value = dist.get(current)! + gap(this.nodes.get(current)!, this.nodes.get(next)!);
        if (value < (dist.get(next) ?? Infinity)) {
          dist.set(next, value);
          first.set(next, current === this.vertex ? next : first.get(current)!);
        }
      }
    }
    return null;
  }
  calibrate(target: string, measuredMetres: number, rawHeading: number): void {
    if (this.segment) throw new Error('Re-anchor at a known point before calibrating.');
    const path = this.pathTo(target);
    if (
      !path ||
      !Number.isFinite(measuredMetres) ||
      measuredMetres <= 0 ||
      !Number.isFinite(rawHeading)
    )
      throw new Error(
        'Choose a connected reference point and a positive measured walking distance.',
      );
    this.metresPerUnit = measuredMetres / path.distance;
    this.headingOffset = wrap(
      mapBearing(this.nodes.get(this.vertex)!, this.nodes.get(path.first)!) - rawHeading,
    );
  }
  mappedHeading(raw: number): number | null {
    return this.headingOffset === null ? null : wrap(raw + this.headingOffset);
  }
  step(rawHeading: number, strideM = 0.72): WalkResult {
    if (this.metresPerUnit === null || this.headingOffset === null)
      return {
        position: this.position,
        advanced: false,
        reason: 'Calibrate map scale and facing direction first.',
      };
    if (!Number.isFinite(rawHeading) || !Number.isFinite(strideM) || strideM < 0.2 || strideM > 1.5)
      return {
        position: this.position,
        advanced: false,
        reason: 'A valid heading and stride length are required.',
      };
    const heading = wrap(rawHeading + this.headingOffset);
    let remaining = strideM / this.metresPerUnit,
      advanced = false;
    this.steps++;
    this.uncertaintyM += strideM * 0.12;
    for (let hop = 0; hop < 64 && remaining > 0.0001; hop++) {
      if (!this.segment) {
        const origin = this.nodes.get(this.vertex)!;
        const next = (this.adjacency.get(this.vertex) ?? [])
          .map((id) => ({ id, angle: angleGap(heading, mapBearing(origin, this.nodes.get(id)!)) }))
          .sort((a, b) => a.angle - b.angle)[0];
        if (!next || next.angle > 65) break;
        this.segment = {
          from: this.vertex,
          to: next.id,
          progress: 0,
          length: gap(origin, this.nodes.get(next.id)!),
        };
      }
      const segment = this.segment,
        a = this.nodes.get(segment.from)!,
        b = this.nodes.get(segment.to)!;
      const forward = angleGap(heading, mapBearing(a, b)) <= 65;
      const reverse = angleGap(heading, mapBearing(b, a)) <= 65;
      if (!forward && !reverse) break;
      const available = forward ? segment.length - segment.progress : segment.progress;
      const distance = Math.min(remaining, available);
      segment.progress += forward ? distance : -distance;
      remaining -= distance;
      advanced ||= distance > 0;
      const t = segment.progress / segment.length;
      this.position = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (forward && segment.length - segment.progress < 0.0001) {
        this.vertex = b.id;
        this.segment = null;
      } else if (reverse && segment.progress < 0.0001) {
        this.vertex = a.id;
        this.segment = null;
      }
    }
    return {
      position: this.position,
      advanced,
      reason: advanced
        ? 'Approximate step-based position; re-anchor regularly.'
        : 'Heading does not match a connected corridor. Position held.',
    };
  }
  nearbyPlaces(): { label: string; distanceM: number | null }[] {
    return this.plan.nearby
      .map((place) => ({
        label: place.label,
        distanceM:
          this.metresPerUnit === null ? null : gap(this.position, place) * this.metresPerUnit,
        units: gap(this.position, place),
      }))
      .sort((a, b) => a.units - b.units)
      .slice(0, 4)
      .map(({ label, distanceM }) => ({ label, distanceM }));
  }
}
