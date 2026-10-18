import type {
  CapturePoint,
  Corridor,
  Direction,
  DirectionalSlot,
  Landmark,
  MapNode,
  Nearby,
  PointStatus,
  ServerPhoto,
  Slot,
  XY,
} from './capture.models';

/** The four required slots, in the order the guided capture asks for them. */
export const SLOTS: readonly DirectionalSlot[] = ['forward', 'left', 'backward', 'right'];
/** Clockwise offset of each slot from the forward (walking) direction, in degrees. */
export const SLOT_OFFSET: Record<DirectionalSlot, number> = {
  forward: 0,
  right: 90,
  backward: 180,
  left: 270,
};
export const SLOT_LABEL: Record<Slot, string> = {
  forward: 'Front',
  left: 'Left',
  backward: 'Back',
  right: 'Right',
  extra: 'Extra',
};

/** An angle in [0, 360). */
export function normalizeAngle(deg: number): number {
  const a = deg % 360;
  const n = a < 0 ? a + 360 : a;
  return Math.abs(n - 360) < 1e-9 || Math.abs(n) < 1e-9 ? 0 : n;
}

/**
 * Map-relative viewing angle (contract): 0 = facing +x, clockwise on screen (y down), i.e.
 * atan2(dy, dx) in the map frame. Not a compass bearing.
 */
export function angleOf(from: XY, to: XY): number {
  return normalizeAngle((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI);
}

/** The requested viewing angle for a slot at a point whose forward angle is `forwardDeg`. */
export function slotAngle(forwardDeg: number, slot: DirectionalSlot): number {
  return normalizeAngle(forwardDeg + SLOT_OFFSET[slot]);
}

/** Unit vector in the map frame (y down) for an angle; used for the requested-direction arrow. */
export function angleVector(deg: number): XY {
  const r = (deg * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
}

/** The corridor path in walking order. */
export function walkingPath(corridor: Pick<Corridor, 'path'>, direction: Direction): XY[] {
  return direction === 'reverse' ? [...corridor.path].reverse() : [...corridor.path];
}

function segmentLength(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Total polyline length in map pixels. */
export function pathLength(path: XY[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += segmentLength(path[i - 1], path[i]);
  return total;
}

/**
 * Forward angle at `distancePx` along a walking-order path: the outgoing segment, or the
 * incoming one at the very end (as in the contract's reference segment rule).
 */
export function forwardAngleAt(path: XY[], distancePx: number): number {
  if (path.length < 2) return 0;
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const len = segmentLength(path[i - 1], path[i]);
    if (len > 0 && distancePx < walked + len - 1e-6) return angleOf(path[i - 1], path[i]);
    walked += len;
  }
  return angleOf(path[path.length - 2], path[path.length - 1]);
}

/** Closest point on a polyline, with its distance along the path and from `p`. */
export function closestOnPath(path: XY[], p: XY): { point: XY; along: number; distance: number } {
  let best = { point: path[0] ?? p, along: 0, distance: Infinity };
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i],
      len = segmentLength(a, b);
    const t =
      len === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len ** 2),
          );
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const d = segmentLength(p, q);
    if (d < best.distance) best = { point: q, along: walked + len * t, distance: d };
    walked += len;
  }
  if (path.length === 1) best.distance = segmentLength(path[0], p);
  return best;
}

