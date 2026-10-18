import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Icon } from '../../shared/icon';
import { AuthoringSession } from './authoring-session';
import {
  AssumedDoor,
  BuildingSummary,
  CleanFloor,
  CleanJob,
  EdgeOption,
  Edited,
  FloorSummary,
  Health,
  LibraryEntry,
  MapJob,
  DoorwayInfo,
  MergeRecord,
  PipelineBuilding,
  PipelineService,
  PlanType,
  Point,
  RenderOverlay,
  SpaceRole,
  SpaceSummary,
  HallPlan,
} from './pipeline.service';

interface DoorEdit {
  edgeKey: number;
  t: number;
  width: number;
}

/** Longest region name the pipeline accepts. */
export const REGION_NAME_MAX = 120;
/** Names the pipeline gives regions it could not name; flagged for the map author. */
const DEFAULT_NAME = /^(unlabelled|hallway|open lobby)/i;
/** Colour of a doorway drawn over the map (a located door or an edit preview). */
export const DOOR_COLOR = '#c2185b';
/** "Use as" roles, in menu order; `done` completes "<name> is now …" after a change. */
export const ROLE_CHOICES: readonly { value: SpaceRole; label: string; done: string }[] = [
  { value: 'room', label: 'Room', done: 'a room' },
  {
    value: 'hall-room',
    label: 'Hall room',
    done: 'a hall room: still a destination, and routes may pass through it',
  },
  {
    value: 'corridor',
    label: 'Hallway',
    done: 'a hallway; routes and doorway placement treat it as circulation',
  },
  {
    value: 'lobby',
    label: 'Lobby or hall',
    done: 'a lobby or hall; routes and doorway placement treat it as circulation',
  },
  { value: 'stair', label: 'Stair', done: 'a stair' },
  {
    value: 'closed',
    label: 'Closed (no access)',
    done: 'closed: it stays on the map but routes never use it',
  },
];
/** Badges for roles beyond the region's kind. */
const ROLE_BADGES: Partial<Record<SpaceRole, string>> = {
  'hall-room': 'Hall room',
  stair: 'Stair',
  closed: 'Closed',
};

