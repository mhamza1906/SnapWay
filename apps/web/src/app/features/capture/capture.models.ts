// Types of the photo capture contract (docs/photo-capture.md). The pipeline owns the map
// (corridors, planning, snapping); Django owns sessions, points and photos.

export interface XY {
  x: number;
  y: number;
}
export type Direction = 'forward' | 'reverse';
export type DirectionalSlot = 'forward' | 'left' | 'backward' | 'right';
export type Slot = DirectionalSlot | 'extra';
export type PositionSource =
  'planned' | 'contributor-confirmed' | 'contributor-adjusted' | 'manual';
export type PointStatus = 'empty' | 'partial' | 'complete' | 'needs-review';
export type PointReason =
  'start' | 'spacing' | 'turn' | 'junction' | 'door' | 'end' | 'adjusted' | (string & {});

// Pipeline map API (/pipeline/api/capture-map).
export interface MapFloorRef {
  id: string;
  label: string;
  revision: number;
  scaleVerified: boolean;
}
export interface MapBuilding {
  id: string;
  name: string;
  floors: MapFloorRef[];
}
export interface CorridorSegment {
  edgeId: string;
  reversed: boolean;
  startPx: number;
  endPx: number;
}
export interface Corridor {
  id: string;
  label: string;
  lengthPx: number;
  lengthM: number | null;
  /** The whole chain in forward orientation. */
  path: XY[];
  segments: CorridorSegment[];
  nodeIds: string[];
}
export interface MapNode {
  id: string;
  kind: string;
  label: string;
  x: number;
  y: number;
}
export interface Landmark {
  kind: 'room' | 'door' | (string & {});
  id: string;
  label: string;
  x: number;
  y: number;
}
export interface CaptureFloor {
  buildingId: string;
  floorId: string;
  floorLabel: string;
  revision: number;
  width: number;
  height: number;
  scale: { verified: boolean; pixelsPerMetre: number | null };
  svg: string;
  corridors: Corridor[];
  nodes: MapNode[];
  landmarks: Landmark[];
}
export interface Nearby {
  kind: string;
  id: string;
  label: string;
  distancePx: number;
}
export interface PlanPoint {
  /** `<corridorId>:<f|r>:<forward distance ×10>`; null for a snapped point. */
  planId: string | null;
  /** Null for a snapped point. */
  order: number | null;
  x: number;
  y: number;
  edgeId: string;
  nodeId: string | null;
  referenceEdgeId: string;
  fraction: number;
  corridorDistancePx: number;
  distanceM: number | null;
  forwardAngleDeg: number;
  reason: PointReason;
  nearby: Nearby[];
}
export interface CapturePlan {
  revision: number;
  scaleVerified: boolean;
  mode: 'auto' | 'manual';
  /** The spacing used; null in manual mode. */
  spacingM?: number | null;
  /** Walking order. */
  path: XY[];
  points: PlanPoint[];
}
export interface PlanRequest {
  buildingId: string;
  floorId: string;
  revision: number;
  corridorId: string;
  direction: Direction;
  spacingM?: number;
}
export type SnapRequest = Omit<PlanRequest, 'spacingM'> &
  ({ x: number; y: number } | { corridorDistancePx: number });

// Django capture API (/api/capture).
export interface MeTarget {
  id: string;
  title: string;
  role: string;
  mapBuildingId: string;
  mapFloorId: string;
}
export interface Me {
  authenticated: boolean;
  username: string;
  loginUrl: string;
  targets: MeTarget[];
}
export interface SessionBody {
  targetId: string;
  mapBuildingId: string;
  mapFloorId: string;
  mapRevision: number;
  corridorId: string;
  direction: Direction;
  spacingM: number | null;
}
export interface ServerSession extends SessionBody {
  id: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface PointBody {
  order: number;
  planId: string | null;
  mapRevision: number;
  edgeId: string;
  nodeId: string | null;
  referenceEdgeId: string;
  fraction: number;
  corridorDistancePx: number;
  distanceM: number | null;
  forwardAngleDeg: number;
  plannedX: number;
  plannedY: number;
  confirmedX: number | null;
  confirmedY: number | null;
  positionSource: PositionSource;
  reason: PointReason;
}
export interface ServerPoint extends PointBody {
  id: string;
  status?: PointStatus;
  reviewReason?: string;
}
export interface ServerPhoto {
  id: string;
  pointId?: string;
  point?: string;
  slot: Slot;
  viewingAngleDeg: number;
  uploadStatus?: string;
  reviewStatus?: 'pending' | 'needs-review' | 'accepted' | 'replaced' | (string & {});
  capturedAt?: string;
}
export interface SessionDetail extends ServerSession {
  points: ServerPoint[];
  photos: ServerPhoto[];
}
export interface PhotoMetadata {
  slot: Slot;
  viewingAngleDeg: number;
  directionSource: 'manual-confirmed';
  positionSource: PositionSource;
  capturedAt: string;
  clientSha256: string;
}

/** A capture point as the screen keeps it: the Django body plus client-only fields. */
export interface CapturePoint extends PointBody {
  id: string;
  nearby: Nearby[];
  status?: PointStatus;
  reviewReason?: string;
  /** False until Django confirmed the latest PUT of this point. */
  synced: boolean;
}
/** The active session on this phone. */
export interface ActiveSession {
  id: string;
  body: SessionBody;
  mode: 'auto' | 'manual';
  /** Walking order. */
  path: XY[];
  synced: boolean;
}
