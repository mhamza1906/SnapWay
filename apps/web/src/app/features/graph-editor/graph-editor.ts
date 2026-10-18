import {
  Component,
  HostListener,
  OnInit,
  OnDestroy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import {
  GraphApiService,
  GraphEdge,
  GraphNode,
  GraphPayload,
  NodePhoto,
  PhotoDirection,
  EditorCommand,
} from '../../core/graph-api.service';
import { GraphCanvas, GraphTool, NodeMove, boundedMove } from './graph-canvas';
import { WorkspaceApi, workspaceError } from '../../core/workspace-api.service';
import { AuthService } from '../../core/auth.service';
import { WorkspaceLayout } from '../../core/workspace-layout.service';
import { Icon } from '../../shared/icon';
type HistoryEntry = { undo: EditorCommand; redo: EditorCommand };
export type MapView = '2d' | '3d';

/** Prebuilt 3D photo maps (public/map3d), keyed by target id. Only Sam Ibrahim Level 1 has one. */
export const MAP3D_SCENES: Record<string, string> = {
  'fda54111-8056-4133-8894-b4fc5cdb1028': '/map3d/sam-ibrahim-level1/3d/index.html',
};

@Component({
  selector: 'app-graph-editor',
  imports: [GraphCanvas, Icon],
  templateUrl: './graph-editor.html',
  styleUrls: ['./graph-editor.scss', './editor-inspector.scss', './editor-ai.scss'],
})
export class GraphEditorPage implements OnInit, OnDestroy {
  readonly api = inject(GraphApiService);
  readonly auth = inject(AuthService);
  readonly layout = inject(WorkspaceLayout);
  private readonly workspace = inject(WorkspaceApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  readonly canvas = viewChild(GraphCanvas);
  readonly viewMode = signal<MapView>('2d');
  readonly map3dPath = computed(() => MAP3D_SCENES[this.targetId() ?? ''] ?? null);
  readonly map3dSrc = signal<SafeResourceUrl | null>(null);
  readonly tool = signal<GraphTool>('select');
  readonly status = signal('Loading draft...');
  readonly error = signal<string | null>(null);
  readonly revisionId = signal<string | null>(null);
  readonly targetId = signal<string | null>(null);
  readonly contributionId = signal<string | null>(null);
  readonly submitting = signal(false);
  readonly canPublish = signal(false);
  readonly title = signal('Edit your snapshot');
  readonly underlayUrl = signal<string | null>(null);
  readonly width = signal(1000);
  readonly height = signal(640);
  readonly nodes = signal<GraphNode[]>([]);
  readonly edges = signal<GraphEdge[]>([]);
  readonly version = signal(0);
  readonly selectedIds = signal<string[]>([]);
  readonly selectedEdgeId = signal<string | null>(null);
  readonly selectedNodeId = computed(() =>
    this.selectedIds().length === 1 ? this.selectedIds()[0] : null,
  );
  readonly selectedNode = computed(() => this.nodes().find((n) => n.id === this.selectedNodeId()));
  readonly selectedEdge = computed(() => this.edges().find((e) => e.id === this.selectedEdgeId()));
  readonly edgeWeight = signal(0);
  readonly connectFromId = signal<string | null>(null);
  readonly labelDraft = signal('');
  readonly editLabel = signal('');
  readonly nodeKind = signal('checkpoint');
  readonly editX = signal(0);
  readonly editY = signal(0);
  readonly bothDirections = signal(true);
  readonly photos = signal<NodePhoto[]>([]);
  readonly photosLoading = signal(false);
  readonly uploading = signal<string[]>([]);
  readonly authenticated = signal(false);
  readonly working = signal(false);
  readonly labels = signal(true);
  readonly spacePan = signal(false);
  /** Background server sync; does not freeze the canvas the way `working` does. */
  readonly syncing = signal(false);
  private syncChain: Promise<void> = Promise.resolve();
  readonly busy = computed(
    () => this.working() || this.submitting() || this.uploading().length > 0 || this.syncing(),
  );
  readonly undoStack = signal<HistoryEntry[]>([]);
  readonly redoStack = signal<HistoryEntry[]>([]);
  readonly directions: { key: PhotoDirection; label: string; angle: number }[] = [
    { key: 'front', label: 'Front', angle: 0 },
    { key: 'right', label: 'Right', angle: 90 },
    { key: 'back', label: 'Back', angle: 180 },
    { key: 'left', label: 'Left', angle: 270 },
  ];
  readonly kinds = ['checkpoint', 'junction', 'door', 'entrance', 'stairs', 'lift'];
  readonly tools: { key: GraphTool; name: string; icon: string; shortcut: string }[] = [
    { key: 'select', name: 'Select / drag / box select', icon: 'cursor', shortcut: 'V' },
    { key: 'add', name: 'Add waypoint', icon: 'pin', shortcut: 'N' },
    { key: 'connect', name: 'Connect two waypoints', icon: 'connect', shortcut: 'C' },
    { key: 'cut', name: 'Remove connection', icon: 'edit', shortcut: 'X' },
    { key: 'pan', name: 'Pan canvas', icon: 'hand', shortcut: 'H / Space' },
  ];
  readonly prompt = signal('');
  readonly messages = signal<{ text: string; context: string }[]>([]);
  ngOnDestroy() {
    this.layout.aiOpen.set(false);
  }
  async ngOnInit() {
    try {
      const me = await this.api.me();
      this.authenticated.set(!!me?.authenticated);
      if (!me?.authenticated) {
        this.error.set('Sign in with Google to edit this snapshot.');
        return;
      }
      const target = this.route.snapshot.queryParamMap.get('target');
      if (!target) {
        await this.router.navigateByUrl('/my-maps');
        return;
      }
      const draft = await this.workspace.edit(target);
      const stage = String(
        ((draft as { geometry?: { authoring?: { stage?: string } } }).geometry?.authoring
          ?.stage as string) ||
          (draft as { authoring_stage?: string }).authoring_stage ||
          '',
      );
      if (stage === 'image_optimize' || stage === 'vectorized_demo') {
        await this.router.navigate(['/map-optimize'], { queryParams: { target } });
        return;
      }
      this.contributionId.set(draft.contribution_id);
      this.canPublish.set(draft.can_admin);
      this.revisionId.set(draft.revision_id);
      this.targetId.set(draft.target_id);
      this.title.set(draft.building ? `${draft.building} - ${draft.floor}` : 'Edit your snapshot');
      await this.refresh();
      if (this.route.snapshot.queryParamMap.get('view') === '3d') this.setView('3d');
      this.status.set('Auto-saves to server - Editing your private snapshot');
    } catch (e) {
      this.error.set(workspaceError(e));
      this.status.set('Could not open draft');
    }
  }
  async back() {
    if (!this.busy()) await this.router.navigateByUrl('/my-maps');
  }
  /** Switch between the editable 2D canvas and the prebuilt 3D photo map. */
  setView(mode: MapView) {
    const path = this.map3dPath();
    if (mode === '3d' && !path) return;
    if (mode === '3d' && path) {
      this.canvas()?.cancel();
      this.connectFromId.set(null);
      // Open the 3D map at the selected photo point, e.g. "Point 13" -> #point-13.
      const point = /^point\s*(\d+)$/i.exec(this.selectedNode()?.label.trim() ?? '');
      this.map3dSrc.set(
        this.sanitizer.bypassSecurityTrustResourceUrl(point ? `${path}#point-${point[1]}` : path),
      );
    }
    this.viewMode.set(mode);
    this.router
      .navigate([], {
        relativeTo: this.route,
        queryParams: { view: mode === '3d' ? '3d' : null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      })
      .catch(() => undefined);
  }
  /** The 3D map reports the photo point it opened; select it so the inspector shows its photos. */
  @HostListener('window:message', ['$event']) onMap3dMessage(event: MessageEvent) {
    if (event.origin !== window.location.origin || this.viewMode() !== '3d') return;
    const data = event.data as { type?: string; nodeId?: string; label?: string } | null;
    if (data?.type !== 'snapway-map3d-stop') return;
    const node =
      this.nodes().find((n) => n.id === data.nodeId) ??
      (data.label ? this.nodes().find((n) => n.label === data.label) : undefined);
    if (node) this.select([node.id]);
  }
  setTool(tool: GraphTool) {
    this.canvas()?.cancel();
    this.tool.set(tool);
    this.connectFromId.set(null);
  }
  select(ids: string[]) {
    if (
      !this.selectedEdgeId() &&
      ids.length === this.selectedIds().length &&
      ids.every((id) => this.selectedIds().includes(id))
    )
      return;
    this.selectedIds.set(ids);
    this.selectedEdgeId.set(null);
    this.photos.set([]);
    const node = this.selectedNode();
    this.editLabel.set(node?.label ?? '');
    this.nodeKind.set(node?.kind ?? 'checkpoint');
    this.editX.set(node?.x ?? 0);
    this.editY.set(node?.y ?? 0);
    if (node) void this.loadPhotos(node.id);
  }
  selectAll() {
    this.setTool('select');
    this.select(this.nodes().map((n) => n.id));
  }
  private apply(graph: GraphPayload) {
    this.nodes.set(graph.nodes);
    this.edges.set(graph.edges);
    this.version.set(graph.lock_version ?? 0);
    // Keep a stable underlay URL so the browser does not reload the large SVG on every edit.
    if (graph.underlay_url && graph.underlay_url !== this.underlayUrl()) {
      this.underlayUrl.set(graph.underlay_url);
    } else if (!graph.underlay_url) {
      this.underlayUrl.set(null);
    }
    this.width.set(Number(graph.coordinate_frame?.width) || 1000);
    this.height.set(Number(graph.coordinate_frame?.height) || 640);
    const n = this.selectedNode();
    if (n) {
      this.editX.set(n.x);
      this.editY.set(n.y);
    }
  }
  async refresh() {
    if (this.revisionId()) this.apply(await this.api.getGraph(this.revisionId()!));
  }
  private pushHistory(entry: HistoryEntry) {
    this.undoStack.update((rows) => [...rows.slice(-49), entry]);
    this.redoStack.set([]);
  }
  private newId(): string {
    return crypto.randomUUID();
  }
  /** Instant local graph mutation; server catch-up is queued separately. */
  private applyOptimistic(body: EditorCommand): {
    payload: EditorCommand;
    optimisticEdgeIds: string[];
  } {
    const payload: EditorCommand = { ...body };
    let optimisticEdgeIds: string[] = [];
    if (body.create_nodes?.length) {
      const created = body.create_nodes.map((row) => ({
        id: row.id || this.newId(),
        x: row.x,
        y: row.y,
        label: row.label || '',
        kind: row.kind || 'checkpoint',
      }));
      payload.create_nodes = created;
      this.nodes.update((rows) => [...rows, ...created]);
    }
    if (body.nodes?.length) {
      this.nodes.update((rows) =>
        rows.map((n) => {
          const patch = body.nodes!.find((p) => p.id === n.id);
          return patch ? { ...n, ...patch } : n;
        }),
      );
    }
    if (body.edges?.length) {
      this.edges.update((rows) =>
        rows.map((e) => {
          const patch = body.edges!.find((p) => p.id === e.id);
          return patch ? { ...e, cost: patch.cost } : e;
        }),
      );
    }
    if (body.delete_edges?.length) {
      const drop = new Set(body.delete_edges);
      this.edges.update((rows) => rows.filter((e) => !drop.has(e.id)));
    }
    if (body.delete_nodes?.length) {
      const drop = new Set(body.delete_nodes);
      this.nodes.update((rows) => rows.filter((n) => !drop.has(n.id)));
      this.edges.update((rows) =>
        rows.filter((e) => !drop.has(e.from_node_id) && !drop.has(e.to_node_id)),
      );
    }
    if (body.connect?.length) {
      const added: GraphEdge[] = [];
      for (const link of body.connect) {
        added.push({
          id: this.newId(),
          from_node_id: link.from,
          to_node_id: link.to,
          cost: 1,
        });
        if (link.both) {
          added.push({
            id: this.newId(),
            from_node_id: link.to,
            to_node_id: link.from,
            cost: 1,
          });
        }
      }
      this.edges.update((rows) => [...rows, ...added]);
      optimisticEdgeIds = added.map((e) => e.id);
    }
    return { payload, optimisticEdgeIds };
  }
  /**
   * Apply locally first, then serialize server PATCHes so lock_version stays ordered.
   * Canvas stays interactive; only submit/upload still use the hard `working` gate.
   */
  private command(
    body: EditorCommand,
    message: string,
    history?: HistoryEntry | null,
  ): Promise<boolean> {
    if (!this.revisionId() || this.submitting() || this.working()) return Promise.resolve(false);
    this.error.set(null);
    const { payload, optimisticEdgeIds } = this.applyOptimistic(body);
    if (history) {
      const entry = { ...history };
      if (payload.create_nodes?.length) {
        entry.undo = { delete_nodes: payload.create_nodes.map((n) => n.id!).filter(Boolean) };
        entry.redo = { create_nodes: payload.create_nodes };
      }
      if (optimisticEdgeIds.length) {
        entry.undo = { delete_edges: optimisticEdgeIds };
      }
      this.pushHistory(entry);
    }
    this.status.set(message);
    const revision = this.revisionId()!;
    const run = this.syncChain.then(async () => {
      this.syncing.set(true);
      try {
        this.apply(await this.api.editGraph(revision, this.version(), payload));
        if (payload.connect?.length) {
          this.reconcileConnectHistory(payload.connect);
        }
        this.status.set(message);
      } catch (e) {
        this.error.set(workspaceError(e));
        await this.refresh().catch(() => undefined);
        this.resetHistory();
        throw e;
      } finally {
        this.syncing.set(false);
      }
    });
    this.syncChain = run.catch(() => undefined);
    return run.then(
      () => true,
      () => false,
    );
  }
  private reconcileConnectHistory(connect: NonNullable<EditorCommand['connect']>) {
    const pairs = connect.flatMap((link) => {
      const ids = this.edges()
        .filter(
          (e) =>
            (e.from_node_id === link.from && e.to_node_id === link.to) ||
            (link.both && e.from_node_id === link.to && e.to_node_id === link.from),
        )
        .map((e) => e.id);
      return ids;
    });
    if (!pairs.length) return;
    this.undoStack.update((rows) => {
      const last = rows.at(-1);
      if (!last?.redo.connect) return rows;
      return [...rows.slice(0, -1), { undo: { delete_edges: pairs }, redo: last.redo }];
    });
  }
  async onCanvasClick(point: { x: number; y: number }) {
    if (this.working() || this.submitting() || !this.revisionId() || this.tool() !== 'add') return;
    const create = {
      id: this.newId(),
      ...point,
      label: this.labelDraft().trim(),
      kind: this.nodeKind(),
    };
    void this.command({ create_nodes: [create] }, 'Waypoint saved to server', {
      undo: { delete_nodes: [create.id] },
      redo: { create_nodes: [create] },
    });
    this.select([create.id]);
  }
  async onNodeClick(id: string) {
    if (this.working() || this.submitting() || this.tool() !== 'connect') return;
    const from = this.connectFromId();
    if (!from) {
      this.connectFromId.set(id);
      this.status.set('Choose the destination waypoint');
      return;
    }
    if (from === id) {
      this.connectFromId.set(null);
      return;
    }
    const both = this.bothDirections();
    const connect = [{ from, to: id, both }];
    void this.command({ connect }, both ? 'Two-way connection saved' : 'One-way connection saved', {
      undo: { delete_edges: [] },
      redo: { connect },
    });
    this.connectFromId.set(null);
  }
  async onEdgeClick(id: string) {
    if (this.working() || this.submitting()) return;
    if (this.tool() === 'cut') {
      const ids = this.connectionIds(id);
      const connect = this.edges()
        .filter((e) => ids.includes(e.id))
        .map((e) => ({ from: e.from_node_id, to: e.to_node_id, both: false }));
      void this.command({ delete_edges: ids }, 'Connection removed', {
        undo: { connect },
        redo: { delete_edges: ids },
      });
      return;
    }
    this.selectedIds.set([]);
    this.selectedEdgeId.set(id);
    this.photos.set([]);
    this.tool.set('select');
    this.edgeWeight.set(this.selectedEdge()?.cost ?? 0);
  }
  async moveNodes(after: NodeMove[]) {
    if (this.working() || this.submitting()) return;
    const before = this.nodes()
      .filter((n) => after.some((p) => p.id === n.id))
      .map((n) => ({ id: n.id, x: n.x, y: n.y }));
    if (
      after.every((n) => {
        const old = before.find((p) => p.id === n.id);
        return old?.x === n.x && old?.y === n.y;
      })
    )
      return;
    void this.command({ nodes: after }, `Saved positions of ${after.length} waypoint(s)`, {
      undo: { nodes: before },
      redo: { nodes: after },
    });
  }
  private connectionIds(id: string): string[] {
    const edge = this.edges().find((e) => e.id === id);
    const reverse =
      edge &&
      this.bothDirections() &&
      this.edges().find(
        (e) => e.from_node_id === edge.to_node_id && e.to_node_id === edge.from_node_id,
      );
    return reverse ? [id, reverse.id] : [id];
  }
  async history(redo = false) {
    const from = redo ? this.redoStack : this.undoStack,
      to = redo ? this.undoStack : this.redoStack;
    const item = from().at(-1);
    if (!item) return;
    if (
      await this.command(
        redo ? item.redo : item.undo,
        redo ? 'Redo saved to server' : 'Undo saved to server',
        null,
      )
    ) {
      from.update((rows) => rows.slice(0, -1));
      to.update((rows) => [...rows, item]);
    }
  }
  private resetHistory() {
    this.undoStack.set([]);
    this.redoStack.set([]);
  }
  async saveNode() {
    const id = this.selectedNodeId();
    const prior = this.selectedNode();
    if (!id || !prior) return;
    const next = {
      id,
      x: this.editX(),
      y: this.editY(),
      label: this.editLabel().trim(),
      kind: this.nodeKind(),
    };
    await this.command({ nodes: [next] }, 'Waypoint properties saved', {
      undo: {
        nodes: [{ id, x: prior.x, y: prior.y, label: prior.label, kind: prior.kind }],
      },
      redo: { nodes: [next] },
    });
  }
  async saveWeight() {
    const edge = this.selectedEdge();
    if (!edge) return;
    const rows = [{ id: edge.id, cost: this.edgeWeight() }];
    const prior = [{ id: edge.id, cost: edge.cost }];
    if (this.bothDirections()) {
      const reverse = this.edges().find(
        (e) => e.from_node_id === edge.to_node_id && e.to_node_id === edge.from_node_id,
      );
      if (reverse) {
        rows.push({ id: reverse.id, cost: this.edgeWeight() });
        prior.push({ id: reverse.id, cost: reverse.cost });
      }
    }
    await this.command({ edges: rows }, 'Connection weight saved', {
      undo: { edges: prior },
      redo: { edges: rows },
    });
  }
  async removeSelected() {
    if (!this.selectedIds().length && !this.selectedEdgeId()) return;
    const nodeIds = this.selectedIds();
    const edgeIds = this.selectedEdgeId() ? this.connectionIds(this.selectedEdgeId()!) : [];
    const incident = this.edges().filter(
      (e) =>
        edgeIds.includes(e.id) ||
        nodeIds.includes(e.from_node_id) ||
        nodeIds.includes(e.to_node_id),
    );
    const snapshotNodes = this.nodes()
      .filter((n) => nodeIds.includes(n.id))
      .map((n) => ({ id: n.id, x: n.x, y: n.y, label: n.label, kind: n.kind }));
    const snapshotConnect = incident.map((e) => ({
      from: e.from_node_id,
      to: e.to_node_id,
      both: false,
    }));
    if (
      await this.command(
        { delete_nodes: nodeIds, delete_edges: edgeIds },
        'Selection removed, including incident connections and attached photo references',
        {
          undo: { create_nodes: snapshotNodes, connect: snapshotConnect },
          redo: { delete_nodes: nodeIds, delete_edges: edgeIds },
        },
      )
    )
      this.select([]);
  }
  photo(direction: PhotoDirection) {
    return this.photos().find((p) => p.direction === direction);
  }
  async loadPhotos(nodeId: string) {
    if (!this.revisionId()) return;
    this.photosLoading.set(true);
    try {
      const result = await this.api.listNodePhotos(this.revisionId()!, nodeId);
      if (this.selectedNodeId() === nodeId) this.photos.set(result.photos);
    } catch (e) {
      if (this.selectedNodeId() === nodeId) this.error.set(workspaceError(e));
    } finally {
      if (this.selectedNodeId() === nodeId) this.photosLoading.set(false);
    }
  }
  async onPhotoPicked(event: Event, direction: PhotoDirection) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0],
      nodeId = this.selectedNodeId(),
      rev = this.revisionId();
    if (!file || !nodeId || !rev) return;
    if (file.size > 5 * 1024 * 1024) {
      this.error.set('Each photo must be at most 5 MiB.');
      input.value = '';
      return;
    }
    const key = nodeId + direction;
    if (this.uploading().includes(key)) return;
    this.uploading.update((rows) => [...rows, key]);
    this.error.set(null);
    try {
      await this.api.uploadNodePhoto(rev, nodeId, file, direction);
      // Photo writes bump the draft lock; refresh graph version without forcing a new underlay fetch.
      await this.refresh();
      if (this.selectedNodeId() === nodeId) await this.loadPhotos(nodeId);
      this.status.set(`${direction} photo stored - Embedding is not connected yet`);
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.uploading.update((rows) => rows.filter((k) => k !== key));
      input.value = '';
    }
  }
  async removePhoto(id: string) {
    if (this.busy() || !this.revisionId()) return;
    this.working.set(true);
    try {
      await this.api.deleteNodePhoto(this.revisionId()!, id);
      this.photos.update((rows) => rows.filter((p) => p.id !== id));
      await this.refresh();
      this.status.set('Photo reference removed');
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.working.set(false);
    }
  }
  async onUnderlayPicked(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file || this.busy() || !this.revisionId()) return;
    this.working.set(true);
    try {
      await this.api.uploadUnderlay(this.revisionId()!, file);
      await this.refresh();
      this.canvas()?.fit();
      this.resetHistory();
      this.status.set('Floor plan stored - Existing coordinates remain unchanged');
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.working.set(false);
      input.value = '';
    }
  }
  async rebuildIndex() {
    if (this.busy() || !this.revisionId()) return;
    this.working.set(true);
    this.error.set(null);
    try {
      const result = await this.api.rebuildIndex(this.revisionId()!);
      const state = result.state ?? 'unknown';
      const skipped = result.skipped ? ' (unchanged)' : '';
      this.status.set(`MegaLoc index ${state}${skipped}`);
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.working.set(false);
    }
  }
  async finishEditing() {
    if (!this.contributionId() || this.busy()) return;
    this.submitting.set(true);
    this.error.set(null);
    try {
      await this.workspace.submit(this.contributionId()!);
      await this.router.navigateByUrl('/my-maps');
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.submitting.set(false);
    }
  }
  sendPrompt() {
    const text = this.prompt().trim();
    if (!text) return;
    this.messages.update((rows) => [
      ...rows,
      { text, context: `${this.selectedIds().length} selected - snapshot ${this.revisionId()}` },
    ]);
    this.prompt.set('');
  }
  @HostListener('window:keydown', ['$event']) onKey(event: KeyboardEvent) {
    // Detached keep-alive instances must not steal shortcuts on other routes.
    if (!this.router.url.split('?')[0].endsWith('/graph-editor')) return;
    // The 3D map is view-only; its own keys (arrows, Esc) must not edit the graph.
    if (this.viewMode() === '3d') return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === 'Escape') {
      this.canvas()?.cancel();
      this.connectFromId.set(null);
      this.select([]);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selectAll();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      void this.history(event.shiftKey || event.key.toLowerCase() === 'y');
      return;
    }
    if (event.key === ' ' && !target.closest('button, a')) {
      event.preventDefault();
      this.spacePan.set(true);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      void this.removeSelected();
      return;
    }
    const direction: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (
      direction[event.key] &&
      this.selectedIds().length &&
      !this.working() &&
      !this.submitting()
    ) {
      event.preventDefault();
      const [dx, dy] = direction[event.key],
        step = event.shiftKey ? 10 : 1;
      void this.moveNodes(
        boundedMove(
          this.nodes().filter((n) => this.selectedIds().includes(n.id)),
          dx * step,
          dy * step,
          this.width(),
          this.height(),
        ),
      );
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const tools: Record<string, GraphTool> = {
      v: 'select',
      n: 'add',
      c: 'connect',
      x: 'cut',
      h: 'pan',
    };
    if (tools[event.key.toLowerCase()]) this.setTool(tools[event.key.toLowerCase()]);
    if (event.key === '0') this.canvas()?.fit();
    if (event.key === '+' || event.key === '=') this.canvas()?.zoomBy(1.25);
    if (event.key === '-') this.canvas()?.zoomBy(0.8);
  }
  @HostListener('window:keyup', ['$event']) onKeyUp(event: KeyboardEvent) {
    if (event.key === ' ') this.spacePan.set(false);
  }
  @HostListener('window:blur') onBlur() {
    this.spacePan.set(false);
    this.canvas()?.cancel();
  }
}