/** The region the map is zoomed to ("Show on map"). */
interface Focus {
  floorId: string;
  spaceId: string;
  label: string;
  /** An assumed doorway is drawn over the region. */
  door: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Matches the service's focus framing (apps/pipeline/server/authoring-routes.js). */
export const FOCUS_PADDING = 0.25;
export const FOCUS_MIN_SIZE = 250;
const round2 = (v: number) => Math.round(v * 100) / 100;
/**
 * The region's box padded by 25% of its size on each side, at least 250 px wide and
 * tall (centred on the region), moved and clipped to stay inside `full`.
 */
export function focusBox(full: Box, region: Box): Box {
  const axis = (lo: number, hi: number, start: number, size: number) => {
    const span = Math.min(size, Math.max(FOCUS_MIN_SIZE, (hi - lo) * (1 + 2 * FOCUS_PADDING))),
      at = Math.max(start, Math.min(start + size - span, (lo + hi) / 2 - span / 2));
    return [round2(at), round2(span)];
  };
  const [x, w] = axis(region.x, region.x + region.w, full.x, full.w),
    [y, h] = axis(region.y, region.y + region.h, full.y, full.h);
  return { x, y, w, h };
}

/** What the browser draws over the server-rendered floor: no request needed. */
export interface MapView {
  /** Region ids drawn selected (class `is-selected` on their `[data-room-id]` group). */
  highlight: readonly string[];
  /** Region id the viewBox is cropped to; null shows the whole floor. */
  focus: string | null;
  /** A doorway segment drawn in magenta. */
  door: { a: Point; b: Point } | null;
  /** Doorways take clicks (Select: Doorways); otherwise clicks reach the rooms. */
  doorClicks?: boolean;
  /** More doorway segments drawn in magenta (several doorways selected). */
  doors?: readonly { a: Point; b: Point }[];
}
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The server's own viewBox, width and height, kept on the svg to restore "Show whole floor". */
const FULL_VIEW = 'data-full-view';

function regionBox(group: Element): Box | null {
  try {
    const b = (group as SVGGraphicsElement).getBBox?.();
    if (b && (b.width > 0 || b.height > 0)) return { x: b.x, y: b.y, w: b.width, h: b.height };
  } catch {
    // Not rendered (or no layout, as in tests): use the polygon points.
  }
  const pts = [...group.querySelectorAll('polygon, polyline')]
    .flatMap((p) => (p.getAttribute('points') ?? '').trim().split(/[\s,]+/))
    .map(Number);
  const xs = pts.filter((_, i) => i % 2 === 0),
    ys = pts.filter((_, i) => i % 2 === 1);
  if (!ys.length || ![...xs, ...ys].every(Number.isFinite)) return null;
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Applies highlight, focus and a doorway segment to the floor SVG inside `host`. */
export function applyMapView(host: HTMLElement, view: MapView): void {
  const svg = host.querySelector('svg');
  if (!svg) return;
  if (!svg.hasAttribute(FULL_VIEW))
    svg.setAttribute(
      FULL_VIEW,
      JSON.stringify(['viewBox', 'width', 'height'].map((a) => svg.getAttribute(a))),
    );
  const [viewBox, width, height] = JSON.parse(svg.getAttribute(FULL_VIEW)!) as (string | null)[];
  const wanted = new Set(view.highlight);
  let focused: Element | null = null;
  for (const g of svg.querySelectorAll('[data-room-id]')) {
    const id = g.getAttribute('data-room-id');
    g.classList.toggle('is-selected', wanted.has(id ?? ''));
    if (view.focus && id === view.focus) focused ??= g;
  }

  const full = (viewBox ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number),
    region = focused && regionBox(focused);
  const set = (name: string, value: string | null) => {
    if (value === null) svg.removeAttribute(name);
    else svg.setAttribute(name, value);
  };
  if (region && full.length === 4 && full.every(Number.isFinite)) {
    const v = focusBox({ x: full[0], y: full[1], w: full[2], h: full[3] }, region);
    svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    // Like the service, the size follows the crop so the map keeps its aspect ratio.
    if (width !== null) svg.setAttribute('width', String(Math.round(v.w)));
    if (height !== null) svg.setAttribute('height', String(Math.round(v.h)));
    svg.setAttribute('data-focus', view.focus!);
  } else {
    set('viewBox', viewBox);
    set('width', width);
    set('height', height);
    svg.removeAttribute('data-focus');
  }

  // Each doorway's wide transparent hit line takes clicks only when selecting doorways.
  for (const hit of svg.querySelectorAll('[data-door-id] > path:last-child'))
    hit.setAttribute('pointer-events', view.doorClicks ? 'stroke' : 'none');

  svg.querySelector(':scope > [data-client-overlay]')?.remove();
  const segments = [...(view.door ? [view.door] : []), ...(view.doors ?? [])];
  if (segments.length) {
    const doc = svg.ownerDocument,
      layer = doc.createElementNS(SVG_NS, 'g');
    layer.setAttribute('data-client-overlay', 'true');
    layer.setAttribute('pointer-events', 'none');
    for (const { a, b } of segments) {
      const line = doc.createElementNS(SVG_NS, 'line');
      for (const [k, v] of Object.entries({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        stroke: DOOR_COLOR,
        'stroke-width': 4,
        'stroke-linecap': 'round',
        'pointer-events': 'none',
        'data-door-segment': 'true',
      }))
        line.setAttribute(k, String(v));
      layer.appendChild(line);
    }
    svg.appendChild(layer);
  }
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
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroyRef = inject(DestroyRef);

  readonly health = signal<Health | null>(null);
  readonly offline = signal('');
  readonly library = signal<LibraryEntry[]>([]);
  /** Kept app-wide, so the open building survives leaving and returning to this page. */
  private readonly session = inject(AuthoringSession);
  readonly building = this.session.building;
  readonly summary = this.session.summary;
  readonly floorId = this.session.floorId;
  readonly svg = signal<SafeHtml | null>(null);
  readonly job = signal<MapJob | null>(null);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly error = signal('');
  readonly reviewer = this.session.reviewer;
  readonly edits = signal<Record<string, DoorEdit>>({});
  readonly addRoom = signal('');
  readonly addEdges = signal<EdgeOption[]>([]);
  readonly addEdge = signal('');
  readonly routeFrom = signal('');
  readonly routeTo = signal('');
  readonly routeNote = signal('');
  // Plan type: a floor plan is one floor; a building plan needs its floor count.
  readonly planType = signal<PlanType | ''>('');
  readonly floorCount = signal<number | null>(null);
  readonly floorNames = signal('');
  readonly cleanFirst = signal(true);
  readonly cleanJob = signal<CleanJob | null>(null);
  readonly cleanFloors = signal<CleanFloor[]>([]);
  readonly cleanRunning = computed(() => this.cleanJob()?.status === 'running');
  readonly uploadReady = computed(
    () =>
      this.planType() === 'floor' ||
      (this.planType() === 'building' && (this.floorCount() ?? 0) >= 2),
  );
  // Regions: the map author's names, roles and merges. Selected ids are highlighted on the map.
  readonly regionFilter = signal('');
  readonly selectedRegions = signal<string[]>([]);
  readonly nameDrafts = signal<Record<string, string>>({});
  readonly mergeName = signal('');
  /** null follows the merge group (a stair if any region in it is one). */
  readonly mergeStairChoice = signal<boolean | null>(null);
  /**
   * The Merge rooms menu: null while closed, else [first room, room to merge into it]. One
   * merge at a time: the second room must share a wall with the first, which keeps its id.
   */
  readonly mergeGroup = signal<string[] | null>(null);
  /** The tool panel shown beside the map: doorway tools or region tools. */
  readonly sidePanel = this.session.sidePanel;
  readonly selectMode = this.session.selectMode;
  /** The doorway clicked on the map (Select: Doorways), shown under Doorways to edit or remove. */
  readonly selectedDoor = signal<DoorwayInfo | null>(null);
  /** Doorways selected on the map in click order; a click toggles one. */
  readonly selectedDoorIds = signal<string[]>([]);
  private readonly doorInfos = signal<Record<string, DoorwayInfo>>({});
  /** The selected doorways (two or more) for the bulk card. */
  readonly selectedDoors = computed(() =>
    this.selectedDoorIds()
      .map((id) => this.doorInfos()[id])
      .filter((d): d is DoorwayInfo => !!d),
  );
  readonly nameMax = REGION_NAME_MAX;
  readonly roleChoices = ROLE_CHOICES;
  /** "Show on map": the region the map is zoomed to; null shows the whole floor. */
  readonly focused = signal<Focus | null>(null);
  /** The assumed doorway drawn over the located room (its current place or a move preview). */
  readonly doorLine = signal<{ a: Point; b: Point } | null>(null);
  /** The list row whose edit is being saved ("Saving…"). */
  readonly saving = signal<string | null>(null);
  private readonly mapView = viewChild<ElementRef<HTMLElement>>('mapView');
  /** Sent to the service on render: only server data (a route preview), never selection. */
  private overlay: RenderOverlay = {};
  private renderSeq = 0;

  /** Regions drawn selected: the Regions selection, else the located region. */
  readonly highlighted = computed<string[]>(() => {
    const group = this.mergeGroup();
    if (group) return group;
    const sel = this.selectedRegions(),
      f = this.focused();
    return sel.length ? sel : f && f.floorId === this.floorId() ? [f.spaceId] : [];
  });
  readonly view = computed<MapView>(() => {
    const f = this.focused(),
      here = f && f.floorId === this.floorId();
    return {
      highlight: this.highlighted(),
      focus: here ? f.spaceId : null,
      door: here && f.door ? this.doorLine() : this.selectedDoor() ? this.doorLine() : null,
      doorClicks: this.selectMode() === 'doorways',
      doors: this.selectedDoors().length > 1 ? this.selectedDoors().map((d) => d.segment) : [],
    };
  });

  constructor() {
    // Selection, "Show on map" and doorway previews change the inserted SVG in place, so
    // they need no request; this runs again after every render (new SVG) to re-apply them.
    afterRenderEffect(() => {
      const host = this.mapView()?.nativeElement,
        view = this.view();
      this.svg();
      if (host) applyMapView(host, view);
    });
  }

  readonly floor = computed<FloorSummary | null>(
    () => this.summary()?.floors.find((f) => f.floorId === this.floorId()) ?? null,
  );
  readonly mapped = computed(() => (this.floor()?.regions ?? 0) > 0);
  readonly regions = computed<SpaceSummary[]>(() => {
    const q = this.regionFilter().trim().toLowerCase(),
      spaces = this.floor()?.spaces ?? [];
    return q
      ? spaces.filter((s) =>
          [s.label, s.kind, this.kindBadge(s), this.roleBadge(s) ?? ''].some((t) =>
            t.toLowerCase().includes(q),
          ),
        )
      : spaces;
  });
  readonly selectedSpaces = computed<SpaceSummary[]>(() => {
    const spaces = this.floor()?.spaces ?? [];
    return this.selectedRegions()
      .map((id) => spaces.find((s) => s.id === id))
      .filter((s): s is SpaceSummary => !!s);
  });
  readonly mergeMembers = computed<SpaceSummary[]>(() => {
    const spaces = this.floor()?.spaces ?? [];
    return (this.mergeGroup() ?? [])
      .map((id) => spaces.find((s) => s.id === id))
      .filter((s): s is SpaceSummary => !!s);
  });
  /** Rooms that share a wall with the first room of the merge: the only ones it can take in. */
  /** Hallways, stairs and rooms only merge with their own type. */
  mergeType(s: SpaceSummary): 'hallway' | 'stair' | 'room' {
    return s.use === 'stair' || s.stair
      ? 'stair'
      : ['corridor', 'lobby', 'hallway'].includes(s.kind)
        ? 'hallway'
        : 'room';
  }
  /** Whether a region has a nearby region of its own type to merge with. */
  hasMergePartner(sp: SpaceSummary): boolean {
    const spaces = this.floor()?.spaces ?? [];
    return (sp.neighbours ?? []).some((id) => {
      const other = spaces.find((s) => s.id === id);
      return !!other && this.mergeType(other) === this.mergeType(sp);
    });
  }
  /** Regions of the first one's type close to any region chosen so far: the ones that can join. */
  readonly mergeCandidates = computed<SpaceSummary[]>(() => {
    const members = this.mergeMembers(),
      ids = new Set(members.map((m) => m.id)),
      close = new Set(members.flatMap((m) => m.neighbours ?? [])),
      type = members[0] && this.mergeType(members[0]);
    return (this.floor()?.spaces ?? []).filter(
      (s) => !ids.has(s.id) && close.has(s.id) && this.mergeType(s) === type,
    );
  });
  /** Merges on this floor that can be undone, newest first. */
  readonly merges = computed(() => this.floor()?.merges ?? []);
  /** The photo point plan drawn on the map, if any. */
  readonly hallPlan = signal<HallPlan | null>(null);
  /** The one selected region, when it is a hall (corridor or lobby). */
  readonly selectedHall = computed(() => {
    const s = this.selectedSpaces();
    return s.length === 1 && (s[0].kind === 'corridor' || s[0].kind === 'lobby') ? s[0] : null;
  });
  readonly strips = computed(() => (this.floor()?.strips ?? []).filter((s) => s.hostId));
  readonly stripsText = computed(() =>
    this.strips()
      .map((s) => `${s.label} → ${s.hostLabel}`)
      .join(', '),
  );
  readonly mergeStair = computed(
    () => this.mergeStairChoice() ?? this.mergeMembers().some((s) => this.isStair(s)),
  );
  readonly stairCount = computed(() => {
    const f = this.floor();
    return f?.stairs?.length ?? (f?.spaces ?? []).filter((s) => s.stair).length;
  });
  /** Closed regions are listed (so they can be re-opened) but are not walkable. */
  readonly closedCount = computed(
    () => (this.floor()?.spaces ?? []).filter((s) => this.isClosed(s)).length,
  );
  readonly jobRunning = computed(() => this.job()?.status === 'running');
  /** The located region's current name (it may have been renamed since). */
  readonly focusLabel = computed(() => {
    const f = this.focused(),
      floor = this.floor();
    if (!f) return '';
    return (
      floor?.spaces?.find((s) => s.id === f.spaceId)?.label ??
      floor?.rooms?.find((r) => r.id === f.spaceId)?.label ??
      f.label
    );
  });

  async ngOnInit(): Promise<void> {
    // Back from another page: the building is still open; draw its floor again.
    if (this.building() && this.summary()) void this.repaint();
    try {
      this.health.set(await this.pipeline.health());
      this.library.set((await this.pipeline.library()).buildings);
    } catch {
      this.offline.set(
        'The map-authoring pipeline is not running. Start it with `npm run prod` in apps/pipeline (see docs/pipeline/README.md).',
      );
    }
  }

  // --- loading a building ---------------------------------------------------
  setFloorCount(event: Event): void {
    const n = Number(this.value(event));
    this.floorCount.set(Number.isInteger(n) && n > 0 ? n : null);
  }

  async upload(event: Event, nameInput: HTMLInputElement): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!this.planType()) {
      this.error.set('First say whether this is a floor plan or a building plan.');
      return;
    }
    if (this.planType() === 'building' && (this.floorCount() ?? 0) < 2) {
      this.error.set('How many floors does this building plan show? Enter the number of floors.');
      return;
    }
    if (this.cleanFirst()) return this.uploadClean(file, nameInput.value.trim());
    await this.run(async () => {
      this.load(await this.pipeline.uploadPlan(file, nameInput.value.trim()));
      this.say(
        `${file.name} uploaded: ${this.summary()!.floors.length} floor(s). Next, build the map with AI.`,
      );
    });
  }

