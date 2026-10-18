import { Component, HostListener, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { GraphApiService, GraphEdge, GraphNode, NodePhoto } from '../../core/graph-api.service';
import { GraphCanvas, GraphTool } from './graph-canvas';
import { WorkspaceApi, workspaceError } from '../../core/workspace-api.service';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-graph-editor',
  imports: [GraphCanvas, RouterLink],
  templateUrl: './graph-editor.html',
  styleUrl: './graph-editor.scss',
})
export class GraphEditorPage implements OnInit {
  readonly api = inject(GraphApiService);
  readonly auth = inject(AuthService);
  private readonly workspace = inject(WorkspaceApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly tool = signal<GraphTool>('add');
  readonly status = signal('Loading draft…');
  readonly error = signal<string | null>(null);
  readonly revisionId = signal<string | null>(null);
  readonly targetId = signal<string | null>(null);
  readonly contributionId = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly canPublish = signal(false);
  readonly underlayUrl = signal<string | null>(null);
  readonly width = signal(1000);
  readonly height = signal(640);
  readonly nodes = signal<GraphNode[]>([]);
  readonly edges = signal<GraphEdge[]>([]);
  readonly selectedNodeId = signal<string | null>(null);
  readonly selectedEdgeId = signal<string | null>(null);
  readonly edgeWeight = signal(0);
  readonly connectFromId = signal<string | null>(null);
  readonly labelDraft = signal('');
  readonly editLabel = signal('');
  readonly photos = signal<NodePhoto[]>([]);
  readonly photosLoading = signal(false);
  readonly authenticated = signal(false);

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
      const targetHint = this.route.snapshot.queryParamMap.get('target') ?? undefined;
      if (!targetHint) {
        await this.router.navigateByUrl('/my-maps');
        return;
      }
      const draft = await this.workspace.edit(targetHint);
      this.contributionId.set(draft.contribution_id);
      this.canPublish.set(draft.can_admin);
      this.revisionId.set(draft.revision_id);
      this.targetId.set(draft.target_id);
      this.applyFrame(draft.coordinate_frame);
      this.underlayUrl.set(draft.underlay_url);
      // Pin target in the URL so refresh resumes the same draft (edits auto-save via API).
      await this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { target: draft.target_id },
        replaceUrl: true,
      });
      await this.refresh();
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

  /** Start a brand-new empty map (does not delete the previous draft). */
  async startNewMap(): Promise<void> {
    await this.router.navigateByUrl('/authoring');
  }

  async finishEditing(): Promise<void> {
    if (!this.contributionId() || this.submitting() || this.api.pending()) return;
    this.submitting.set(true);
    this.error.set(null);
    try {
      const result = await this.workspace.submit(this.contributionId()!);
      this.status.set(
        result.status === 'merged'
          ? 'Approved and published.'
          : 'Submitted for administrator review.',
      );
      await this.router.navigateByUrl('/my-maps');
    } catch (err) {
      this.error.set(workspaceError(err));
    } finally {
      this.submitting.set(false);
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

  async onNodeClick(id: string): Promise<void> {
    const revisionId = this.revisionId();
    if (!revisionId) return;
    const tool = this.tool();
    if (tool === 'select') {
      this.selectedNodeId.set(id);
      this.selectedEdgeId.set(null);
      const node = this.nodes().find((n) => n.id === id);
      this.editLabel.set(node?.label ?? '');
      await this.loadPhotos(id);
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
    this.edgeWeight.set(this.edges().find((edge) => edge.id === id)?.cost || 0);
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

  async saveWeight(): Promise<void> {
    if (!this.revisionId() || !this.selectedEdgeId()) return;
    try {
      const edge = await this.api.updateEdge(
        this.revisionId()!,
        this.selectedEdgeId()!,
        this.edgeWeight(),
      );
      this.edges.update((rows) => rows.map((row) => (row.id === edge.id ? edge : row)));
      this.status.set('Connection weight saved');
      this.error.set(null);
    } catch (e) {
      this.error.set(this.message(e));
    }
  }

  async onPhotoPicked(event: Event): Promise<void> {
    const revisionId = this.revisionId();
    const nodeId = this.selectedNodeId();
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!revisionId || !nodeId || !file) return;
    try {
      const photo = await this.api.uploadNodePhoto(revisionId, nodeId, file);
      this.photos.update((list) => [...list, photo]);
      this.status.set('Photo attached');
      this.error.set(null);
    } catch (err) {
      this.error.set(this.message(err));
    } finally {
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
    this.photosLoading.set(true);
    try {
      const result = await this.api.listNodePhotos(revisionId, nodeId);
      this.photos.set(result.photos);
    } catch (err) {
      this.photos.set([]);
      this.error.set(this.message(err));
    } finally {
      this.photosLoading.set(false);
    }
  }

  private clearSelection(): void {
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
