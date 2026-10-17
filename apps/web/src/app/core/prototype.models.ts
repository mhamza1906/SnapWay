/** Prototype-only view models. These are NOT the future backend API contract. */
export type DemoRole = 'admin' | 'volunteer';
export type ContributionStatus =
  'draft' | 'submitted' | 'changes-requested' | 'merged' | 'rejected';
export interface Room {
  id: string;
  name: string;
  kind: 'classroom' | 'office' | 'lab' | 'meeting' | 'amenity';
  x: number;
  y: number;
  width: number;
  height: number;
  accessible: boolean;
}
export interface Waypoint {
  id: string;
  label: string;
  x: number;
  y: number;
  roomId?: string;
}
export interface MapEdge {
  id: string;
  from: string;
  to: string;
  accessible: boolean;
  blocked: boolean;
}
export interface MapAnnotation {
  id: string;
  x: number;
  y: number;
  text: string;
  type: 'label' | 'pin';
}
export interface SceneReference {
  id: string;
  name: string;
  image: string;
  nodeId: string;
  direction: string;
  description: string;
  reviewed: boolean;
  createdAt: string;
}
export interface MapDocument {
  rooms: Room[];
  nodes: Waypoint[];
  edges: MapEdge[];
  annotations: MapAnnotation[];
  references: SceneReference[];
  sourceImage?: string;
  standardizedImage?: string;
}
export interface PublishedRevision {
  version: number;
  document: MapDocument;
  publishedAt: string;
  author: string;
}
export interface MappingTarget {
  id: string;
  name: string;
  building: string;
  floor: string;
  description: string;
  status: 'open' | 'archived';
  updatedAt: string;
  published: PublishedRevision | null;
  /** Retained local publications; absent in older schemaVersion 1 exports. */
  revisions?: PublishedRevision[];
}
export interface Contribution {
  id: string;
  targetId: string;
  title: string;
  author: string;
  baseRevision: number;
  status: ContributionStatus;
  document: MapDocument;
  summary: string;
  feedback: string;
  version: number;
  updatedAt: string;
}
export interface Activity {
  id: string;
  title: string;
  detail: string;
  at: string;
  targetId?: string;
}
export interface PrototypeState {
  schemaVersion: 1;
  profile: { name: string; role: DemoRole };
  targets: MappingTarget[];
  contributions: Contribution[];
  activity: Activity[];
}
