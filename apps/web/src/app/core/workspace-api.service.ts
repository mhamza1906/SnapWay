import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { GraphPayload } from './graph-api.service';

export interface MapCard {
  id: string;
  target_id: string;
  contribution_id: string | null;
  revision_id: string | null;
  title: string;
  building: string;
  floor: string;
  floor_code: string;
  status: string;
  kind: string;
  author: string;
  updated_at: string;
  sequence: number | null;
  preview_url: string | null;
  /** vector | optimize | source — My maps prefers vector, then optimize */
  preview_kind?: string | null;
  /** e.g. image_optimize | vectorized_demo — drives My maps edit destination */
  authoring_stage?: string | null;
  /** /map-optimize while raster review is open; otherwise /graph-editor */
  edit_path?: string;
  can_admin: boolean;
}
export interface MapRevision extends GraphPayload {
  vector_url: string | null;
  geometry: unknown;
  frozen: boolean;
}
export interface Comparison {
  contribution: MapCard;
  latest: MapRevision | null;
  selected: MapRevision;
  history: { revision_id: string; sequence: number; created_at: string }[];
}
export interface NewMap {
  building_name: string;
  floor_code: string;
  floor_name?: string;
  building_id?: string;
  place_id?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
}
export interface OptimizeReview {
  revision_id: string;
  target_id: string;
  contribution_id?: string;
  stage: string;
  model: string;
  source_url: string | null;
  optimized_url: string | null;
  coordinate_frame?: unknown;
  disclosure?: string | null;
  vector_url?: string | null;
  vector_mock?: boolean;
}
export interface VectorizeDemoResult {
  floorId: string;
  mock: boolean;
  provider: string;
  navigationReady: boolean;
  disclosure: string;
  svg_url: string;
  sha256: string;
}
const base = '/api/maps/workspace/';
@Injectable({ providedIn: 'root' })
export class WorkspaceApi {
  private readonly http = inject(HttpClient);
  maps() {
    return firstValueFrom(this.http.get<{ maps: MapCard[] }>(base));
  }
  create(data: NewMap) {
    return firstValueFrom(this.http.post<MapCard>(base, data));
  }
  edit(target: string) {
    return firstValueFrom(
      this.http.post<MapCard & MapRevision>(`${base}targets/${target}/edit/`, {}),
    );
  }
  optimizeStatus(target: string) {
    return firstValueFrom(this.http.get<OptimizeReview>(`${base}targets/${target}/optimize/`));
  }
  optimizeUpload(target: string, file: File, prompt = '') {
    const form = new FormData();
    form.append('file', file);
    if (prompt) form.append('prompt', prompt);
    return firstValueFrom(
      this.http.post<OptimizeReview>(`${base}targets/${target}/optimize/upload/`, form),
    );
  }
  optimizeRegenerate(target: string, prompt = '') {
    return firstValueFrom(
      this.http.post<OptimizeReview>(`${base}targets/${target}/optimize/regenerate/`, {
        ...(prompt ? { prompt } : {}),
      }),
    );
  }
  vectorizeDemo(target: string) {
    return firstValueFrom(
      this.http.post<OptimizeReview & VectorizeDemoResult>(
        `${base}targets/${target}/vectorize-demo/`,
        {},
      ),
    );
  }
  submit(contribution: string) {
    return firstValueFrom(
      this.http.post<MapCard>(`${base}contributions/${contribution}/submit/`, {}),
    );
  }
  importPipeline(contribution: string, data: { building: unknown; floor_id: string; svg: string }) {
    return firstValueFrom(
      this.http.post<MapCard>(`${base}contributions/${contribution}/pipeline/`, data),
    );
  }
  contributions() {
    return firstValueFrom(this.http.get<{ contributions: MapCard[] }>(`${base}contributions/`));
  }
  comparison(id: string, revision = '') {
    return firstValueFrom(
      this.http.get<Comparison>(`${base}contributions/${id}/`, {
        params: revision ? { revision } : {},
      }),
    );
  }
  review(id: string, decision: string, feedback = '') {
    return firstValueFrom(
      this.http.post<MapCard>(`${base}contributions/${id}/`, { decision, feedback }),
    );
  }
  archive(target: string) {
    return firstValueFrom(this.http.post(`${base}targets/${target}/archive/`, {}));
  }
  delete(target: string) {
    return firstValueFrom(this.http.delete(`${base}targets/${target}/archive/`));
  }
  activity() {
    return firstValueFrom(
      this.http.get<{
        events: { id: string; action: string; target: string; actor: string; at: string }[];
      }>(`${base}activity/`),
    );
  }
  exportUrl(target: string, format: string) {
    return `${base}targets/${target}/export/?kind=${format}`;
  }
}
export function workspaceError(error: unknown): string {
  const payload = (error as { error?: Record<string, unknown> })?.error;
  if (typeof payload?.['detail'] === 'string') return payload['detail'];
  if (payload && typeof payload === 'object') {
    const errors = Object.entries(payload)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => `${key.replaceAll('_', ' ')}: ${(value as string[]).join(' ')}`);
    if (errors.length) return errors.join(' ');
  }
  return 'The request could not be completed. Please retry.';
}
