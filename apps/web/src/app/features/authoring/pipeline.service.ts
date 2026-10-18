import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

// Client for the map-authoring pipeline service (apps/pipeline). The Angular dev
// server proxies /pipeline/** to it; provider keys never reach the browser.
export const PIPELINE_BASE = '/api/maps/authoring-compute';

/** The pipeline's building JSON. Kept opaque here; the service owns its schema. */
export type PipelineBuilding = {
  id: string;
  name: string;
  floors: { id: string; label: string }[];
} & Record<string, unknown>;
export interface Point {
  x: number;
  y: number;
}
export interface RouteOptions {
  excludeStairs?: boolean;
  stairsPenalty?: number;
  elevatorPenalty?: number;
}
export interface RoutePreview {
  steps: number;
  floors: { floorId: string; segments: Point[][] }[];
  floorIds?: string[];
  instructions?: { text: string; floorId: string; targetFloorId?: string; step: number }[];
  transitions?: {
    connectorId: string;
    label: string;
    type: 'stairs' | 'elevator';
    fromFloorId: string;
    toFloorId: string;
  }[];
}
export interface EdgeOption {
  key: number;
  adjacentId: string;
  adjacentLabel: string;
  adjacentKind: string;
  hallway: boolean;
  length: number;
  doors: number | null;
  a: Point;
  b: Point;
}
export interface AssumedDoor {
  doorId: string;
  roomId: string;
  roomLabel: string;
  roomDoors: number;
  edgeKey: number | null;
  t: number;
  width: number;
  segment: { a: Point; b: Point };
  candidates: EdgeOption[];
}
/** Any doorway clicked on the map, with what is needed to move it (same fields as AssumedDoor). */
export interface DoorwayInfo extends AssumedDoor {
  label: string;
  /** verified, assumed, legacy (usable, no per-opening record), stale or rejected. */
  state: string;
  assumed: boolean;
  joins: { id: string; label: string }[];
}
/** One recorded two-room merge: `removedLabel` was merged into the region `keptId`. */
export interface MergeRecord {
  recordId: string;
  keptId: string;
  /** The merged region's current name. */
  label: string;
  keptLabel: string;
  removedId: string;
  removedLabel: string;
  at: string;
  /** False, with `reason`, when a later merge of the same region must be undone first. */
  undoable: boolean;
  reason: string | null;
}
/** A walkable space (region) on a floor. */
export interface SpaceSummary {
  id: string;
  label: string;
  kind: string;
  doors: number;
  /** The map author's stair decision; absent in responses from older pipeline builds. */
  stair?: boolean;
  /** The map author's role decision beyond the kind: stair, hall room or closed. */
  use?: 'stair' | 'hall' | 'closed' | null;
  /** Closed regions stay on the map but are never routed through. */
  closed?: boolean;
  /** Regions close to this one (touching or within a short reach): the ones it can merge with. */
  neighbours?: string[];
}
/**
 * How a region is used, sent as `kind` to spaces/kind. A hall room is a room people also
 * walk through (still a destination); closed regions are shown but never routed through.
 */
