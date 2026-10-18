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