/** The corridor nearest to `p` within `maxPx`, for tap-to-choose on the setup map. */
export function nearestCorridor(corridors: Corridor[], p: XY, maxPx: number): Corridor | null {
  let best: Corridor | null = null,
    bestD = maxPx;
  for (const c of corridors) {
    const d = closestOnPath(c.path, p).distance;
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Landmarks near a position, closest first (used when a point carries no `nearby`). */
export function nearbyLandmarks(landmarks: Landmark[], p: XY, maxPx = 160, limit = 4): Nearby[] {
  return landmarks
    .map((l) => ({ kind: l.kind, id: l.id, label: l.label, distancePx: segmentLength(l, p) }))
    .filter((l) => l.label && l.distancePx <= maxPx)
    .sort((a, b) => a.distancePx - b.distancePx)
    .slice(0, limit);
}

/** A readable name for one end of a corridor: its end node, else the nearest landmark. */
function endName(
  corridor: Corridor,
  end: 'first' | 'last',
  nodes: MapNode[],
  landmarks: Landmark[],
) {
  const nodeId =
    end === 'first' ? corridor.nodeIds[0] : corridor.nodeIds[corridor.nodeIds.length - 1];
  const point = end === 'first' ? corridor.path[0] : corridor.path[corridor.path.length - 1];
  const node = nodes.find((n) => n.id === nodeId);
  if (node?.label) return node.label;
  const near = point ? nearbyLandmarks(landmarks, point, 200, 1)[0] : undefined;
  if (near) return near.label;
  if (node?.kind === 'junction') return 'the junction';
  return end === 'first' ? 'the start of the corridor' : 'the end of the corridor';
}

/** "towards" (where walking leads) and "from" (behind you) names for a walking direction. */
export function corridorEnds(
  corridor: Corridor,
  direction: Direction,
  nodes: MapNode[],
  landmarks: Landmark[],
): { towards: string; from: string } {
  const first = endName(corridor, 'first', nodes, landmarks),
    last = endName(corridor, 'last', nodes, landmarks);
  return direction === 'forward' ? { towards: last, from: first } : { towards: first, from: last };
}

/** The instruction shown with the requested-direction arrow. */
export function slotInstruction(slot: Slot, ends: { towards: string; from: string }): string {
  switch (slot) {
    case 'forward':
      return `Face along the corridor towards ${ends.towards}.`;
    case 'backward':
      return `Turn around and face back along the corridor towards ${ends.from}.`;
    case 'left':
      return `Make a quarter turn to the left from facing ${ends.towards}, so you face the left side of the corridor.`;
    case 'right':
      return `Make a quarter turn to the right from facing ${ends.towards}, so you face the right side of the corridor.`;
    default:
      return 'Extra photo: a sign, a doorway or anything that helps recognise this spot. Choose the direction you face.';
  }
}

// Point state ------------------------------------------------------------------------------

/** What the queue knows about one photo (enough for state derivation). */
export interface LocalPhotoState {
  id: string;
  pointId: string;
  slot: Slot;
  state: 'captured-locally' | 'upload-pending' | 'uploaded' | 'failed';
}
export interface PointProgress {
  state: PointStatus;
  /** Directional slots the server confirmed. */
  uploaded: DirectionalSlot[];
  /** Slots with a photo on the phone that is not confirmed yet. */
  pendingSlots: Slot[];
  pending: number;
  failed: number;
  /** Any photo exists for this point (server or phone): the position is then fixed. */
  hasPhotos: boolean;
  needsReviewReason: string;
}

/**
 * Derives a point's state from server photos and the phone's queue. A point is `complete`
 * only when all four slots are server-confirmed and nothing for it is still pending or failed.
 */
export function derivePointState(
  point: Pick<CapturePoint, 'id' | 'status' | 'reviewReason'>,
  serverPhotos: ServerPhoto[],
  local: LocalPhotoState[],
): PointProgress {
  const active = serverPhotos.filter(
    (p) => (p.pointId ?? p.point) === point.id && p.reviewStatus !== 'replaced',
  );
  const mine = local.filter((r) => r.pointId === point.id);
  const waiting = mine.filter((r) => r.state !== 'uploaded');
  const uploadedSlots = new Set<Slot>([
    ...active.filter((p) => !p.uploadStatus || p.uploadStatus === 'uploaded').map((p) => p.slot),
    ...mine.filter((r) => r.state === 'uploaded').map((r) => r.slot),
  ]);
  const uploaded = SLOTS.filter((s) => uploadedSlots.has(s));
  const failed = waiting.filter((r) => r.state === 'failed').length;
  const reviewPhoto = active.some((p) => p.reviewStatus === 'needs-review');
  let state: PointStatus;
  if (point.status === 'needs-review' || reviewPhoto) state = 'needs-review';
  else if (uploaded.length === SLOTS.length && waiting.length === 0) state = 'complete';
  else if (uploadedSlots.size || waiting.length) state = 'partial';
  else state = 'empty';
  return {
    state,
    uploaded,
    pendingSlots: waiting.map((r) => r.slot),
    pending: waiting.length - failed,
    failed,
    hasPhotos: active.length > 0 || mine.length > 0,
    needsReviewReason:
      state === 'needs-review' ? point.reviewReason || 'A reviewer needs to check this point.' : '',
  };
}

export const STATE_LABEL: Record<PointStatus, string> = {
  empty: 'Not started',
  partial: 'In progress',
  complete: 'Uploaded',
  'needs-review': 'Needs review',
};

/** "3 of 12 points complete · 2 photos pending · 1 failed" */
export function progressSummary(progress: PointProgress[]): string {
  const done = progress.filter((p) => p.state === 'complete').length;
  const pending = progress.reduce((n, p) => n + p.pending, 0);
  const failed = progress.reduce((n, p) => n + p.failed, 0);
  const review = progress.filter((p) => p.state === 'needs-review').length;
  const parts = [`${done} of ${progress.length} points complete`];
  if (pending) parts.push(`${pending} photo${pending === 1 ? '' : 's'} pending`);
  if (failed) parts.push(`${failed} failed`);
  if (review) parts.push(`${review} need${review === 1 ? 's' : ''} review`);
  return parts.join(' · ');
}

/** Points sorted along the walking path and numbered 1…n. */
export function renumber<T extends { corridorDistancePx: number; order: number }>(
  points: T[],
): T[] {
  return [...points]
    .sort((a, b) => a.corridorDistancePx - b.corridorDistancePx)
    .map((p, i) => (p.order === i + 1 ? p : { ...p, order: i + 1 }));
}

/** Retry delay after `attempts` failed uploads: 2 s, 4 s, 8 s … capped at 60 s. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, attempts - 1));
}

/** "6.0 m along the corridor" when the scale is verified, else map pixels. */
export function distanceLabel(p: Pick<CapturePoint, 'distanceM' | 'corridorDistancePx'>): string {
  return p.distanceM !== null && p.distanceM !== undefined
    ? `${p.distanceM.toFixed(1)} m along the corridor`
    : `${Math.round(p.corridorDistancePx)} map px along the corridor (scale not verified)`;
}