export type SpaceRole = 'room' | 'hall-room' | 'corridor' | 'lobby' | 'stair' | 'closed';
/** Extra drawing on the server-rendered floor SVG. */
export interface RenderOverlay {
  segments?: { a: Point; b: Point; color?: string }[];
  routes?: Point[][];
  /** Space ids to highlight on the map. */
  highlight?: string[];
  /** A space id; the returned SVG is zoomed (viewBox cropped) to that region. */
  focus?: string;
  /** Numbered photo points to draw (from hallPoints). */
  photoPoints?: HallPoint[];
}
export interface HallPoint {
  order: number;
  x: number;
  y: number;
  reason: 'junction' | 'end' | 'spacing' | 'turn';
  /** Editor only: a stable key for picking the point, and whether it is picked. */
  key?: number;
  selected?: boolean;
}
export interface HallPlan {
  selectionMode?: 'sparse' | 'adaptive';
  maxPoints?: number;
  recommendedPoints?: number;
  lengthPx?: number;
  candidateCount?: number;
  spaceId: string;
  label: string;
  scaleVerified: boolean;
  spacingM: number | null;
  spacingPx: number;
  lines: Point[][];
  points: HallPoint[];
}
export interface FloorSummary {
  floorId: string;
  label: string;
  level: number;
  geometryStatus: string;
  regions: number;
  rooms: {
    id: string;
    label: string;
    kind: string;
    ready: boolean;
    reason: string;
    doors: number;
  }[];
  spaces: SpaceSummary[];
  /** Spaces the map author marked as stairs; absent in responses from older pipeline builds. */
  stairs?: { id: string; label: string }[];
  /** Merges that can be undone, newest first; absent in responses from older pipeline builds. */
  merges?: MergeRecord[];
  /** Thin strips between walls, each with the region it would fold into; absent in older responses. */
  strips?: { id: string; label: string; hostId: string | null; hostLabel: string | null }[];
  needsAttention: {
    spaceId: string;
    label: string;
    kind: string;
    status: string;
    reason: string;
  }[];
  assumed: AssumedDoor[];
  counts: { verified: number; assumed: number; ready: number; destinations: number };
}
export interface BuildingSummary {
  id: string;
  name: string;
  floors: FloorSummary[];
  validationErrors: number;
}
export interface Health {
  authoringJobs?: boolean;
  savedProject?: boolean;
  ok: boolean;
  provider: string;
  configured: boolean;
  model: string;
  effort?: string;
  environment?: string;
}
export interface MapJob {
  id: string;
  status: string;
  error?: string;
  progress?: {
    stage: string;
    message: string;
    stats?: { calls: number; tokens: number; cacheHits: number };
  };
  result?: {
    status: string;
    stats: { calls: number; tokens: number };
    summary: Record<string, number>;
  };
}
export type PlanType = 'floor' | 'building';
export interface Edited {
  building: PipelineBuilding;
  summary: BuildingSummary;
  [extra: string]: unknown;
}
/** A merge response also names the merged region (it keeps the first selected id). */
/**
 * `absorbed`: regions between the chosen rooms taken in whole; `carved`: regions (such as
 * a corridor) that gave up only the part directly between the rooms.
 */
export type Merged = Edited & {
  spaceId: string;
  absorbed?: { id: string; label: string }[];
  carved?: { id: string; label: string }[];
};
export interface LibraryEntry {
  key: string;
  name: string;
  sourceLabel: string;
  floors: { label: string }[];
  rooms: number;
  modifiedAt: string;
}

/**
 * A valid 1×1 PNG sent in place of every embedded image on authoring calls that never
 * read the pixels (summaries, renders, routes, doorway and region edits).
 */
export const IMAGE_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** The real images of one building, keyed by where they sit (asset id, floor id). */
export type ImageCache = Map<string, string>;
const assetKey = (id: string) => `asset:${id}`;
const floorKey = (floorId: string) => `floor:${floorId}`;
const historyKey = (floorId: string, h: Json) => `history:${floorId}:${h['revision']}:${h['at']}`;
const snapshotKey = (floorId: string, s: Json) =>
  `snapshot:${floorId}:${s['sourceId']}:${s['cacheKey']}:${s['createdAt']}`;

/** `holder.geometry.source.dataUrl`, swapped for the placeholder; the real image goes to `images`. */
function lightGeometry<T>(holder: T, key: string, images: ImageCache): T {
  if (!isObject(holder) || !isObject(holder['geometry'])) return holder;
  const geometry = holder['geometry'],
    source = geometry['source'];
  if (!isObject(source) || typeof source['dataUrl'] !== 'string') return holder;
  if (source['dataUrl'] !== IMAGE_PLACEHOLDER && !images.has(key))
    images.set(key, source['dataUrl']);
  return {
    ...holder,
    geometry: { ...geometry, source: { ...source, dataUrl: IMAGE_PLACEHOLDER } },
  };
}

/**
 * A shallow copy of the building with every embedded image (assets, each floor's
 * geometry source, its history and snapshots) replaced by IMAGE_PLACEHOLDER. The
 * building itself is not changed; the real images are returned in `images`.
 */
export function lightBuilding(building: PipelineBuilding): {
  light: PipelineBuilding;
  images: ImageCache;
} {
  const images: ImageCache = new Map(),
    b = building as Json,
    assets = isObject(b['assets'])
      ? Object.fromEntries(
          Object.entries(b['assets']).map(([id, a]) => {
            if (!isObject(a) || typeof a['dataUrl'] !== 'string') return [id, a];
            if (a['dataUrl'] !== IMAGE_PLACEHOLDER) images.set(assetKey(id), a['dataUrl']);
            return [id, { ...a, dataUrl: IMAGE_PLACEHOLDER }];
          }),
        )
      : b['assets'],
    floors = building.floors.map((floor) => {
      const f = lightGeometry(floor as Json, floorKey(floor.id), images);
      return {
        ...f,
        ...(Array.isArray(f['history'])
          ? {
              history: f['history'].map((h) =>
                isObject(h) ? lightGeometry(h, historyKey(floor.id, h), images) : h,
              ),
            }
          : {}),
        ...(Array.isArray(f['snapshots'])
          ? {
              snapshots: f['snapshots'].map((s) =>
                isObject(s) ? lightGeometry(s, snapshotKey(floor.id, s), images) : s,
              ),
            }
          : {}),
      } as PipelineBuilding['floors'][number];
    });
  return {
    light: { ...building, ...(b['assets'] !== undefined ? { assets } : {}), floors },
    images,
  };
}

