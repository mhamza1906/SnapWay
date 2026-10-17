import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

// Client for the map-authoring pipeline service (apps/pipeline). The Angular dev
// server proxies /pipeline/** to it; provider keys never reach the browser.
export const PIPELINE_BASE = '/pipeline/api';

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
  spaces: { id: string; label: string; kind: string; doors: number }[];
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
  ok: boolean;
  provider: string;
  configured: boolean;
  model: string;
  effort?: string;
  environment?: string;
  imageModel?: { model: string; size: string; configured: boolean };
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
export interface CleanFloor {
  label: string;
  level: number;
  crop: { left: number; top: number; width: number; height: number };
  cached: boolean;
  latencyMs?: number;
  model: string;
  originalPreview: string;
  cleanPreview: string;
}
export interface CleanJob {
  id: string;
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  mode: PlanType;
  floors: number;
  error?: string;
  progress?: { stage: string; message: string };
  result?: {
    building: PipelineBuilding;
    summary: BuildingSummary;
    elapsedMs: number;
    imageModel: string;
    usage: { calls: number; tokens: number; images: number; cachedImages: number };
    floors: CleanFloor[];
  };
}
export interface Edited {
  building: PipelineBuilding;
  summary: BuildingSummary;
  [extra: string]: unknown;
}
export interface LibraryEntry {
  key: string;
  name: string;
  sourceLabel: string;
  floors: { label: string }[];
  rooms: number;
  modifiedAt: string;
}

@Injectable({ providedIn: 'root' })
export class PipelineService {
  private readonly http = inject(HttpClient);

  private post<T>(path: string, body: unknown): Promise<T> {
    return firstValueFrom(this.http.post<T>(`${PIPELINE_BASE}${path}`, body));
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
  /** Redraws each floor with the image model before mapping (paid). */
  startClean(
    file: File,
    opts: { mode: PlanType; floors: number; labels: string; name: string },
  ): Promise<{ id: string }> {
    const form = new FormData();
    form.append('plan', file);
    form.append('mode', opts.mode);
    form.append('floors', String(opts.floors));
    if (opts.labels) form.append('labels', opts.labels);
    if (opts.name) form.append('name', opts.name);
    return this.post('/authoring/clean-plans', form);
  }
  cleanJob(id: string): Promise<CleanJob> {
    return this.get(`/authoring/clean-plans/${id}`);
  }
  cancelClean(id: string): Promise<unknown> {
    return this.post(`/authoring/clean-plans/${id}/cancel`, {});
  }
  summary(building: PipelineBuilding): Promise<BuildingSummary> {
    return this.post('/authoring/summary', { building });
  }
  render(
    building: PipelineBuilding,
    floorId: string,
    overlay: { segments?: { a: Point; b: Point; color?: string }[]; routes?: Point[][] } = {},
  ): Promise<{ svg: string }> {
    return this.post('/authoring/render', { building, floorId, overlay });
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
    return this.post('/authoring/doorways/place', { building, floorId });
  }
  defineRoom(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
    reviewer: string,
  ): Promise<Edited> {
    return this.post('/authoring/doorways/define-room', { building, floorId, spaceId, reviewer });
  }
  notRoom(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
    reviewer: string,
  ): Promise<Edited> {
    return this.post('/authoring/doorways/not-room', { building, floorId, spaceId, reviewer });
  }
  edges(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
  ): Promise<{ edges: EdgeOption[] }> {
    return this.post('/authoring/doorways/edges', { building, floorId, spaceId });
  }
  addDoor(
    building: PipelineBuilding,
    floorId: string,
    spaceId: string,
    edgeKey: number | null,
    reviewer: string,
  ): Promise<Edited> {
    return this.post('/authoring/doorways/add', { building, floorId, spaceId, edgeKey, reviewer });
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
    return this.post('/authoring/doorways/edit', { building, floorId, ...edit });
  }
  removeDoor(
    building: PipelineBuilding,
    floorId: string,
    doorId: string,
    reviewer: string,
  ): Promise<Edited> {
    return this.post('/authoring/doorways/remove', { building, floorId, doorId, reviewer });
  }
  route(
    building: PipelineBuilding,
    from: string,
    to: string,
  ): Promise<{
    route: { steps: number; floors: { floorId: string; segments: Point[][] }[] } | null;
    message?: string;
  }> {
    return this.post('/authoring/routes', { building, from, to });
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
