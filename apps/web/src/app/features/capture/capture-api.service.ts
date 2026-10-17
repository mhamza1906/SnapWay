import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PIPELINE_BASE } from '../authoring/pipeline.service';
import type {
  CaptureFloor,
  CapturePlan,
  MapBuilding,
  Me,
  PhotoMetadata,
  PlanPoint,
  PlanRequest,
  PointBody,
  ServerPoint,
  ServerSession,
  SessionBody,
  SessionDetail,
  SnapRequest,
} from './capture.models';

/** Pipeline map API (proxied /pipeline → apps/pipeline). */
export const CAPTURE_MAP_BASE = `${PIPELINE_BASE}/capture-map`;
/** Django capture API (proxied /api → apps/api). */
export const CAPTURE_API_BASE = '/api/capture';

const enc = encodeURIComponent;

/** A short, user-facing reason for a failed request. */
export function requestError(error: unknown, what: string): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0)
      return `${what}: the server could not be reached. Check the connection.`;
    if (error.status === 401 || error.status === 403)
      return `${what}: you are not signed in or not a member of this mapping target.`;
    const detail =
      typeof error.error === 'object' && error.error
        ? (error.error['detail'] ?? error.error['error'] ?? error.error['message'])
        : '';
    return `${what} (HTTP ${error.status})${detail ? `: ${detail}` : '.'}`;
  }
  return `${what}: ${error instanceof Error ? error.message : 'unexpected error'}.`;
}

@Injectable({ providedIn: 'root' })
export class CaptureApi {
  private readonly http = inject(HttpClient);

  /**
   * Django session auth: same-origin cookies. The CSRF header comes from Angular's built-in
   * XSRF interceptor (enabled by provideHttpClient): it copies the `XSRF-TOKEN` cookie that
   * Django sets on `GET /me` into `X-XSRF-TOKEN` on every same-origin write.
   */
  private writeOptions() {
    return { withCredentials: true };
  }
  private readOptions() {
    return { withCredentials: true };
  }

  // Pipeline map API.
  buildings(): Promise<MapBuilding[]> {
    return firstValueFrom(this.http.get<MapBuilding[]>(`${CAPTURE_MAP_BASE}/buildings`));
  }
  floor(buildingId: string, floorId: string): Promise<CaptureFloor> {
    return firstValueFrom(
      this.http.get<CaptureFloor>(
        `${CAPTURE_MAP_BASE}/buildings/${enc(buildingId)}/floors/${enc(floorId)}`,
      ),
    );
  }
  plan(body: PlanRequest): Promise<CapturePlan> {
    return firstValueFrom(this.http.post<CapturePlan>(`${CAPTURE_MAP_BASE}/plan`, body));
  }
  snap(body: SnapRequest): Promise<PlanPoint> {
    return firstValueFrom(this.http.post<PlanPoint>(`${CAPTURE_MAP_BASE}/snap`, body));
  }

  // Django capture API.
  me(): Promise<Me> {
    return firstValueFrom(this.http.get<Me>(`${CAPTURE_API_BASE}/me`, this.readOptions()));
  }
  /** Latest first. Accepts a plain list or a `{ results | sessions }` wrapper. */
  async sessions(targetId: string, mapFloorId: string): Promise<ServerSession[]> {
    const res = await firstValueFrom(
      this.http.get<ServerSession[] | { results?: ServerSession[]; sessions?: ServerSession[] }>(
        `${CAPTURE_API_BASE}/sessions`,
        { ...this.readOptions(), params: { targetId, mapFloorId } },
      ),
    );
    return Array.isArray(res) ? res : (res?.results ?? res?.sessions ?? []);
  }
  session(id: string): Promise<SessionDetail> {
    return firstValueFrom(
      this.http.get<SessionDetail>(`${CAPTURE_API_BASE}/sessions/${enc(id)}`, this.readOptions()),
    );
  }
  putSession(id: string, body: SessionBody): Promise<ServerSession> {
    return firstValueFrom(
      this.http.put<ServerSession>(
        `${CAPTURE_API_BASE}/sessions/${enc(id)}`,
        body,
        this.writeOptions(),
      ),
    );
  }
  putPoint(sessionId: string, pointId: string, body: PointBody): Promise<ServerPoint> {
    return firstValueFrom(
      this.http.put<ServerPoint>(
        `${CAPTURE_API_BASE}/sessions/${enc(sessionId)}/points/${enc(pointId)}`,
        body,
        this.writeOptions(),
      ),
    );
  }
  deletePoint(sessionId: string, pointId: string): Promise<unknown> {
    return firstValueFrom(
      this.http.delete(
        `${CAPTURE_API_BASE}/sessions/${enc(sessionId)}/points/${enc(pointId)}`,
        this.writeOptions(),
      ),
    );
  }
  /** Idempotent: the same photo ID with the same image returns 200 on a retry. */
  putPhoto(pointId: string, photoId: string, image: Blob, metadata: PhotoMetadata) {
    const form = new FormData();
    form.append('image', image, `${photoId}.jpg`);
    form.append('metadata', JSON.stringify(metadata));
    return firstValueFrom(
      this.http.put(`${CAPTURE_API_BASE}/points/${enc(pointId)}/photos/${enc(photoId)}`, form, {
        ...this.writeOptions(),
        observe: 'response',
      }),
    );
  }
  revisionCheck(sessionId: string, currentRevision: number): Promise<unknown> {
    return firstValueFrom(
      this.http.post(
        `${CAPTURE_API_BASE}/sessions/${enc(sessionId)}/revision-check`,
        { currentRevision },
        this.writeOptions(),
      ),
    );
  }
}