/**
 * Puts the real images back into a building the service returned (in place). Only
 * placeholders are replaced, so an image the service sent back is never overwritten.
 * History or snapshot entries the service added come from the floor's current
 * geometry, so they get the floor's image.
 */
export function restoreImages<T>(building: T, images: ImageCache): T {
  if (!isObject(building) || !images.size) return building;
  const fill = (holder: unknown, ...keys: string[]) => {
    const source = isObject(holder) && isObject(holder['geometry']) && holder['geometry']['source'];
    if (!isObject(source) || source['dataUrl'] !== IMAGE_PLACEHOLDER) return;
    const real = keys.map((k) => images.get(k)).find((v) => v !== undefined);
    if (real !== undefined) source['dataUrl'] = real;
  };
  if (isObject(building['assets']))
    for (const [id, a] of Object.entries(building['assets'])) {
      const real = images.get(assetKey(id));
      if (isObject(a) && a['dataUrl'] === IMAGE_PLACEHOLDER && real !== undefined)
        a['dataUrl'] = real;
    }
  for (const f of list(building['floors'])) {
    if (!isObject(f) || typeof f['id'] !== 'string') continue;
    const id = f['id'];
    fill(f, floorKey(id));
    for (const h of list(f['history'])) if (isObject(h)) fill(h, historyKey(id, h), floorKey(id));
    for (const s of list(f['snapshots']))
      if (isObject(s)) fill(s, snapshotKey(id, s), floorKey(id));
  }
  return building;
}

@Injectable({ providedIn: 'root' })
export class PipelineService {
  private readonly http = inject(HttpClient);

  private post<T>(path: string, body: unknown): Promise<T> {
    return firstValueFrom(this.http.post<T>(`${PIPELINE_BASE}${path}`, body));
  }
  /**
   * Posts `{ building, ...rest }` with the images left out (see lightBuilding), and puts
   * them back into any `building` in the response, so callers only ever see real images.
   */
  private async postLight<T>(
    path: string,
    building: PipelineBuilding,
    rest: Json = {},
  ): Promise<T> {
    const { light, images } = lightBuilding(building),
      res = await this.post<T>(path, { building: light, ...rest });
    if (isObject(res) && isObject(res['building'])) restoreImages(res['building'], images);
    return res;
  }
  private get<T>(path: string): Promise<T> {
    return firstValueFrom(this.http.get<T>(`${PIPELINE_BASE}${path}`));
  }

