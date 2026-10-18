import { Component, computed, HostListener, inject, OnInit, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { VisitorCamera } from '../visitor/visitor-camera';
import type { MatchResult } from '../../core/place-match';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  GraphApiService,
  GraphEdge,
  GraphNode,
  NodePhoto,
  type PhotoDirection,
} from '../../core/graph-api.service';
import { GraphCanvas, GraphTool } from '../graph-editor/graph-canvas';
import { PointPhotoQueue, type PendingPointPhoto } from '../graph-editor/point-photo-queue';

@Component({
  selector: 'app-photo-walk-editor',
  imports: [GraphCanvas, RouterLink, VisitorCamera, NgTemplateOutlet],
  templateUrl: './photo-walk-editor.html',
  styleUrls: ['./photo-walk-editor.scss', './phone-walk.scss'],
})
export class PhotoWalkEditorPage implements OnInit {
  private readonly api = inject(GraphApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly phoneQueue = inject(PointPhotoQueue);
  readonly captureMode = signal(this.route.snapshot.queryParamMap.get('mode') === 'photos');
  readonly cloudReady = signal(true);
  readonly savedWalks = signal<{ target_id: string; title: string; floor: string }[]>([]);
  readonly capturePoints = computed(() => {
    const pending = new Set(this.pendingPhotos().map((item) => item.nodeId));
    const numbered = this.nodes().filter(
      (node) =>
        /^Point\s+\d+$/i.test(node.label) || node.photo_directions?.length || pending.has(node.id),
    );
    return (numbered.length ? numbered : this.nodes().filter((node) => node.kind === 'checkpoint'))
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  });
  readonly pointIndex = computed(() =>
    this.capturePoints().findIndex((point) => point.id === this.selectedNodeId()),
  );
  readonly pendingPhotos = computed(() =>
    this.phoneQueue.items().filter((item) => item.revisionId === this.revisionId()),
  );
  readonly uploadedViews = computed(() =>
    this.capturePoints().reduce((sum, node) => sum + (node.photo_directions?.length ?? 0), 0),
  );
  readonly completedPoints = computed(
    () => this.capturePoints().filter((node) => node.photo_directions?.length === 4).length,
  );

  readonly tool = signal<GraphTool>('add');
  readonly status = signal('Loading draft…');
  readonly error = signal<string | null>(null);
  readonly revisionId = signal<string | null>(null);
  readonly targetId = signal<string | null>(null);
  readonly underlayUrl = signal<string | null>(null);
  readonly width = signal(1000);
  readonly height = signal(640);
  readonly nodes = signal<GraphNode[]>([]);
  readonly edges = signal<GraphEdge[]>([]);
  readonly selectedNodeId = signal<string | null>(null);
  readonly selectedEdgeId = signal<string | null>(null);
  readonly connectFromId = signal<string | null>(null);
  readonly labelDraft = signal('');
  readonly editLabel = signal('');
  readonly photos = signal<NodePhoto[]>([]);
  readonly photosLoading = signal(false);
  readonly photoUploading = signal(false);
  private photoLoadVersion = 0;
  readonly authenticated = signal(false);
  readonly liveCameraOpen = signal(false);
  readonly indexLoading = signal(false);
  readonly indexReady = signal(false);
  readonly indexSummary = signal('No reference index loaded.');
  readonly liveMatchStatus = signal('');
  readonly canTestLive = computed(
    () => this.authenticated() && !!this.revisionId() && this.indexReady() && !this.indexLoading(),
  );
  private indexLoadVersion = 0;

  async refreshIndexStatus(): Promise<void> {
    const revision = this.revisionId();
    if (!revision || !this.authenticated()) return;
    const version = ++this.indexLoadVersion;
    this.indexLoading.set(true);
    this.indexReady.set(false);
    this.indexSummary.set('Checking saved reference index…');
    try {
      const index = await this.api.getIndexStatus(revision);
      if (version !== this.indexLoadVersion || revision !== this.revisionId()) return;
      const ready = index.state === 'ready' && !!index.asset_id;
      this.indexReady.set(ready);
      const count = Number(index.profile?.['n_references']);
      this.indexSummary.set(
        ready
          ? Number.isFinite(count) && count > 0
            ? `${count} reference photos in the saved MegaLoc index.`
            : 'Saved MegaLoc reference index is ready.'
          : index.state === 'pending'
            ? 'Reference index is being prepared. Refresh its status when the build finishes.'
            : 'No ready reference index. Upload photos and rebuild the MegaLoc index before testing.',
      );
    } catch {
      if (version === this.indexLoadVersion && revision === this.revisionId())
        this.indexSummary.set(
          'Could not check the reference index. Refresh its status to try again.',
        );
    } finally {
      if (version === this.indexLoadVersion) this.indexLoading.set(false);
    }
  }

  openLiveTest(): void {
    if (!this.canTestLive()) return;
    this.liveMatchStatus.set('');
    this.liveCameraOpen.set(true);
  }

  async acceptLiveMatch(result: MatchResult): Promise<void> {
    if (!this.liveCameraOpen() || result.decision.outcome !== 'likely_match') return;
    const resolved = result.matched_node;
    const revision = resolved?.revision_id ?? result.revision_id ?? result.decision.revision_id;
    const id =
      resolved?.node_id ?? result.node_id ?? result.decision.node_id ?? result.decision.location_id;
    if (
      revision !== this.revisionId() ||
      (resolved && resolved.target_id !== this.targetId()) ||
      (resolved && result.node_id != null && resolved.node_id !== result.node_id) ||
      (resolved && result.revision_id != null && resolved.revision_id !== result.revision_id)
    ) {
      this.liveMatchStatus.set(
        'The match belongs to another saved map. Your selected stop is unchanged.',
      );
      return;
    }
    const node = this.nodes().find((item) => item.id === id);
    if (!node) {
      this.liveMatchStatus.set(
        'The matched point is not in this draft. Your selected stop is unchanged.',
      );
      return;
    }
    this.liveMatchStatus.set(
      `Likely location: ${node.label || 'Unnamed point'}. Confirm your surroundings.`,
    );
    this.setTool('select');
    await this.onNodeClick(node.id);
  }

  async acceptSingleMatch(result: MatchResult): Promise<void> {
    await this.acceptLiveMatch(result);
    this.liveCameraOpen.set(false);
  }

  async ngOnInit(): Promise<void> {
    try {
      const me = await this.api.me();
      this.authenticated.set(!!me?.authenticated);
      if (!me?.authenticated) {
        this.status.set('Sign in required');
        this.error.set(
          'Sign in via Google or Django admin session, then reload. Membership is required to edit.',
        );
        return;
      }
      await this.phoneQueue.open(me.username || me.email || 'signed-in-user');
      const targetHint = this.route.snapshot.queryParamMap.get('target') ?? undefined;
      const draft = await this.api.ensureDraft(targetHint);
      this.revisionId.set(draft.revision_id);
      this.targetId.set(draft.target_id);
      this.applyFrame(draft.coordinate_frame);
      this.underlayUrl.set(draft.underlay_url);
      // Pin target in the URL so refresh resumes the same draft (edits auto-save via API).
      await this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { target: draft.target_id, ...(this.captureMode() ? { mode: 'photos' } : {}) },
        replaceUrl: true,
      });
      await this.refresh();
      await this.refreshIndexStatus();
      if (this.captureMode()) {
        this.savedWalks.set((await this.api.listDrafts()).drafts);
        await this.startPhotoWalk();
      }
      const n = this.nodes().length;
      const e = this.edges().length;
      this.status.set(
        `Auto-saves to server · ${n} waypoint${n === 1 ? '' : 's'}, ${e} connection${e === 1 ? '' : 's'}`,
      );
    } catch (err) {
      this.error.set(this.message(err));
      this.status.set('Could not open draft');
    }
  }

  async setPhotoMode(enabled: boolean): Promise<void> {
    this.captureMode.set(enabled);
    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { mode: enabled ? 'photos' : null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    if (enabled) {
      this.savedWalks.set((await this.api.listDrafts()).drafts);
      await this.startPhotoWalk();
    }
  }

  async openSavedWalk(target: string): Promise<void> {
    if (this.photoUploading()) return;
    this.liveCameraOpen.set(false);
    this.liveMatchStatus.set('');
    ++this.indexLoadVersion;
    this.indexLoading.set(false);
    this.indexReady.set(false);
    this.indexSummary.set('Checking saved reference index…');
    try {
      const draft = await this.api.ensureDraft(target);
      this.clearSelection();
      this.targetId.set(draft.target_id);
      this.revisionId.set(draft.revision_id);
      await this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { target, mode: 'photos' },
        replaceUrl: true,
      });
      await this.refresh();
      await this.refreshIndexStatus();
      await this.startPhotoWalk();
      this.error.set(null);
    } catch (error) {
      this.error.set(this.message(error));
    }
  }

  private async startPhotoWalk(): Promise<void> {
    this.setTool('select');
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(`snapway-photo-stop:${this.revisionId()}`);
    } catch {
      /* Optional resume hint. */
    }
    const points = this.capturePoints();
    const first =
      points.find((point) => point.id === saved) ||
      points.find((point) => (point.photo_directions?.length ?? 0) < 4) ||
      points[0];
    if (first) await this.onNodeClick(first.id);
  }

  async movePoint(offset: number): Promise<void> {
    const point = this.capturePoints()[this.pointIndex() + offset];
    if (point) await this.onNodeClick(point.id);
  }

  pendingFor(direction: PhotoDirection): boolean {
    return this.pendingPhotos().some(
      (item) => item.nodeId === this.selectedNodeId() && item.direction === direction,
    );
  }

  @HostListener('window:online')
  async retryPending(): Promise<void> {
    if (this.photoUploading() || !this.revisionId()) return;
    this.photoUploading.set(true);
    this.error.set(null);
    try {
      await this.refresh();
      if (!this.cloudReady())
        throw new Error(
          'Cloud storage is not configured yet. Your pending photos remain on this phone.',
        );
      for (const item of this.pendingPhotos()) await this.syncPhoneItem(item);
      this.status.set('All pending photos uploaded to cloud storage.');
    } catch (error) {
      this.error.set(this.message(error));
    } finally {
      this.photoUploading.set(false);
    }
  }

  private async syncPhoneItem(item: PendingPointPhoto): Promise<void> {
    const file = new File([item.blob], item.filename, { type: item.blob.type });
    const photo = await this.api.uploadNodePhoto(
      item.revisionId,
      item.nodeId,
      file,
      item.direction,
      'walking_relative',
    );
    await this.phoneQueue.remove(item.id);
    if (this.revisionId() !== item.revisionId) return;
    this.nodes.update((nodes) =>
      nodes.map((node) =>
        node.id === item.nodeId
          ? {
              ...node,
              photo_directions: [...new Set([...(node.photo_directions ?? []), item.direction])],
            }
          : node,
      ),
    );
    if (this.selectedNodeId() === item.nodeId)
      this.photos.update((photos) => [
        ...photos.filter((old) => old.direction !== item.direction),
        photo,
      ]);
  }

  /** Start a brand-new empty map (does not delete the previous draft). */
  async startNewMap(): Promise<void> {
    this.liveCameraOpen.set(false);
    this.liveMatchStatus.set('');
    ++this.indexLoadVersion;
    this.indexLoading.set(false);
    this.indexReady.set(false);
    this.indexSummary.set('Checking saved reference index…');
    this.clearSelection();
    this.nodes.set([]);
    this.edges.set([]);
    this.status.set('Creating new map…');
    try {
      // Bypass resume by omitting target; force create via dedicated ensure with new flag.
      const draft = await this.api.ensureDraft(undefined, true);
      this.revisionId.set(draft.revision_id);
      this.targetId.set(draft.target_id);
      this.applyFrame(draft.coordinate_frame);
      this.underlayUrl.set(draft.underlay_url);
      await this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { target: draft.target_id },
        replaceUrl: true,
      });
      await this.refresh();
      await this.refreshIndexStatus();
      this.status.set('New map ready — edits auto-save to the server');
      this.error.set(null);
    } catch (err) {
      this.error.set(this.message(err));
      this.status.set('Could not create map');
    }
  }

  setTool(tool: GraphTool): void {
    this.tool.set(tool);
    this.connectFromId.set(null);
    if (tool !== 'select') {
      this.clearSelection();
    }
  }

  selectedNode(): GraphNode | undefined {
    const id = this.selectedNodeId();
    return id ? this.nodes().find((n) => n.id === id) : undefined;
  }

  async onCanvasClick(point: { x: number; y: number }): Promise<void> {
    const revisionId = this.revisionId();
    if (!revisionId || this.tool() !== 'add') return;
    try {
      const node = await this.api.addNode(revisionId, {
        x: point.x,
        y: point.y,
        label: this.labelDraft().trim(),
        kind: 'checkpoint',
      });
      this.nodes.update((list) => [...list, node]);
      this.status.set(`Saved waypoint${node.label ? ` “${node.label}”` : ''} to server`);
      this.error.set(null);
    } catch (err) {
      this.error.set(this.message(err));
    }
  }

  async onCanvasSelection(ids: string[]): Promise<void> {
    if (ids.length) await this.onNodeClick(ids[ids.length - 1]);
    else if (!this.captureMode()) this.clearSelection();
  }

  async onNodeClick(id: string): Promise<void> {
    const revisionId = this.revisionId();
    if (!revisionId) return;
    const tool = this.tool();
    if (tool === 'select') {
      if (this.captureMode() && !this.capturePoints().some((point) => point.id === id)) return;
      this.selectedNodeId.set(id);
      this.selectedEdgeId.set(null);
      const node = this.nodes().find((n) => n.id === id);
      this.editLabel.set(node?.label ?? '');
      await this.loadPhotos(id);
      if (this.captureMode())
        try {
          localStorage.setItem(`snapway-photo-stop:${revisionId}`, id);
        } catch {
          /* Optional. */
        }
      return;
    }
    if (tool === 'connect') {
      const from = this.connectFromId();
      if (!from) {
        this.connectFromId.set(id);
        this.status.set('Select the second waypoint');
        return;
      }
      if (from === id) {
        this.connectFromId.set(null);
        return;
      }
      try {
        const edge = await this.api.addEdge(revisionId, from, id);
        this.edges.update((list) => [...list, edge]);
        this.connectFromId.set(null);
        this.status.set('Saved connection to server');
        this.error.set(null);
      } catch (err) {
        this.error.set(this.message(err));
        this.connectFromId.set(null);
      }
    }
  }

  async onEdgeClick(id: string): Promise<void> {
    const revisionId = this.revisionId();
    if (!revisionId) return;
    if (this.tool() === 'cut') {
      try {
        await this.api.removeEdge(revisionId, id);
        this.edges.update((list) => list.filter((e) => e.id !== id));
        this.status.set('Connection removed');
        this.error.set(null);
      } catch (err) {
        this.error.set(this.message(err));
      }
      return;
    }
    this.selectedEdgeId.set(id);
    this.selectedNodeId.set(null);
    this.photos.set([]);
    this.tool.set('select');
  }

  async saveLabel(): Promise<void> {
    const revisionId = this.revisionId();
    const nodeId = this.selectedNodeId();
    if (!revisionId || !nodeId) return;
    try {
      const updated = await this.api.updateNode(revisionId, nodeId, this.editLabel().trim());
      this.nodes.update((list) => list.map((n) => (n.id === nodeId ? updated : n)));
      this.status.set('Label saved');
      this.error.set(null);
    } catch (err) {
      this.error.set(this.message(err));
    }
  }

  async onPhotoPicked(event: Event): Promise<void> {
    await this.uploadPhoto(event);
  }

  /** The four views taken at each photo point, relative to the walking direction. */
  readonly directions: { key: PhotoDirection; label: string }[] = [
    { key: 'front', label: 'Front' },
    { key: 'right', label: 'Right' },
    { key: 'back', label: 'Back' },
    { key: 'left', label: 'Left' },
  ];
  photoFor(direction: PhotoDirection): NodePhoto | undefined {
    return this.photos().find((p) => p.direction === direction);
  }
  readonly otherPhotos = computed(() => this.photos().filter((p) => !p.direction));
  readonly directionCount = computed(
    () => this.directions.filter((d) => this.photos().some((p) => p.direction === d.key)).length,
  );
  /** Uploads one of the four views; it replaces this point's earlier photo for that direction. */
  async onDirectionPicked(event: Event, direction: PhotoDirection): Promise<void> {
    if (this.captureMode()) {
      const input = event.target as HTMLInputElement,
        file = input.files?.[0];
      const revisionId = this.revisionId(),
        nodeId = this.selectedNodeId();
      if (!file || !revisionId || !nodeId || this.photoUploading()) return;
      this.photoUploading.set(true);
      this.error.set(null);
      try {
        const prepared = await this.phoneQueue.prepare(file);
        const item = await this.phoneQueue.save({
          revisionId,
          nodeId,
          direction,
          blob: prepared,
          filename: prepared.name,
        });
        this.status.set('Saved on this phone. Waiting for cloud upload.');
        if (this.cloudReady() && navigator.onLine !== false) {
          await this.syncPhoneItem(item);
          this.status.set(`${direction} photo uploaded to cloud storage.`);
        }
      } catch (error) {
        this.error.set(this.message(error));
      } finally {
        this.photoUploading.set(false);
        input.value = '';
      }
      return;
    }
    await this.uploadPhoto(event, direction);
  }

  private async uploadPhoto(event: Event, direction?: PhotoDirection): Promise<void> {
    const revisionId = this.revisionId();
    const nodeId = this.selectedNodeId();
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!revisionId || !nodeId || !file || this.photosLoading() || this.photoUploading()) return;
    this.photoUploading.set(true);
    try {
      const photo = await this.api.uploadNodePhoto(
        revisionId,
        nodeId,
        file,
        direction,
        direction ? 'walking_relative' : undefined,
      );
      if (this.revisionId() !== revisionId || this.selectedNodeId() !== nodeId) return;
      this.photos.update((list) => [
        ...list.filter((p) => !direction || p.direction !== direction),
        photo,
      ]);
      this.status.set(
        direction
          ? `${direction[0].toUpperCase()}${direction.slice(1)} photo saved`
          : 'Photo attached',
      );
      this.error.set(null);
    } catch (err) {
      if (this.revisionId() === revisionId && this.selectedNodeId() === nodeId)
        this.error.set(this.message(err));
    } finally {
      this.photoUploading.set(false);
      input.value = '';
    }
  }

  async removePhoto(photoId: string): Promise<void> {
    const revisionId = this.revisionId();
    if (!revisionId) return;
    try {
      await this.api.deleteNodePhoto(revisionId, photoId);
      this.photos.update((list) => list.filter((p) => p.id !== photoId));
      this.status.set('Photo removed');
      this.error.set(null);
    } catch (err) {
      this.error.set(this.message(err));
    }
  }

  async removeSelected(): Promise<void> {
    const revisionId = this.revisionId();
    if (!revisionId) return;
    const nodeId = this.selectedNodeId();
    const edgeId = this.selectedEdgeId();
    try {
      if (nodeId) {
        await this.api.removeNode(revisionId, nodeId);
        this.nodes.update((list) => list.filter((n) => n.id !== nodeId));
        this.edges.update((list) =>
          list.filter((e) => e.from_node_id !== nodeId && e.to_node_id !== nodeId),
        );
        this.clearSelection();
        this.status.set('Waypoint removed');
      } else if (edgeId) {
        await this.api.removeEdge(revisionId, edgeId);
        this.edges.update((list) => list.filter((e) => e.id !== edgeId));
        this.selectedEdgeId.set(null);
        this.status.set('Connection removed');
      }
      this.error.set(null);
    } catch (err) {
      this.error.set(this.message(err));
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (this.captureMode() || this.liveCameraOpen()) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const tag = (event.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      event.preventDefault();
      void this.removeSelected();
    }
  }

  async onUnderlayPicked(event: Event): Promise<void> {
    const revisionId = this.revisionId();
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!revisionId || !file) return;
    try {
      const result = await this.api.uploadUnderlay(revisionId, file);
      this.underlayUrl.set(result.underlay_url);
      this.applyFrame(result.coordinate_frame);
      this.status.set('Underlay updated');
      this.error.set(null);
    } catch (err) {
      this.error.set(this.message(err));
    } finally {
      input.value = '';
    }
  }

  private async loadPhotos(nodeId: string): Promise<void> {
    const revisionId = this.revisionId();
    if (!revisionId) return;
    const version = ++this.photoLoadVersion;
    const current = () =>
      version === this.photoLoadVersion &&
      this.revisionId() === revisionId &&
      this.selectedNodeId() === nodeId;
    this.photos.set([]);
    this.photosLoading.set(true);
    try {
      const result = await this.api.listNodePhotos(revisionId, nodeId);
      if (current()) {
        this.photos.set(result.photos);
        const directions = [
          ...new Set(
            result.photos
              .map((photo) => photo.direction)
              .filter((direction): direction is PhotoDirection => !!direction),
          ),
        ];
        this.nodes.update((nodes) =>
          nodes.map((node) =>
            node.id === nodeId ? { ...node, photo_directions: directions } : node,
          ),
        );
      }
    } catch (err) {
      if (current()) {
        this.photos.set([]);
        this.error.set(this.message(err));
      }
    } finally {
      if (current()) this.photosLoading.set(false);
    }
  }

  private clearSelection(): void {
    ++this.photoLoadVersion;
    this.photosLoading.set(false);
    this.selectedNodeId.set(null);
    this.selectedEdgeId.set(null);
    this.photos.set([]);
    this.editLabel.set('');
  }

  private async refresh(): Promise<void> {
    const revisionId = this.revisionId();
    if (!revisionId) return;
    const graph = await this.api.getGraph(revisionId);
    this.nodes.set(graph.nodes);
    this.cloudReady.set(graph.photo_uploads_available !== false);
    this.edges.set(graph.edges);
    this.underlayUrl.set(graph.underlay_url);
    this.applyFrame(graph.coordinate_frame);
  }

  private applyFrame(frame: { width?: number; height?: number } | null | undefined): void {
    this.width.set(Number(frame?.width) || 1000);
    this.height.set(Number(frame?.height) || 640);
  }

  private message(err: unknown): string {
    const detail = (err as { error?: { detail?: string } })?.error?.detail;
    if (typeof detail === 'string') return detail;
    if (err instanceof Error) return err.message;
    return 'Request failed';
  }
}
