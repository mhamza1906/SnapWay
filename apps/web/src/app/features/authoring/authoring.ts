import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { WorkspaceApi, workspaceError } from '../../core/workspace-api.service';
import { Icon } from '../../shared/icon';
import {
  AssumedDoor,
  BuildingSummary,
  EdgeOption,
  Edited,
  FloorSummary,
  Health,
  LibraryEntry,
  MapJob,
  PipelineBuilding,
  PipelineService,
  Point,
} from './pipeline.service';

interface DoorEdit {
  edgeKey: number;
  t: number;
  width: number;
}

// Map authoring: upload a floor plan, let the AI pipeline map rooms and doorways,
// then fix doorways by hand. Nothing here is saved until "Save a copy" is used.
@Component({
  selector: 'app-authoring',
  imports: [Icon],
  templateUrl: './authoring.html',
  styleUrl: './authoring.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthoringPage implements OnInit {
  private readonly pipeline = inject(PipelineService);
  readonly auth = inject(AuthService);
  private readonly workspace = inject(WorkspaceApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly health = signal<Health | null>(null);
  readonly offline = signal('');
  readonly library = signal<LibraryEntry[]>([]);
  readonly building = signal<PipelineBuilding | null>(null);
  readonly summary = signal<BuildingSummary | null>(null);
  readonly floorId = signal('');
  readonly svg = signal<string | null>(null);
  readonly buildingName = signal(this.route.snapshot.queryParamMap.get('building') || '');
  readonly floorCode = signal('');
  readonly latitude = signal(this.route.snapshot.queryParamMap.get('lat') || '');
  readonly longitude = signal(this.route.snapshot.queryParamMap.get('lng') || '');
  private draftTarget?: string;
  readonly job = signal<MapJob | null>(null);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly error = signal('');
  readonly reviewer = signal('');
  readonly edits = signal<Record<string, DoorEdit>>({});
  readonly addRoom = signal('');
  readonly addEdges = signal<EdgeOption[]>([]);
  readonly addEdge = signal('');
  readonly routeFrom = signal('');
  readonly routeTo = signal('');
  readonly routeNote = signal('');
  private overlay: { segments?: { a: Point; b: Point; color?: string }[]; routes?: Point[][] } = {};

  readonly floor = computed<FloorSummary | null>(
    () => this.summary()?.floors.find((f) => f.floorId === this.floorId()) ?? null,
  );
  readonly mapped = computed(() => (this.floor()?.regions ?? 0) > 0);
  readonly jobRunning = computed(() => this.job()?.status === 'running');

  async ngOnInit(): Promise<void> {
    this.destroyRef.onDestroy(() => {
      const url = this.svg();
      if (url) URL.revokeObjectURL(url);
    });
    try {
      this.health.set(await this.pipeline.health());
      this.library.set((await this.pipeline.library()).buildings);
    } catch {
      this.offline.set(
        'AI authoring is temporarily unavailable. You can still create a floor and edit it manually.',
      );
    }
  }

  // --- loading a building ---------------------------------------------------
  async upload(event: Event, nameInput: HTMLInputElement): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await this.run(async () => {
      this.load(await this.pipeline.uploadPlan(file, nameInput.value.trim()));
      this.say(
        `${file.name} uploaded: ${this.summary()!.floors.length} floor(s). Next, build the map with AI.`,
      );
    });
  }

  async open(key: string): Promise<void> {
    if (!key) return;
    await this.run(async () => {
      const building = await this.pipeline.openBuilding(key);
      this.load({ building, summary: await this.pipeline.summary(building) });
      this.say(`${building.name} opened. Nothing is saved until you save a copy.`);
    });
  }

  private load(edited: Edited): void {
    this.building.set(edited.building);
    this.summary.set(edited.summary);
    if (!edited.summary.floors.some((f) => f.floorId === this.floorId()))
      this.floorId.set(edited.summary.floors[0]?.floorId ?? '');
    this.edits.set({});
    this.addRoom.set('');
    this.addEdges.set([]);
    this.overlay = {};
    void this.redraw();
  }

  async selectFloor(id: string): Promise<void> {
    this.floorId.set(id);
    this.overlay = {};
    this.routeFrom.set('');
    this.routeTo.set('');
    this.routeNote.set('');
    await this.redraw();
  }

  private async redraw(): Promise<void> {
    const building = this.building();
    if (!building || !this.floorId() || !this.mapped()) {
      this.svg.set(null);
      return;
    }
    const { svg } = await this.pipeline.render(building, this.floorId(), this.overlay);
    if (!this.destroyRef.destroyed) {
      const previous = this.svg();
      this.svg.set(URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })));
      if (previous) URL.revokeObjectURL(previous);
    }
  }

  // --- AI mapping ------------------------------------------------------------
  async buildWithAi(allFloors: boolean): Promise<void> {
    const building = this.building();
    if (!building) return;
    const floorIds = allFloors ? building.floors.map((f) => f.id) : [this.floorId()];
    await this.run(async () => {
      const { id } = await this.pipeline.startJob(building, floorIds);
      let state = await this.pipeline.job(id);
      this.job.set(state);
      while (state.status === 'running' && !this.destroyRef.destroyed) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        state = await this.pipeline.job(id);
        this.job.set(state);
      }
      if (state.error) throw new Error(state.error);
      const applied = await this.pipeline.applyJob(id, building);
      // Doorway fallback: re-enable supported doors, assume missing ones, join gaps.
      this.load(await this.pipeline.placeDoorways(applied.building));
      const stats = state.result?.stats;
      this.say(
        `Mapped with ${this.health()?.model ?? 'the AI provider'}: ${stats?.calls ?? '?'} calls, ` +
          `${stats?.tokens?.toLocaleString() ?? '?'} reported tokens. Review doorways below.`,
      );
    });
  }

  async cancelJob(): Promise<void> {
    const id = this.job()?.id;
    if (id) await this.pipeline.cancelJob(id);
  }

  // --- doorway tools ---------------------------------------------------------
  private async edit(
    action: (b: PipelineBuilding, floorId: string) => Promise<Edited>,
    done: string,
  ) {
    const building = this.building();
    if (!building) return;
    await this.run(async () => {
      this.load(await action(building, this.floorId()));
      this.say(done);
    });
  }

  placeAll(): Promise<void> {
    return this.edit(
      (b, f) => this.pipeline.placeDoorways(b, f),
      'Assumed doorways placed where none was found.',
    );
  }
  makeRoom(spaceId: string, label: string): Promise<void> {
    return this.edit(
      (b, f) => this.pipeline.defineRoom(b, f, spaceId, this.reviewer()),
      `${label} is now a room with an assumed doorway (if it shares an edge with a walkable space).`,
    );
  }
  notRoom(spaceId: string, label: string): Promise<void> {
    return this.edit(
      (b, f) => this.pipeline.notRoom(b, f, spaceId, this.reviewer()),
      `${label} marked as not a room; it is never routed through.`,
    );
  }

  editOf(door: AssumedDoor): DoorEdit {
    return (
      this.edits()[door.doorId] ?? {
        edgeKey: door.edgeKey ?? 0,
        t: door.t,
        width: Math.round(door.width),
      }
    );
  }
  async setEdit(door: AssumedDoor, patch: Partial<DoorEdit>): Promise<void> {
    const next = { ...this.editOf(door), ...patch };
    this.edits.update((all) => ({ ...all, [door.doorId]: next }));
    const edge = door.candidates.find((c) => c.key === next.edgeKey);
    const preview = edge ? this.previewSegment(edge, next) : door.segment;
    this.overlay = { segments: [{ ...preview, color: '#c2185b' }] };
    await this.redraw();
  }
  /** Mirrors the service's placement: centred at t along the shared edge, kept inside it. */
  private previewSegment(edge: EdgeOption, edit: DoorEdit): { a: Point; b: Point } {
    const len = Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y) || 1,
      w = Math.min(edit.width, len),
      centre = Math.min(len - w / 2, Math.max(w / 2, edit.t * len)),
      at = (d: number) => ({
        x: edge.a.x + ((edge.b.x - edge.a.x) * d) / len,
        y: edge.a.y + ((edge.b.y - edge.a.y) * d) / len,
      });
    return { a: at(centre - w / 2), b: at(centre + w / 2) };
  }
  applyMove(door: AssumedDoor, confirm = false): Promise<void> {
    const e = this.editOf(door);
    return this.edit(
      (b, f) =>
        this.pipeline.editDoor(b, f, {
          doorId: door.doorId,
          edgeKey: e.edgeKey,
          t: e.t,
          width: e.width,
          confirm,
          reviewer: this.reviewer(),
        }),
      confirm
        ? `Doorway for ${door.roomLabel} confirmed by ${this.reviewer()}.`
        : `Doorway for ${door.roomLabel} moved; paths rebuilt.`,
    );
  }
  removeDoor(door: AssumedDoor): Promise<void> {
    return this.edit(
      (b, f) => this.pipeline.removeDoor(b, f, door.doorId, this.reviewer()),
      `Assumed doorway removed from ${door.roomLabel}.`,
    );
  }
  async chooseAddRoom(spaceId: string): Promise<void> {
    this.addRoom.set(spaceId);
    this.addEdge.set('');
    const building = this.building();
    this.addEdges.set(
      spaceId && building
        ? (await this.pipeline.edges(building, this.floorId(), spaceId)).edges
        : [],
    );
  }
  addDoor(spaceId = this.addRoom()): Promise<void> {
    const edge =
      spaceId === this.addRoom() && this.addEdge() !== '' ? Number(this.addEdge()) : null;
    return this.edit(
      (b, f) => this.pipeline.addDoor(b, f, spaceId, edge, this.reviewer()),
      'Doorway added. Move it to the real opening under Assumed doorways; routes use the closest doorway.',
    );
  }

  // --- routes, saving --------------------------------------------------------
  async previewRoute(): Promise<void> {
    const building = this.building();
    if (!building || !this.routeFrom() || !this.routeTo()) return;
    await this.run(async () => {
      const { route, message } = await this.pipeline.route(
        building,
        this.routeFrom(),
        this.routeTo(),
      );
      const here = route?.floors.find((f) => f.floorId === this.floorId());
      this.overlay = { routes: here?.segments ?? [] };
      this.routeNote.set(route ? `Route found: ${route.steps} steps.` : (message ?? 'No route.'));
      await this.redraw();
    });
  }

  async saveCopy(): Promise<void> {
    const building = this.building();
    if (!building) return;
    await this.run(async () => {
      const target = await this.ensureTarget();
      const draft = await this.workspace.edit(target);
      const rendered = await this.pipeline.render(building, this.floorId());
      // Transfer only the selected floor; embedded source images already live in
      // the rendered SVG and must not be duplicated in the JSON request.
      const floor = building.floors.find((f) => f.id === this.floorId()) as Record<string, unknown>;
      const geometry = floor['geometry'] as Record<string, unknown>;
      const cleanGeometry = Object.fromEntries(
        ['spaces', 'walls', 'doors', 'pois', 'scale', 'review', 'extraction'].map((key) => [
          key,
          geometry?.[key],
        ]),
      );
      const nodes = ((building['nodes'] || []) as { id: string; floorId: string }[]).filter(
        (n) => n.floorId === this.floorId(),
      );
      const ids = new Set(nodes.map((n) => n.id));
      const edges = ((building['edges'] || []) as { from: string; to: string }[]).filter(
        (e) => ids.has(e.from) && ids.has(e.to),
      );
      await this.workspace.importPipeline(draft.contribution_id!, {
        building: {
          floors: [
            {
              id: this.floorId(),
              width: floor['width'],
              height: floor['height'],
              geometry: cleanGeometry,
            },
          ],
          nodes,
          edges,
        },
        floor_id: this.floorId(),
        svg: rendered.svg,
      });
      await this.router.navigate(['/graph-editor'], { queryParams: { target } });
    });
  }

  private async ensureTarget(): Promise<string> {
    if (this.draftTarget) return this.draftTarget;
    if (!this.buildingName().trim() || !this.floorCode().trim())
      throw new Error('Enter a building name and floor code first.');
    const params = this.route.snapshot.queryParamMap;
    const result = await this.workspace.create({
      building_name: this.buildingName().trim(),
      floor_code: this.floorCode().trim(),
      floor_name: `Floor ${this.floorCode().trim()}`,
      building_id: params.get('buildingId') || undefined,
      place_id: params.get('placeId') || undefined,
      address: params.get('address') || '',
      ...(this.latitude().trim() && this.longitude().trim()
        ? {
            latitude: Number(Number(this.latitude()).toFixed(6)),
            longitude: Number(Number(this.longitude()).toFixed(6)),
          }
        : {}),
    });
    return (this.draftTarget = result.target_id);
  }
  async createManual(): Promise<void> {
    await this.run(async () => {
      const target = await this.ensureTarget();
      await this.router.navigate(['/graph-editor'], { queryParams: { target } });
    });
  }

  private say(text: string): void {
    this.message.set(text);
    this.error.set('');
  }
  private async run(task: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await task();
    } catch (e) {
      const err = e as { error?: { error?: string; detail?: string }; message?: string };
      this.error.set(
        err.error?.detail ??
          err.error?.error ??
          (err.error ? workspaceError(e) : err.message) ??
          'Request failed.',
      );
    } finally {
      this.busy.set(false);
    }
  }
  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }
  num(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }
}