  health(): Promise<Health> {
    return this.get('/health');
  }
  uploadPlan(file: File, name: string, floorLabel = ''): Promise<Edited> {
    const form = new FormData();
    form.append('plan', file);
    if (name) form.append('name', name);
    if (floorLabel) form.append('floorLabel', floorLabel);
    return this.post('/authoring/plans', form);
  }
  summary(building: PipelineBuilding): Promise<BuildingSummary> {
    return this.postLight('/authoring/summary', building);
  }
  render(
    building: PipelineBuilding,
    floorId: string,
    overlay: RenderOverlay = {},
  ): Promise<{ svg: string }> {
    return this.postLight('/authoring/render', building, { floorId, overlay });
  }
  /** Starts the paid AI mapping run for the given floors (one job at a time per service). */
  startJob(building: PipelineBuilding, floorIds: string[]): Promise<{ id: string }> {
    return this.post('/map-jobs', { building, options: { floorIds } });
  }
  job(id: string): Promise<MapJob> {
    return this.get(`/map-jobs/${id}`);
  }
  cancelJob(id: string): Promise<unknown> {
    return this.post(`/map-jobs/${id}/cancel`, {});
  }
  applyJob(id: string, building: PipelineBuilding): Promise<{ building: PipelineBuilding }> {
    return this.post(`/map-jobs/${id}/apply`, { building });
  }
  placeDoorways(building: PipelineBuilding, floorId?: string): Promise<Edited> {
    return this.postLight('/authoring/doorways/place', building, { floorId });
  }
  defineRoom(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
    reviewer: string,
  ): Promise<Edited> {
    return this.postLight('/authoring/doorways/define-room', building, {
      floorId,
      spaceId,
      reviewer,
    });
  }
  notRoom(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
    reviewer: string,
  ): Promise<Edited> {
    return this.postLight('/authoring/doorways/not-room', building, { floorId, spaceId, reviewer });
  }
  /** A doorway clicked on the map: the rooms it joins, its state and where it can move. */
  describeDoor(building: PipelineBuilding, floorId: string, doorId: string): Promise<DoorwayInfo> {
    return this.postLight('/authoring/doorways/describe', building, { floorId, doorId });
  }
  edges(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
  ): Promise<{ edges: EdgeOption[] }> {
    return this.postLight('/authoring/doorways/edges', building, { floorId, spaceId });
  }
  addDoor(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
    edgeKey: number | null,
    reviewer: string,
  ): Promise<Edited> {
    return this.postLight('/authoring/doorways/add', building, {
      floorId,
      spaceId,
      edgeKey,
      reviewer,
    });
  }
  editDoor(
    building: PipelineBuilding,
    floorId: string,
    edit: {
      doorId: string;
      edgeKey: number;
      t: number;
      width: number;
      confirm?: boolean;
      reviewer?: string;
    },
  ): Promise<Edited> {
    return this.postLight('/authoring/doorways/edit', building, { floorId, ...edit });
  }
  /** Several doorways removed the same way, in one request. */
  removeDoors(
    building: PipelineBuilding,
    floorId: string,
    doorIds: string[],
    reviewer: string,
    as: 'wall' | 'none',
  ): Promise<Edited> {
    return this.postLight('/authoring/doorways/remove', building, {
      floorId,
      doorIds,
      reviewer,
      as,
    });
  }
  /** `as`: 'wall' turns the opening into a wall (drawn black); 'none' removes the line. */
  removeDoor(
    building: PipelineBuilding,
    floorId: string,
    doorId: string,
    reviewer: string,
    as: 'wall' | 'none' = 'none',
  ): Promise<Edited> {
    return this.postLight('/authoring/doorways/remove', building, {
      floorId,
      doorId,
      reviewer,
      as,
    });
  }
  // Region decisions (names, roles, merges) are the map author's; the AI only suggests names.
  renameSpace(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
    label: string,
    reviewer: string,
  ): Promise<Edited> {
    return this.postLight('/authoring/spaces/rename', building, {
      floorId,
      spaceId,
      label,
      reviewer,
    });
  }
  /** Sets a region's role; choosing any other role re-opens a closed region or un-stairs a stair. */
  setKind(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
    kind: SpaceRole,
    reviewer: string,
  ): Promise<Edited> {
    return this.postLight('/authoring/spaces/kind', building, {
      floorId,
      spaceId,
      kind,
      reviewer,
    });
  }
  mergeSpaces(
    building: PipelineBuilding,
    floorId: string,
    merge: { spaceIds: string[]; label?: string; stair?: boolean; reviewer: string },
  ): Promise<Merged> {
    return this.postLight('/authoring/spaces/merge', building, { floorId, ...merge });
  }
  /** Photo points for a whole hall, in walking order (read-only). */
  hallPoints(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
    maxPoints = 40,
  ): Promise<HallPlan> {
    return this.postLight('/authoring/hall-points', building, { floorId, spaceId, maxPoints });
  }
  /** Folds every thin strip on the floor into its neighbour (each undoable under Merged rooms). */
  foldStrips(
    building: PipelineBuilding,
    floorId: string,
    reviewer: string,
  ): Promise<
    Edited & {
      absorbed?: { label: string; hostLabel: string }[];
      skipped?: { label: string; reason: string }[];
    }
  > {
    return this.postLight('/authoring/spaces/fold-strips', building, { floorId, reviewer });
  }
  /** Undoes one recorded merge: both rooms come back as they were before it. */
  unmergeSpaces(
    building: PipelineBuilding,
    floorId: string,
    recordId: string,
    reviewer: string,
  ): Promise<Edited> {
    return this.postLight('/authoring/spaces/unmerge', building, { floorId, recordId, reviewer });
  }
  route(
    building: PipelineBuilding,
    from: string,
    to: string,
    options: RouteOptions = {},
  ): Promise<{
    route: RoutePreview | null;
    message?: string;
  }> {
    return this.postLight('/authoring/routes', building, { from, to, options });
  }
  library(): Promise<{ buildings: LibraryEntry[] }> {
    return this.get('/buildings');
  }
  openBuilding(key: string): Promise<PipelineBuilding> {
    return this.get(`/buildings/${encodeURIComponent(key)}`);
  }
  saveCopy(building: PipelineBuilding): Promise<{ key: string; updated: boolean }> {
    return this.post('/buildings/copies', building);
  }
}