  /** Image model redraws each floor (in parallel), then the floors are loaded. */
  private async uploadClean(file: File, name: string): Promise<void> {
    const mode = this.planType() as PlanType,
      floors = mode === 'floor' ? 1 : (this.floorCount() ?? 0);
    this.cleanFloors.set([]);
    await this.run(async () => {
      const { id } = await this.pipeline.startClean(file, {
        mode,
        floors,
        labels: this.floorNames().trim(),
        name,
      });
      let state = await this.pipeline.cleanJob(id);
      this.cleanJob.set(state);
      while (state.status === 'running' && !this.destroyRef.destroyed) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        state = await this.pipeline.cleanJob(id);
        this.cleanJob.set(state);
      }
      if (state.status !== 'complete' || !state.result)
        throw new Error(state.error ?? `Cleaning ${state.status}.`);
      this.cleanFloors.set(state.result.floors);
      this.load({ building: state.result.building, summary: state.result.summary });
      this.say(
        `${state.result.floors.length} clean floor(s) from ${state.result.imageModel} in ` +
          `${Math.round(state.result.elapsedMs / 1000)} s. Check them below, then build the map.`,
      );
    });
  }

  async cancelClean(): Promise<void> {
    const id = this.cleanJob()?.id;
    if (id) await this.pipeline.cancelClean(id);
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
    this.selectedDoor.set(null);
    this.selectedDoorIds.set([]);
    this.doorInfos.set({});
    this.addRoom.set('');
    this.addEdges.set([]);
    this.pruneRegions(edited.summary);
    // The selection, or else the located region, is re-applied to the new SVG. The map
    // stays zoomed on a located region; a door segment is not redrawn (it may have moved).
    if (this.selectedRegions().length) this.focused.set(null);
    else this.keepFocus();
    this.doorLine.set(null);
    this.overlay = {};
    void this.repaint();
  }

  /** After an edit, keeps the located region only while it is still on the current floor. */
  private keepFocus(): void {
    const f = this.focused(),
      floor = this.floor();
    const ids = floor
      ? [
          ...(floor.spaces ?? []).map((s) => s.id),
          ...(floor.rooms ?? []).map((r) => r.id),
          ...(floor.needsAttention ?? []).map((q) => q.spaceId),
          ...(floor.assumed ?? []).map((d) => d.roomId),
        ]
      : [];
    const kept = f && floor && f.floorId === floor.floorId && ids.includes(f.spaceId);
    this.focused.set(f && kept ? { ...f, door: false } : null);
  }

  async selectFloor(id: string): Promise<void> {
    this.floorId.set(id);
    this.selectedRegions.set([]);
    this.focused.set(null);
    this.doorLine.set(null);
    this.overlay = {};
    this.routeFrom.set('');
    this.routeTo.set('');
    this.routeNote.set('');
    await this.repaint();
  }

  private async redraw(): Promise<void> {
    const building = this.building(),
      seq = ++this.renderSeq;
    if (!building || !this.floorId() || !this.mapped()) {
      this.svg.set(null);
      return;
    }
    const { svg } = await this.pipeline.render(building, this.floorId(), this.overlay);
    // Quick selection changes can overlap; only the latest render is shown.
    if (seq === this.renderSeq && !this.destroyRef.destroyed)
      this.svg.set(this.sanitizer.bypassSecurityTrustHtml(svg));
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
  /** Runs one edit; `row` names the list row that shows "Saving…" meanwhile. */
  private async edit(
    action: (b: PipelineBuilding, floorId: string) => Promise<Edited>,
    done: string,
    row: string | null = null,
  ) {
    const building = this.building();
    if (!building) return;
    await this.run(async () => {
      this.load(await action(building, this.floorId()));
      this.say(done);
    }, row);
  }
  /** True while the edit started from this row is being saved. */
  isSaving(row: string): boolean {
    return this.saving() === row;
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
      `attention:${spaceId}`,
    );
  }
  notRoom(spaceId: string, label: string): Promise<void> {
    return this.edit(
      (b, f) => this.pipeline.notRoom(b, f, spaceId, this.reviewer()),
      `${label} marked as not a room; it is never routed through.`,
      `attention:${spaceId}`,
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
  /** Previews a doorway move on the map (drawn in the browser, no request). */
  setEdit(door: AssumedDoor, patch: Partial<DoorEdit>): void {
    const next = { ...this.editOf(door), ...patch };
    this.edits.update((all) => ({ ...all, [door.doorId]: next }));
    // A doorway preview replaces the region selection, and the map stays zoomed on the
    // room so the preview is visible.
    this.selectedRegions.set([]);
    this.focused.set(this.focusOn(door.roomId, door.roomLabel, true));
    this.doorLine.set(this.doorSegment(door));
  }
  /** The door as it would be placed: the pending edit's preview, else its current segment. */
  private doorSegment(door: AssumedDoor): { a: Point; b: Point } {
    const pending = this.edits()[door.doorId],
      edge = pending && door.candidates.find((c) => c.key === pending.edgeKey);
    return edge ? this.previewSegment(edge, pending) : door.segment;
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
      `door:${door.doorId}`,
    );
  }
  /** Removing a doorway first asks how: made into a wall, or the line removed. */
  readonly removeChoice = signal<string | null>(null);
  removeDoor(door: AssumedDoor): void {
    this.removeChoice.set(door.doorId);
  }
  removeDoorAs(door: AssumedDoor, as: 'wall' | 'none'): Promise<void> {
    this.removeChoice.set(null);
    const what =
      'joins' in door
        ? `between ${(door as DoorwayInfo).joins.map((j) => j.label).join(' and ')}`
        : `of ${door.roomLabel}`;
    return this.edit(
      (b, f) => this.pipeline.removeDoor(b, f, door.doorId, this.reviewer(), as),
      as === 'wall'
        ? `Doorway ${what} made into a wall; paths rebuilt.`
        : `Doorway ${what} removed (no wall); paths rebuilt.`,
      `door:${door.doorId}`,
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
  /** Adds a doorway; `row` is the assumed doorway row it was asked from ("Add another"). */
  addDoor(spaceId = this.addRoom(), row: string | null = null): Promise<void> {
    const edge =
      spaceId === this.addRoom() && this.addEdge() !== '' ? Number(this.addEdge()) : null;
    return this.edit(
      (b, f) => this.pipeline.addDoor(b, f, spaceId, edge, this.reviewer()),
      'Doorway added. Move it to the real opening under Assumed doorways; routes use the closest doorway.',
      row,
    );
  }

  // --- locate: zoom the map to one region -----------------------------------
  private focusOn(spaceId: string, label: string, door: boolean): Focus {
    return { floorId: this.floorId(), spaceId, label, door };
  }
  /**
   * "Show on map": zooms the map to a region (with an assumed door in magenta) and scrolls
   * to it. The zoom is applied to the SVG already shown, so it needs no request.
   */
  locate(spaceId: string, label: string, door?: AssumedDoor): void {
    // Locating replaces the Regions selection highlight.
    this.selectedRegions.set([]);
    this.focused.set(this.focusOn(spaceId, label, !!door));
    this.doorLine.set(door ? this.doorSegment(door) : null);
    this.scrollToMap();
  }
  showWholeFloor(): void {
    this.focused.set(null);
    this.doorLine.set(null);
  }
  private scrollToMap(): void {
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    this.mapView()?.nativeElement.scrollIntoView?.({
      behavior: reduce ? 'auto' : 'smooth',
      block: 'center',
    });
  }

  // --- labels for doorway edges ----------------------------------------------
  /** hallway, lobby or room: what a neighbouring region is, in the map author's words. */
  kindWord(kind: string): 'hallway' | 'lobby' | 'room' {
    const k = kind.toLowerCase();
    return k === 'corridor' || k === 'hallway' ? 'hallway' : k === 'lobby' ? 'lobby' : 'room';
  }
  edgeLabel(edge: EdgeOption): string {
    return `${edge.adjacentLabel} · ${this.kindWord(edge.adjacentKind)} · ${Math.round(edge.length)} px`;
  }
  /** An "Opens onto" option; the door's current edge is marked. */
  candidateLabel(door: AssumedDoor, edge: EdgeOption): string {
    return this.edgeLabel(edge) + (edge.key === door.edgeKey ? ' (current)' : '');
  }

  // --- regions: names, roles, merges -------------------------------------------
  isStair(space: SpaceSummary): boolean {
    return (
      space.stair ??
      (space.use !== undefined
        ? space.use === 'stair'
        : (this.floor()?.stairs?.some((s) => s.id === space.id) ?? false))
    );
  }
  isClosed(space: SpaceSummary): boolean {
    return space.closed === true || space.use === 'closed';
  }
  isDefaultName(label: string): boolean {
    return DEFAULT_NAME.test(label.trim());
  }
  isSelected(id: string): boolean {
    return this.selectedRegions().includes(id);
  }
  private draftKey(spaceId: string): string {
    return `${this.floorId()}/${spaceId}`;
  }
  draftOf(space: SpaceSummary): string {
    return this.nameDrafts()[this.draftKey(space.id)] ?? space.label;
  }
  setDraft(space: SpaceSummary, text: string): void {
    this.nameDrafts.update((all) => ({ ...all, [this.draftKey(space.id)]: text }));
  }
  canSaveName(space: SpaceSummary): boolean {
    const name = this.draftOf(space).trim();
    return name.length > 0 && name.length <= REGION_NAME_MAX && name !== space.label;
  }
  rename(space: SpaceSummary): Promise<void> {
    if (this.busy() || !this.canSaveName(space)) return Promise.resolve();
    const label = this.draftOf(space).trim(),
      key = this.draftKey(space.id);
    return this.edit(
      async (b, f) => {
        const edited = await this.pipeline.renameSpace(b, f, space.id, label, this.reviewer());
        this.dropDrafts([key]);
        return edited;
      },
      `"${space.label}" renamed to "${label}".`,
      `region:${space.id}`,
    );
  }
  /** The region's role, from closed / use / kind (hall room = kind room + use hall). */
  roleOf(space: SpaceSummary): SpaceRole {
    if (this.isClosed(space)) return 'closed';
    if (this.isStair(space)) return 'stair';
    if (space.use === 'hall') return 'hall-room';
    const word = this.kindWord(space.kind);
    return word === 'hallway' ? 'corridor' : word === 'lobby' ? 'lobby' : 'room';
  }
  /** Hall room, Stair or Closed; null when the kind badge says it all. */
  roleBadge(space: SpaceSummary): string | null {
    return ROLE_BADGES[this.roleOf(space)] ?? null;
  }
  /** The kind badge: the pipeline's kind, with corridor shown as hallway. */
  kindBadge(space: SpaceSummary): string {
    const k = space.kind.toLowerCase();
    return k === 'corridor' ? 'hallway' : k;
  }
  /** "Use as": sets a region's role. Choosing another role re-opens a closed region. */
  async setRole(space: SpaceSummary, event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement,
      choice = ROLE_CHOICES.find((c) => c.value === select.value),
      before = this.roleOf(space),
      building = this.building(),
      floorId = this.floorId();
    const current = () => this.floor()?.spaces?.find((s) => s.id === space.id);
    if (building && choice && choice.value !== before && !this.busy()) {
      await this.run(async () => {
        this.load(
          await this.pipeline.setKind(building, floorId, space.id, choice.value, this.reviewer()),
        );
        // Describe what the pipeline actually recorded.
        const after = current(),
          role = after ? this.roleOf(after) : choice.value,
          done = ROLE_CHOICES.find((c) => c.value === role)?.done ?? choice.done;
        this.say(
          [
            `${after?.label ?? space.label} is now ${done}.`,
            before === 'stair' && role !== 'stair' ? 'It is no longer a stair.' : '',
            before === 'closed' && role !== 'closed' ? 'It is open again.' : '',
          ]
            .filter(Boolean)
            .join(' '),
        );
      }, `region:${space.id}`);
    }
    // A refused or failed change leaves the select on the region's actual role.
    const now = current();
    select.value = now ? this.roleOf(now) : before;
  }

  /** Ticks or unticks a region; the map highlight is applied in the browser (no request). */
  toggleRegion(id: string): void {
    // While merging, ticking a room picks it for the merge.
    if (this.mergeGroup()) {
      this.toggleMerge(id);
      return;
    }
    this.selectedRegions.update((sel) =>
      sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id],
    );
    this.showSelection();
  }
  clearSelection(): void {
    this.selectedRegions.set([]);
    this.showSelection();
  }
  /**
   * Clicking a walkable region on the map toggles its selection, or, while the Merge rooms
   * menu is open, adds or removes it from the merge group.
   */
  mapClick(event: Event): void {
    const target = event.target as Element | null,
      id = target?.closest?.('[data-room-id]')?.getAttribute('data-room-id'),
      photo = target?.closest?.('[data-photo]')?.getAttribute('data-photo');
    // A photo point on the map picks it for the Photo points menu.
    if (photo !== null && photo !== undefined && this.hallPlan()) {
      this.togglePhoto(Number(photo));
      this.sidePanel.set('photos');
      return;
    }
    if (this.selectMode() === 'doorways') {
      const doorId = target?.closest?.('[data-door-id]')?.getAttribute('data-door-id');
      if (doorId) void this.selectDoor(doorId);
      return;
    }
    if (!id || !this.floor()?.spaces.some((s) => s.id === id)) return;
    this.sidePanel.set('regions');
    if (this.mergeGroup()) this.toggleMerge(id);
    else this.toggleRegion(id);
  }

  /**
   * Opens the Merge rooms menu. With two rooms ticked it merges those: the one ticked
   * first is kept and the second is removed into it. Otherwise it starts from `startId`
   * or the one ticked room.
   */
  openMerge(startId?: string): void {
    const sel = this.selectedRegions(),
      start = startId ?? sel[0];
    this.mergeGroup.set(start ? [start] : []);
    // Ticked rooms join in order; one too far from all the others is left out.
    if (!startId) {
      const pending = sel.slice(1);
      for (let progress = true; pending.length && progress;) {
        progress = false;
        for (const id of [...pending])
          if (this.mergeCandidates().some((s) => s.id === id)) {
            this.mergeGroup.update((g) => [...(g ?? []), id]);
            pending.splice(pending.indexOf(id), 1);
            progress = true;
          }
      }
      if (pending.length) {
        const first = this.mergeMembers()[0],
          left = pending
            .map((id) => this.floor()?.spaces.find((s) => s.id === id))
            .filter((s): s is SpaceSummary => !!s),
          other = left
            .filter((s) => first && this.mergeType(s) !== this.mergeType(first))
            .map((s) => s.label),
          far = left
            .filter((s) => !first || this.mergeType(s) === this.mergeType(first))
            .map((s) => s.label),
          parts = [
            other.length
              ? `${other.join(', ')} ${other.length === 1 ? 'is' : 'are'} not the same type as ${first?.label}`
              : '',
            far.length
              ? `${far.join(', ')} ${far.length === 1 ? 'is' : 'are'} too far from the other rooms`
              : '',
          ].filter(Boolean);
        this.say(
          `${parts.join('; ')}, so ${pending.length === 1 ? 'it was' : 'they were'} left out.`,
        );
      }
    }
    this.selectedRegions.set([]);
    this.sidePanel.set('regions');
    this.mergeName.set('');
    this.mergeStairChoice.set(null);
    this.showSelection();
    setTimeout(() =>
      document
        .querySelector('[data-testid="merge-box"]')
        ?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }),
    );
  }
  cancelMerge(): void {
    this.mergeGroup.set(null);
    this.mergeName.set('');
    this.mergeStairChoice.set(null);
  }
  /** Picks the first region of the merge group (from the menu's list). */
  startMerge(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    this.mergeGroup.set(id ? [id] : []);
  }
  /**
   * Sets the first room, or the room to merge into it (replacing an earlier choice). A room
   * that doesn't share a wall with the first one is refused with a reason.
   */
  addToMerge(id: string): boolean {
    const group = this.mergeGroup();
    if (!group || group.includes(id)) return false;
    if (!group.length) {
      this.mergeGroup.set([id]);
      return true;
    }
    if (!this.mergeCandidates().some((s) => s.id === id)) {
      const space = this.floor()?.spaces.find((s) => s.id === id),
        first = this.mergeMembers()[0],
        name = space?.label ?? id;
      this.say(
        space && first && this.mergeType(space) !== this.mergeType(first)
          ? `${name} is a ${this.mergeType(space)} and ${first.label} is a ${this.mergeType(first)}; hallways, rooms and stairs only merge with their own type.`
          : `${name} is too far from the rooms being merged, so it can't join them.`,
      );
      return false;
    }
    this.mergeGroup.set([...group, id]);
    return true;
  }
  /**
   * Removing the first room starts over; removing another also drops any room that was
   * only close to the chosen rooms through it.
   */
  removeFromMerge(id: string): void {
    const group = this.mergeGroup();
    if (!group) return;
    if (group[0] === id) {
      this.mergeGroup.set([]);
      return;
    }
    const rest = group.filter((g) => g !== id),
      spaces = this.floor()?.spaces ?? [],
      close = (g: string) => spaces.find((s) => s.id === g)?.neighbours ?? [],
      kept = new Set([rest[0]]),
      queue = [rest[0]];
    for (let i = 0; i < queue.length; i++)
      for (const n of close(queue[i]))
        if (rest.includes(n) && !kept.has(n)) {
          kept.add(n);
          queue.push(n);
        }
    this.mergeGroup.set(rest.filter((g) => kept.has(g)));
  }
  /** Switches what a click on the map selects. */
  setSelectMode(mode: 'rooms' | 'doorways'): void {
    this.selectMode.set(mode);
    this.sidePanel.set(mode === 'doorways' ? 'doorways' : 'regions');
    if (mode === 'rooms') this.clearDoor();
  }
  /**
   * A click on a doorway adds it to the selection (drawn in magenta); clicking it again
   * removes it. One selected doorway can be moved or removed; several can be removed
   * together.
   */
  async selectDoor(doorId: string): Promise<void> {
    const building = this.building();
    if (!building) return;
    this.sidePanel.set('doorways');
    this.removeChoice.set(null);
    if (this.selectedDoorIds().includes(doorId)) {
      this.selectedDoorIds.update((ids) => ids.filter((id) => id !== doorId));
      this.showDoorSelection();
      return;
    }
    try {
      const info =
        this.doorInfos()[doorId] ??
        (await this.pipeline.describeDoor(building, this.floorId(), doorId));
      this.doorInfos.update((all) => ({ ...all, [doorId]: info }));
      this.edits.update((all) => {
        const { [doorId]: _, ...rest } = all;
        return rest;
      });
      this.selectedRegions.set([]);
      this.focused.set(null);
      this.selectedDoorIds.update((ids) => [...ids, doorId]);
      this.showDoorSelection();
    } catch (e) {
      this.error.set(this.errorText(e));
    }
  }
  /** One selected doorway gets the editing card; several get the bulk card. */
  private showDoorSelection(): void {
    const ids = this.selectedDoorIds(),
      one = ids.length === 1 ? (this.doorInfos()[ids[0]] ?? null) : null;
    this.selectedDoor.set(one);
    this.doorLine.set(one ? one.segment : null);
  }
  clearDoor(): void {
    this.selectedDoorIds.set([]);
    this.selectedDoor.set(null);
    this.doorLine.set(null);
  }
  /** Removes every selected doorway the same way: as walls, or joining the spaces. */
  removeSelectedDoorsAs(as: 'wall' | 'none'): Promise<void> {
    const ids = this.selectedDoorIds();
    if (ids.length < 2) return Promise.resolve();
    return this.edit(
      (b, f) => this.pipeline.removeDoors(b, f, ids, this.reviewer(), as),
      as === 'wall'
        ? `${ids.length} doorways made into walls; paths rebuilt.`
        : `${ids.length} doorways removed (no walls); paths rebuilt.`,
      'doors',
    );
  }
  /** Moves (or confirms) the selected doorway with the pending edit. */
  saveSelectedDoor(confirm = false): Promise<void> {
    const door = this.selectedDoor();
    return door ? this.applyMove(door, confirm) : Promise.resolve();
  }
  /** The selected doorway does not exist on the plan: asks how to remove it. */
  removeSelectedDoor(): void {
    const door = this.selectedDoor();
    if (door) this.removeDoor(door);
  }
  readonly joinLabel = (j: { label: string }) => j.label;
  /** Readable doorway state for the selected-doorway card. */
  doorStateText(state: string): string {
    return (
      {
        verified: 'Verified on the plan',
        assumed: 'Assumed (not seen on the plan)',
        legacy: 'From the map (no separate check)',
        stale: 'Needs checking',
        rejected: 'Rejected',
      }[state] ?? state
    );
  }

  /** Plans photo points over the whole selected hall and draws them. */
  async showHallPoints(): Promise<void> {
    const building = this.building(),
      hall = this.selectedHall();
    if (!building || !hall) return;
    await this.run(async () => {
      const plan = await this.pipeline.hallPoints(building, this.floorId(), hall.id);
      this.hallPlan.set({ ...plan, points: plan.points.map((p, i) => ({ ...p, key: i })) });
      this.pickedPhotos.set([]);
      this.photosVisible.set(true);
      this.sidePanel.set('photos');
      this.drawPhotos();
      this.say(
        `${plan.points.length} photo points across ${plan.label}, numbered in walking order, ` +
          (plan.scaleVerified
            ? `every ${plan.spacingM} m.`
            : `every ${Math.round(plan.spacingPx)} map pixels (no verified scale, so not metres).`),
      );
      await this.redraw();
    }, 'hall-points');
  }
  /** Whether the photo points are drawn on the map; hiding keeps the list. */
  readonly photosVisible = signal(true);
  async togglePhotosVisible(): Promise<void> {
    this.photosVisible.update((v) => !v);
    this.drawPhotos();
    await this.repaint();
  }
  /** Deletes the photo point plan (list and map). */
  async clearHallPoints(): Promise<void> {
    this.hallPlan.set(null);
    this.pickedPhotos.set([]);
    this.photosVisible.set(true);
    this.drawPhotos();
    await this.repaint();
  }
  /** Photo point keys picked in the Photo points menu or on the map. */
  readonly pickedPhotos = signal<number[]>([]);
  /** True when the numbers have gaps (after removing points) and Relabel would change them. */
  readonly photoGaps = computed(() =>
    (this.hallPlan()?.points ?? []).some((p, i) => p.order !== i + 1),
  );
  private drawPhotos(): void {
    const plan = this.hallPlan(),
      picked = new Set(this.pickedPhotos());
    this.overlay =
      plan && this.photosVisible()
        ? {
            routes: plan.lines,
            photoPoints: plan.points.map((p) => ({ ...p, selected: picked.has(p.key!) })),
          }
        : {};
  }
  togglePhoto(key: number): void {
    this.pickedPhotos.update((k) => (k.includes(key) ? k.filter((x) => x !== key) : [...k, key]));
    this.drawPhotos();
    void this.repaint();
  }
  /** Picks every point, or none when all are already picked. */
  readonly allPhotosPicked = computed(() => {
    const n = this.hallPlan()?.points.length ?? 0;
    return n > 0 && this.pickedPhotos().length === n;
  });
  toggleAllPhotos(): void {
    this.pickedPhotos.set(
      this.allPhotosPicked() ? [] : (this.hallPlan()?.points ?? []).map((p) => p.key!),
    );
    this.drawPhotos();
    void this.repaint();
  }
  clearPickedPhotos(): void {
    this.pickedPhotos.set([]);
    this.drawPhotos();
    void this.repaint();
  }
  /** Removes the picked points (or one point); the others keep their numbers until Relabel. */
  removePhotos(keys: number[] = this.pickedPhotos()): void {
    const plan = this.hallPlan(),
      gone = new Set(keys);
    if (!plan || !gone.size) return;
    this.hallPlan.set({ ...plan, points: plan.points.filter((p) => !gone.has(p.key!)) });
    this.pickedPhotos.update((k) => k.filter((x) => !gone.has(x)));
    this.say(
      `Removed ${gone.size} photo point${gone.size === 1 ? '' : 's'}. Relabel to number them 1 to ${this.hallPlan()!.points.length} again.`,
    );
    this.drawPhotos();
    void this.repaint();
  }
  /** Numbers the remaining points 1, 2, 3… in their walking order, with no gaps. */
  relabelPhotos(): void {
    const plan = this.hallPlan();
    if (!plan) return;
    this.hallPlan.set({ ...plan, points: plan.points.map((p, i) => ({ ...p, order: i + 1 })) });
    this.say(`Photo points relabelled 1 to ${plan.points.length}.`);
    this.drawPhotos();
    void this.repaint();
  }
  /** Folds the floor's thin strips into their neighbours. */
  async foldStrips(): Promise<void> {
    const building = this.building(),
      floorId = this.floorId();
    if (!building || !this.strips().length) return;
    await this.run(async () => {
      const out = await this.pipeline.foldStrips(building, floorId, this.reviewer());
      this.cancelMerge();
      this.selectedRegions.set([]);
      this.load(out);
      const n = out.absorbed?.length ?? 0,
        skipped = out.skipped?.length ?? 0;
      this.say(
        `Folded ${n} thin strip${n === 1 ? '' : 's'} into ${n === 1 ? 'its neighbour' : 'their neighbours'}` +
          (skipped
            ? `; ${skipped} could not be folded (${out.skipped!.map((s) => s.label).join(', ')}).`
            : '.') +
          (n ? ' Each can be undone under Merged rooms.' : ''),
      );
    }, 'strips');
  }
  /** Undoes a recorded merge from the Merged rooms checklist. */
  async unmerge(m: MergeRecord): Promise<void> {
    const building = this.building(),
      floorId = this.floorId();
    if (!building || !m.undoable) return;
    await this.run(async () => {
      const out = await this.pipeline.unmergeSpaces(building, floorId, m.recordId, this.reviewer());
      this.cancelMerge();
      this.selectedRegions.set([]);
      this.dropDrafts([`${floorId}/${m.keptId}`]);
      this.load(out);
      this.say(`Unmerged "${m.removedLabel}" from "${m.label}"; both rooms are back.`);
    }, 'unmerge:' + m.recordId);
  }
  toggleMerge(id: string): void {
    if (this.mergeGroup()?.includes(id)) this.removeFromMerge(id);
    else this.addToMerge(id);
  }
  private showSelection(): void {
    // Selecting regions shows the whole floor again.
    this.focused.set(null);
    this.doorLine.set(null);
  }
  /** Renders from the service without the busy state; a failure is shown as an error. */
  private async repaint(): Promise<void> {
    try {
      await this.redraw();
    } catch (e) {
      this.error.set(this.errorText(e));
    }
  }

  async mergeRegions(): Promise<void> {
    const building = this.building(),
      ids = this.mergeMembers().map((s) => s.id),
      label = this.mergeName().trim(),
      stair = this.mergeStair(),
      floorId = this.floorId();
    if (!building || ids.length < 2 || label.length > REGION_NAME_MAX) return;
    await this.run(async () => {
      const merged = await this.pipeline.mergeSpaces(building, floorId, {
        spaceIds: ids,
        ...(label ? { label } : {}),
        stair,
        reviewer: this.reviewer(),
      });
      this.selectedRegions.set([]);
      this.cancelMerge();
      this.dropDrafts(ids.map((id) => `${floorId}/${id}`));
      this.load(merged);
      const name =
        this.floor()?.spaces.find((s) => s.id === merged.spaceId)?.label ??
        (label || merged.spaceId);
      const absorbed = (merged.absorbed ?? []).map((a) => a.label),
        carved = (merged.carved ?? []).map((a) => a.label);
      this.say(
        `Merged ${ids.length} regions into "${name}".` +
          (absorbed.length
            ? ` Also merged in what lay between them: ${absorbed.join(', ')}.`
            : '') +
          (carved.length
            ? ` Took only the part between the rooms from: ${carved.join(', ')}.`
            : ''),
      );
    }, 'merge');
  }

  private dropDrafts(keys: string[]): void {
    this.nameDrafts.update((all) =>
      Object.fromEntries(Object.entries(all).filter(([k]) => !keys.includes(k))),
    );
  }
  /** After any edit: keep selections and unsaved names only for regions that still exist. */
  private pruneRegions(summary: BuildingSummary): void {
    const labels = new Map<string, string>();
    for (const f of summary.floors)
      for (const s of f.spaces ?? []) labels.set(`${f.floorId}/${s.id}`, s.label);
    this.nameDrafts.update((all) =>
      Object.fromEntries(
        Object.entries(all).filter(([k, v]) => labels.has(k) && labels.get(k) !== v.trim()),
      ),
    );
    this.selectedRegions.update((sel) => sel.filter((id) => labels.has(`${this.floorId()}/${id}`)));
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
      this.selectedRegions.set([]);
      this.focused.set(null);
      this.doorLine.set(null);
      this.overlay = { routes: here?.segments ?? [] };
      this.routeNote.set(route ? `Route found: ${route.steps} steps.` : (message ?? 'No route.'));
      await this.redraw();
    });
  }

  async saveCopy(): Promise<void> {
    const building = this.building();
    if (!building) return;
    await this.run(async () => {
      const r = await this.pipeline.saveCopy(building);
      this.library.set((await this.pipeline.library()).buildings);
      this.say(
        `${building.name} ${r.updated ? 'updated in' : 'added to'} the pipeline's saved copies.`,
      );
    });
  }

  private say(text: string): void {
    this.message.set(text);
    this.error.set('');
  }
  private async run(task: () => Promise<void>, row: string | null = null): Promise<void> {
    this.busy.set(true);
    this.saving.set(row);
    this.error.set('');
    try {
      await task();
    } catch (e) {
      this.error.set(this.errorText(e));
    } finally {
      this.busy.set(false);
      this.saving.set(null);
    }
  }
  private errorText(e: unknown): string {
    const err = e as { error?: { error?: string }; message?: string };
    return err.error?.error ?? err.message ?? 'Request failed.';
  }
  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }
  seconds(ms: number | undefined): string {
    return `${Math.round((ms ?? 0) / 1000)} s`;
  }
  num(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }
}
