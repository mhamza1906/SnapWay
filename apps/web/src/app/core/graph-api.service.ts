import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, Observable } from 'rxjs';

export type GraphNode = {
  id: string;
  x: number;
  y: number;
  label: string;
  kind: string;
};

export type GraphEdge = {
  id: string;
  from_node_id: string;
  to_node_id: string;
  cost: number;
};

export type GraphPayload = {
  revision_id: string;
  coordinate_frame: { width?: number; height?: number; origin?: string; units?: string };
  underlay_url: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type DraftEnsure = {
  target_id: string;
  contribution_id: string;
  revision_id: string;
  coordinate_frame: GraphPayload['coordinate_frame'];
  underlay_url: string | null;
};

export type NodePhoto = {
  id: string;
  asset_id: string;
  url: string;
  content_type: string;
  byte_size: number;
  status: string;
};

@Injectable({ providedIn: 'root' })
export class GraphApiService {
  readonly pending = signal(0);
  private track<T>(request: Observable<T>): Promise<T> {
    this.pending.update((n) => n + 1);
    return firstValueFrom(request).finally(() => this.pending.update((n) => n - 1));
  }

  private readonly http = inject(HttpClient);

  me() {
    return this.track(this.http.get<{ authenticated: boolean }>('/api/auth/me/'));
  }

  ensureDraft(targetId?: string, forceNew = false) {
    const body: { target_id?: string; force_new?: boolean } = {};
    if (targetId) body.target_id = targetId;
    if (forceNew) body.force_new = true;
    return this.track(this.http.post<DraftEnsure>('/api/maps/drafts/ensure/', body));
  }

  getGraph(revisionId: string) {
    return this.track(this.http.get<GraphPayload>(`/api/maps/revisions/${revisionId}/graph/`));
  }

  addNode(revisionId: string, body: { x: number; y: number; label?: string; kind?: string }) {
    return this.track(this.http.post<GraphNode>(`/api/maps/revisions/${revisionId}/nodes/`, body));
  }

  updateNode(revisionId: string, nodeId: string, label: string) {
    return this.track(
      this.http.patch<GraphNode>(`/api/maps/revisions/${revisionId}/nodes/${nodeId}/`, {
        label,
      }),
    );
  }

  removeNode(revisionId: string, nodeId: string) {
    return this.track(this.http.delete<void>(`/api/maps/revisions/${revisionId}/nodes/${nodeId}/`));
  }

  addEdge(revisionId: string, fromNodeId: string, toNodeId: string) {
    return this.track(
      this.http.post<GraphEdge>(`/api/maps/revisions/${revisionId}/edges/`, {
        from_node_id: fromNodeId,
        to_node_id: toNodeId,
      }),
    );
  }

  removeEdge(revisionId: string, edgeId: string) {
    return this.track(this.http.delete<void>(`/api/maps/revisions/${revisionId}/edges/${edgeId}/`));
  }

  updateEdge(revisionId: string, edgeId: string, cost: number) {
    return this.track(
      this.http.patch<GraphEdge>(`/api/maps/revisions/${revisionId}/edges/${edgeId}/`, { cost }),
    );
  }

  listNodePhotos(revisionId: string, nodeId: string) {
    return this.track(
      this.http.get<{ photos: NodePhoto[] }>(
        `/api/maps/revisions/${revisionId}/nodes/${nodeId}/photos/`,
      ),
    );
  }

  uploadNodePhoto(revisionId: string, nodeId: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    return this.track(
      this.http.post<NodePhoto>(`/api/maps/revisions/${revisionId}/nodes/${nodeId}/photos/`, form),
    );
  }

  deleteNodePhoto(revisionId: string, photoId: string) {
    return this.track(
      this.http.delete<void>(`/api/maps/revisions/${revisionId}/photos/${photoId}/`),
    );
  }

  uploadUnderlay(revisionId: string, file: File) {
    const form = new FormData();
    form.append('file', file);
    return this.track(
      this.http.post<{ underlay_url: string; coordinate_frame: GraphPayload['coordinate_frame'] }>(
        `/api/maps/revisions/${revisionId}/underlay/`,
        form,
      ),
    );
  }
}
