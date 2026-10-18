import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Icon } from '../../shared/icon';
import { CaptureApi, requestError } from './capture-api.service';
import { CaptureCamera, type SavedPhoto, type SlotState } from './capture-camera';
import { CaptureMap, type MapMarker } from './capture-map';
import type {
  ActiveSession,
  CaptureFloor,
  CapturePoint,
  Direction,
  MapBuilding,
  Me,
  MeTarget,
  PlanPoint,
  PointBody,
  ServerPhoto,
  ServerPoint,
  ServerSession,
  SessionDetail,
  Slot,
  XY,
} from './capture.models';
import {
  corridorEnds,
  derivePointState,
  distanceLabel,
  nearbyLandmarks,
  nearestCorridor,
  progressSummary,
  renumber,
  SLOT_LABEL,
  STATE_LABEL,
  walkingPath,
  type PointProgress,
} from './capture-math';
import { listDrafts, loadDraft, saveDraft, type DraftSummary } from './capture-drafts';
import { uuid } from './capture-utils';
import type { QueuedPhoto, UploadState } from './photo-store';
import { UploadQueue } from './upload-queue.service';

type Phase = 'loading' | 'setup' | 'map';
type SheetMode = 'point' | 'adjust' | 'add';
const CAPTURE_ROLES = ['admin', 'volunteer'];

export const UPLOAD_LABEL: Record<UploadState, string> = {
  'captured-locally': 'Saved on this phone',
  'upload-pending': 'Waiting to upload',
  uploaded: 'Uploaded',
  failed: 'Upload failed',
};

/** The Django body of a point (client-only fields dropped). */
export function pointBody(p: CapturePoint): PointBody {
  return {
    order: p.order,
    planId: p.planId,
    mapRevision: p.mapRevision,
    edgeId: p.edgeId,
    nodeId: p.nodeId,
    referenceEdgeId: p.referenceEdgeId,
    fraction: p.fraction,
    corridorDistancePx: p.corridorDistancePx,
    distanceM: p.distanceM,
    forwardAngleDeg: p.forwardAngleDeg,
    plannedX: p.plannedX,
    plannedY: p.plannedY,
    confirmedX: p.confirmedX,
    confirmedY: p.confirmedY,
    positionSource: p.positionSource,
    reason: p.reason,
  };
}

/** Where the point is drawn: the confirmed position, else the planned one. */
export function pointPosition(p: CapturePoint): XY {
  return p.confirmedX !== null && p.confirmedY !== null
    ? { x: p.confirmedX, y: p.confirmedY }
    : { x: p.plannedX, y: p.plannedY };
}

/** Pipeline placement fields of a planned or snapped point. */
function placement(p: PlanPoint) {
  return {
    edgeId: p.edgeId,
    nodeId: p.nodeId,
    referenceEdgeId: p.referenceEdgeId,
    fraction: p.fraction,
    corridorDistancePx: p.corridorDistancePx,
    distanceM: p.distanceM,
    forwardAngleDeg: p.forwardAngleDeg,
  };
}

@Component({
  selector: 'app-capture-page',
  imports: [Icon, RouterLink, CaptureMap, CaptureCamera],
  templateUrl: './capture.html',
  styleUrls: ['./capture.scss', './capture-sheet.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CapturePage {
  private readonly api = inject(CaptureApi);
  readonly queue = inject(UploadQueue);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly map = viewChild(CaptureMap);

  readonly phase = signal<Phase>('loading');
  readonly busy = signal('');
  readonly error = signal('');
  readonly notice = signal('');
  // Setup.
  readonly me = signal<Me | null>(null);
  readonly meError = signal('');
  readonly buildings = signal<MapBuilding[]>([]);
  readonly mapError = signal('');
  readonly buildingId = signal('');
  readonly floorId = signal('');
  readonly targetId = signal('');
  readonly floor = signal<CaptureFloor | null>(null);
  readonly floorSvg = signal<SafeHtml | null>(null);
  readonly corridorId = signal('');
  readonly direction = signal<Direction>('forward');
  readonly spacingM = signal(2);
  readonly sessions = signal<ServerSession[]>([]);
  readonly drafts = signal<DraftSummary[]>(listDrafts());
  // Active session.
  readonly session = signal<ActiveSession | null>(null);
  readonly points = signal<CapturePoint[]>([]);
  readonly serverPhotos = signal<ServerPhoto[]>([]);
  readonly selectedId = signal('');
  readonly sheet = signal<SheetMode>('point');
  readonly adjustPx = signal(0);
  readonly preview = signal<PlanPoint | null>(null);
  readonly placing = signal(false);
  readonly capturing = signal(false);
  readonly syncError = signal('');

  readonly stateLabel = STATE_LABEL;
  readonly slotLabel = SLOT_LABEL;
  readonly uploadLabel = UPLOAD_LABEL;
  readonly distanceLabel = distanceLabel;

  readonly targets = computed<MeTarget[]>(() =>
    (this.me()?.targets ?? []).filter((t) => CAPTURE_ROLES.includes(t.role)),
  );
  /** Buildings and floors the contributor has a target for. */
  readonly available = computed<MapBuilding[]>(() => {
    const targets = this.targets();
    return this.buildings()
      .map((b) => ({
        ...b,
        floors: b.floors.filter((f) =>
          targets.some((t) => t.mapBuildingId === b.id && t.mapFloorId === f.id),
        ),
      }))
      .filter((b) => b.floors.length);
  });
  readonly floors = computed(
    () => this.available().find((b) => b.id === this.buildingId())?.floors ?? [],
  );
  readonly floorTargets = computed(() =>
    this.targets().filter(
      (t) => t.mapBuildingId === this.buildingId() && t.mapFloorId === this.floorId(),
    ),
  );
  readonly corridor = computed(
    () =>
      this.floor()?.corridors.find(
        (c) => c.id === (this.session()?.body.corridorId ?? this.corridorId()),
      ) ?? null,
  );
  readonly scaleVerified = computed(() => !!this.floor()?.scale.verified);
  /** "towards"/"from" names for each walking direction of the chosen corridor. */
  readonly endsFor = computed(() => {
    const c = this.corridor(),
      f = this.floor();
    if (!c || !f) return null;
    return {
      forward: corridorEnds(c, 'forward', f.nodes, f.landmarks),
      reverse: corridorEnds(c, 'reverse', f.nodes, f.landmarks),
    };
  });
  readonly ends = computed(() => {
    const e = this.endsFor();
    return e ? e[this.session()?.body.direction ?? this.direction()] : null;
  });
  readonly resumable = computed(() => {
    const server = this.sessions().map((s) => ({
      id: s.id,
      corridorId: s.corridorId,
      direction: s.direction,
      when: s.updatedAt ?? s.createdAt ?? '',
      local: false,
    }));
    const local = this.drafts()
      .filter(
        (d) =>
          d.buildingId === this.buildingId() &&
          d.floorId === this.floorId() &&
          !server.some((s) => s.id === d.id),
      )
      .map((d) => ({
        id: d.id,
        corridorId: d.corridorId,
        direction: d.direction,
        when: d.savedAt,
        local: true,
      }));
    return [...server, ...local];
  });
  readonly walkPath = computed<XY[]>(() => {
    const s = this.session();
    if (s) return s.path;
    const c = this.corridor();
    return c ? walkingPath(c, this.direction()) : [];
  });
  readonly mapCorridors = computed(() => (this.session() ? [] : (this.floor()?.corridors ?? [])));
  readonly records = computed(() => {
    const id = this.session()?.id;
    return id ? this.queue.records().filter((r) => r.sessionId === id) : [];
  });
  readonly progress = computed(() => {
    const photos = this.serverPhotos(),
      records = this.records().map((r) => ({
        id: r.id,
        pointId: r.pointId,
        slot: r.metadata.slot,
        state: r.state,
      }));
    return new Map<string, PointProgress>(
      this.points().map((p) => [p.id, derivePointState(p, photos, records)]),
    );
  });
  readonly progressText = computed(() => progressSummary([...this.progress().values()]));
  readonly markers = computed<MapMarker[]>(() =>
    this.points().map((p) => ({
      id: p.id,
      order: p.order,
      ...pointPosition(p),
      state: this.progress().get(p.id)?.state ?? 'empty',
      selected: p.id === this.selectedId(),
    })),
  );
  readonly selected = computed(() => this.points().find((p) => p.id === this.selectedId()) ?? null);
  readonly selectedPos = computed(() => {
    const p = this.selected();
    return p ? pointPosition(p) : null;
  });
  readonly selectedProgress = computed(() => {
    const p = this.selected();
    return p ? (this.progress().get(p.id) ?? null) : null;
  });
  readonly selectedNearby = computed(() => {
    const p = this.selected(),
      f = this.floor();
    if (!p) return [];
    return p.nearby?.length ? p.nearby : nearbyLandmarks(f?.landmarks ?? [], pointPosition(p));
  });
  readonly selectedRecords = computed(() =>
    this.records().filter((r) => r.pointId === this.selectedId()),
  );
  /** Photos of this session not confirmed by the server yet, oldest first. */
  readonly waiting = computed(() => this.records().filter((r) => r.state !== 'uploaded'));
  readonly failedCount = computed(() => this.waiting().filter((r) => r.state === 'failed').length);
  readonly slotStates = computed<Partial<Record<Slot, SlotState>>>(() => {
    const id = this.selectedId(),
      out: Partial<Record<Slot, SlotState>> = {};
    for (const p of this.serverPhotos())
      if ((p.pointId ?? p.point) === id && p.reviewStatus !== 'replaced') out[p.slot] = 'uploaded';
    for (const r of this.records())
      if (r.pointId === id)
        out[r.metadata.slot] =
          r.state === 'uploaded' ? 'uploaded' : r.state === 'failed' ? 'failed' : 'pending';
    return out;
  });
  readonly corridorLength = computed(() => this.corridor()?.lengthPx ?? 0);

  private syncing = false;
  private resync = false;
  private snapSeq = 0;
  private snapTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    void this.load();
    // After each confirmed upload, refresh the server's view of points and photos.
    effect(() => {
      const n = this.queue.confirmed();
      if (!n) return;
      untracked(() => {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.refreshSession(), 600);
      });
    });
    const online = () => void this.syncAll();
    globalThis.addEventListener?.('online', online);
    this.destroyRef.onDestroy(() => {
      globalThis.removeEventListener?.('online', online);
      clearTimeout(this.snapTimer);
      clearTimeout(this.refreshTimer);
    });
  }

  // Setup -----------------------------------------------------------------------------------

  async load(): Promise<void> {
    this.busy.set('Loading your capture targets…');
    const [me, buildings] = await Promise.allSettled([this.api.me(), this.api.buildings()]);
    if (me.status === 'fulfilled') this.me.set(me.value);
    else this.meError.set(requestError(me.reason, 'Your contributor status could not be loaded'));
    if (buildings.status === 'fulfilled') this.buildings.set(buildings.value ?? []);
    else this.mapError.set(requestError(buildings.reason, 'The maps could not be loaded'));
    this.busy.set('');
    const resume = this.route.snapshot.queryParamMap.get('session');
    if (resume) {
      await this.resume(resume);
      if (this.session()) return;
    }
    this.phase.set('setup');
    const choices = this.available();
    if (choices.length === 1 && choices[0].floors.length === 1)
      await this.selectFloor(choices[0].id, choices[0].floors[0].id);
  }

  loginHref(): string {
    const url = this.me()?.loginUrl || '/accounts/login/';
    return url.includes('next=')
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}next=${encodeURIComponent('/capture')}`;
  }

  targetFloorLabel(t: MeTarget): string {
    const b = this.buildings().find((x) => x.id === t.mapBuildingId);
    const f = b?.floors.find((x) => x.id === t.mapFloorId);
    return b && f ? `${b.name} · ${f.label}` : 'Map not available for capture yet';
  }

  selectBuilding(id: string): void {
    this.buildingId.set(id);
    const floors = this.floors();
    if (floors.length === 1) void this.selectFloor(id, floors[0].id);
    else {
      this.floorId.set('');
      this.floor.set(null);
      this.floorSvg.set(null);
    }
  }

  async selectFloor(buildingId: string, floorId: string, targetId?: string): Promise<boolean> {
    this.buildingId.set(buildingId);
    this.floorId.set(floorId);
    this.targetId.set(targetId ?? this.floorTargets()[0]?.id ?? '');
    this.error.set('');
    this.busy.set('Loading the floor map…');
    try {
      const floor = await this.api.floor(buildingId, floorId);
      this.floor.set(floor);
      this.floorSvg.set(this.sanitizer.bypassSecurityTrustHtml(floor.svg ?? ''));
      if (!floor.corridors.some((c) => c.id === this.corridorId()))
        this.corridorId.set(floor.corridors[0]?.id ?? '');
      setTimeout(() => this.map()?.fit());
    } catch (e) {
      this.error.set(requestError(e, 'The floor map could not be loaded'));
      this.busy.set('');
      return false;
    }
    this.busy.set('');
    void this.loadSessions();
    return true;
  }

  async loadSessions(): Promise<void> {
    this.drafts.set(listDrafts());
    if (!this.targetId() || !this.floorId()) return this.sessions.set([]);
    try {
      this.sessions.set(await this.api.sessions(this.targetId(), this.floorId()));
    } catch {
      this.sessions.set([]);
    }
  }

  corridorLabel(id: string): string {
    return this.floor()?.corridors.find((c) => c.id === id)?.label || 'Corridor';
  }

  towardsLabel(corridorId: string, direction: string): string {
    const c = this.floor()?.corridors.find((x) => x.id === corridorId),
      f = this.floor();
    if (!c || !f) return '';
    return corridorEnds(c, direction === 'reverse' ? 'reverse' : 'forward', f.nodes, f.landmarks)
      .towards;
  }

  setupMapTap(p: XY): void {
    const f = this.floor();
    if (!f) return;
    const hit = nearestCorridor(f.corridors, p, 40 / (this.map()?.scale() || 1));
    if (hit) this.corridorId.set(hit.id);
  }

  setSpacing(value: string): void {
    const n = Number(value);
    if (Number.isFinite(n)) this.spacingM.set(Math.min(20, Math.max(0.5, n)));
  }

  /** Plans the points for the chosen corridor and direction and starts a session. */
  async startSession(): Promise<void> {
    const f = this.floor(),
      c = this.corridor();
    if (!f || !c || !this.targetId()) return;
    this.error.set('');
    this.busy.set('Planning capture points…');
    try {
      const plan = await this.api.plan({
        buildingId: f.buildingId,
        floorId: f.floorId,
        revision: f.revision,
        corridorId: c.id,
        direction: this.direction(),
        ...(f.scale.verified ? { spacingM: this.spacingM() } : {}),
      });
      const session: ActiveSession = {
        id: uuid(),
        mode: plan.mode,
        path: plan.path?.length ? plan.path : walkingPath(c, this.direction()),
        synced: false,
        body: {
          targetId: this.targetId(),
          mapBuildingId: f.buildingId,
          mapFloorId: f.floorId,
          mapRevision: plan.revision,
          corridorId: c.id,
          direction: this.direction(),
          spacingM: plan.mode === 'auto' ? (plan.spacingM ?? this.spacingM()) : null,
        },
      };
      const points = renumber(
        plan.points.map((p): CapturePoint => ({
          id: uuid(),
          order: p.order ?? 0,
          planId: p.planId,
          mapRevision: plan.revision,
          ...placement(p),
          plannedX: p.x,
          plannedY: p.y,
          confirmedX: null,
          confirmedY: null,
          positionSource: 'planned',
          reason: p.reason,
          nearby: p.nearby ?? [],
          synced: false,
        })),
      );
      this.enterSession(session, points, []);
      this.notice.set(
        plan.mode === 'manual'
          ? 'Manual placement: this floor has no verified scale, so only suggested points (start, end, junctions, turns) were placed. Use "Add point" and tap the corridor to add more.'
          : '',
      );
      await this.syncAll();
    } catch (e) {
      if (e instanceof HttpErrorResponse && e.status === 409) {
        this.error.set('The map changed since it was loaded. The floor was reloaded; try again.');
        await this.selectFloor(f.buildingId, f.floorId, this.targetId());
      } else this.error.set(requestError(e, 'The capture points could not be planned'));
    } finally {
      this.busy.set('');
    }
  }

  private enterSession(session: ActiveSession, points: CapturePoint[], photos: ServerPhoto[]) {
    this.session.set(session);
    this.points.set(points);
    this.serverPhotos.set(photos);
    this.phase.set('map');
    this.sheet.set('point');
    this.placing.set(false);
    const first = points.find((p) => this.progress().get(p.id)?.state !== 'complete') ?? points[0];
    this.selectedId.set(first?.id ?? '');
    this.persist();
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { session: session.id },
      replaceUrl: true,
    });
    setTimeout(() => this.map()?.fit());
  }

  /** Resumes a session from Django, else from the copy saved on this phone. */
  async resume(id: string): Promise<void> {
    this.error.set('');
    this.busy.set('Resuming the capture session…');
    const draft = loadDraft(id);
    let detail: SessionDetail | null = null;
    try {
      detail = await this.api.session(id);
    } catch (e) {
      if (!draft) {
        this.error.set(requestError(e, 'The session could not be resumed'));
        this.busy.set('');
        return;
      }
      this.notice.set(
        'Showing the copy of this session saved on this phone (the server is unreachable).',
      );
    }
    const body = detail
      ? {
          targetId: detail.targetId,
          mapBuildingId: detail.mapBuildingId,
          mapFloorId: detail.mapFloorId,
          mapRevision: detail.mapRevision,
          corridorId: detail.corridorId,
          direction: detail.direction,
          spacingM: detail.spacingM ?? null,
        }
      : draft!.session.body;
    if (!(await this.selectFloor(body.mapBuildingId, body.mapFloorId, body.targetId))) return;
    const f = this.floor()!;
    const c = f.corridors.find((x) => x.id === body.corridorId);
    this.corridorId.set(body.corridorId);
    this.direction.set(body.direction);
    if (detail && f.revision !== body.mapRevision) {
      try {
        await this.api.revisionCheck(id, f.revision);
        detail = await this.api.session(id);
        this.notice.set(
          `The floor map changed since this session was planned (revision ${body.mapRevision} → ${f.revision}). Points and photos from the older revision are marked "Needs review"; their positions are kept.`,
        );
      } catch {
        // Keep the stored state; the server re-checks on its own schedule.
      }
    }
    const fromServer = (detail?.points ?? []).map((p: ServerPoint): CapturePoint => ({
      ...p,
      nearby: nearbyLandmarks(f.landmarks, pointPosition({ ...p, nearby: [], synced: true })),
      synced: true,
    }));
    const local = (draft?.points ?? []).filter(
      (p) => !p.synced || !fromServer.some((s) => s.id === p.id),
    );
    const points = renumber([
      ...fromServer.filter((p) => !local.some((l) => l.id === p.id)),
      ...local,
    ]);
    const session: ActiveSession = {
      id,
      body,
      mode: draft?.session.mode ?? (f.scale.verified && body.spacingM !== null ? 'auto' : 'manual'),
      path: draft?.session.path ?? (c ? walkingPath(c, body.direction) : []),
      synced: !!detail || !!draft?.session.synced,
    };
    this.enterSession(session, points, detail?.photos ?? []);
    this.busy.set('');
    void this.syncAll();
  }

  backToSetup(): void {
    this.session.set(null);
    this.points.set([]);
    this.serverPhotos.set([]);
    this.selectedId.set('');
    this.capturing.set(false);
    this.phase.set('setup');
    this.notice.set('');
    void this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
    void this.loadSessions();
  }

  // Server sync -----------------------------------------------------------------------------

  private persist(): void {
    const s = this.session();
    if (!s) return;
    this.queue.updatePoints(s.id, new Map(this.points().map((p) => [p.id, pointBody(p)])));
    saveDraft({
      session: s,
      points: this.points(),
      corridorLabel: this.corridorLabel(s.body.corridorId),
      savedAt: new Date().toISOString(),
    });
  }

  /** PUTs the session, then every point not yet confirmed (idempotent, safe to repeat). */
  async syncAll(): Promise<void> {
    const s = this.session();
    if (!s) return;
    if (this.syncing) {
      this.resync = true;
      return;
    }
    this.syncing = true;
    try {
      if (!s.synced) {
        await this.api.putSession(s.id, s.body);
        this.queue.markSynced(`session:${s.id}`, s.body);
        this.session.update((x) => (x && x.id === s.id ? { ...x, synced: true } : x));
      }
      for (const p of this.points().filter((x) => !x.synced)) {
        const body = pointBody(p);
        try {
          await this.api.putPoint(s.id, p.id, body);
        } catch (e) {
          if (e instanceof HttpErrorResponse && e.status === 409) {
            this.syncError.set(
              `Point ${p.order} already has photos on the server, so its position cannot change. Add a new point instead.`,
            );
            continue;
          }
          throw e;
        }
        this.queue.markSynced(`point:${p.id}`, body);
        // Only mark synced if the point did not change while the request ran.
        this.points.update((list) =>
          list.map((x) =>
            x.id === p.id && JSON.stringify(pointBody(x)) === JSON.stringify(body)
              ? { ...x, synced: true }
              : x,
          ),
        );
      }
      if (!this.syncError().startsWith('Point ')) this.syncError.set('');
    } catch (e) {
      this.syncError.set(
        `${requestError(e, 'Not saved to the server yet')} Your changes are kept on this phone and are sent again automatically.`,
      );
    } finally {
      this.syncing = false;
      this.persist();
    }
    if (this.resync) {
      this.resync = false;
      return this.syncAll();
    }
  }

  private async refreshSession(): Promise<void> {
    const s = this.session();
    if (!s) return;
    try {
      const detail = await this.api.session(s.id);
      if (this.session()?.id !== s.id) return;
      this.serverPhotos.set(detail.photos ?? []);
      const byId = new Map(detail.points.map((p) => [p.id, p]));
      this.points.update((list) =>
        list.map((p) => {
          const server = byId.get(p.id);
          return server ? { ...p, status: server.status, reviewReason: server.reviewReason } : p;
        }),
      );
    } catch {
      // Keep the local state; the next confirmed upload refreshes again.
    }
  }

  private changePoints(update: (list: CapturePoint[]) => CapturePoint[]): void {
    const next = update(this.points());
    // Renumbering copies points whose `order` changed; those must be PUT again.
    this.points.set(renumber(next).map((p) => (next.includes(p) ? p : { ...p, synced: false })));
    this.persist();
    void this.syncAll();
  }

  // Map and sheet ---------------------------------------------------------------------------

  select(id: string): void {
    if (this.sheet() !== 'point') this.cancelEdit();
    this.selectedId.set(id);
    // Offer (never require) the four photos at a point that has none yet.
    this.photoPrompt.set(
      this.progress().get(id)?.hasPhotos || this.skippedPrompts.has(id) ? null : id,
    );
    const p = this.selected();
    if (p) this.map()?.centerOn(pointPosition(p), 1.5);
  }

  step(delta: number): void {
    const list = this.points(),
      i = list.findIndex((p) => p.id === this.selectedId());
    const next = list[Math.max(0, Math.min(list.length - 1, i + delta))];
    if (next) this.select(next.id);
  }

  mapTap(p: XY): void {
    if (this.phase() === 'setup') return this.setupMapTap(p);
    if (this.sheet() === 'adjust' || this.sheet() === 'add' || this.placing())
      void this.snapTo({ x: p.x, y: p.y });
  }

  /** "I'm at this point": the contributor stands on the planned (or adjusted) position. */
  confirmHere(): void {
    const p = this.selected();
    if (!p) return;
    const at = pointPosition(p);
    this.updatePoint(p.id, {
      confirmedX: at.x,
      confirmedY: at.y,
      positionSource: p.positionSource === 'planned' ? 'contributor-confirmed' : p.positionSource,
    });
  }

  private updatePoint(id: string, changes: Partial<CapturePoint>): void {
    this.changePoints((list) =>
      list.map((p) => (p.id === id ? { ...p, ...changes, synced: false } : p)),
    );
  }

  openAdjust(): void {
    const p = this.selected();
    if (!p || this.selectedProgress()?.hasPhotos) return;
    this.sheet.set('adjust');
    this.preview.set(null);
    this.adjustPx.set(p.corridorDistancePx);
  }

  /** "Add a new point here" / manual "Add point": choose a spot along the corridor. */
  openAdd(): void {
    const p = this.selected();
    this.sheet.set('add');
    this.preview.set(null);
    this.placing.set(true);
    this.adjustPx.set(p ? p.corridorDistancePx : 0);
    if (p) void this.snapTo({ corridorDistancePx: p.corridorDistancePx });
  }

  cancelEdit(): void {
    this.sheet.set('point');
    this.preview.set(null);
    this.placing.set(false);
  }

  onSlider(value: string): void {
    const px = Number(value);
    if (!Number.isFinite(px)) return;
    this.adjustPx.set(px);
    clearTimeout(this.snapTimer);
    this.snapTimer = setTimeout(() => void this.snapTo({ corridorDistancePx: px }), 120);
  }

  async snapTo(at: XY | { corridorDistancePx: number }): Promise<void> {
    const s = this.session(),
      f = this.floor();
    if (!s || !f) return;
    if (this.sheet() === 'point') this.sheet.set('add');
    const seq = ++this.snapSeq;
    try {
      const snapped = await this.api.snap({
        buildingId: f.buildingId,
        floorId: f.floorId,
        revision: f.revision,
        corridorId: s.body.corridorId,
        direction: s.body.direction,
        ...at,
      });
      if (seq !== this.snapSeq) return;
      this.preview.set(snapped);
      if (!('corridorDistancePx' in at)) this.adjustPx.set(snapped.corridorDistancePx);
      this.error.set('');
    } catch (e) {
      if (seq !== this.snapSeq) return;
      this.error.set(
        e instanceof HttpErrorResponse && e.status === 409
          ? 'The floor map changed since this session was opened. Tap "Change corridor" and resume the session to load the new map.'
          : requestError(e, 'That spot could not be placed on the corridor'),
      );
    }
  }

  saveAdjust(): void {
    const p = this.selected(),
      q = this.preview(),
      f = this.floor();
    if (!p || !q || !f || this.selectedProgress()?.hasPhotos) return;
    this.updatePoint(p.id, {
      ...placement(q),
      mapRevision: f.revision,
      confirmedX: q.x,
      confirmedY: q.y,
      positionSource: p.positionSource === 'manual' ? 'manual' : 'contributor-adjusted',
      nearby: q.nearby ?? [],
    });
    this.cancelEdit();
  }

  saveAdd(): void {
    const q = this.preview(),
      s = this.session(),
      f = this.floor();
    if (!q || !s || !f) return;
    const id = uuid();
    const point: CapturePoint = {
      id,
      order: 0,
      planId: null,
      mapRevision: f.revision,
      ...placement(q),
      plannedX: q.x,
      plannedY: q.y,
      confirmedX: null,
      confirmedY: null,
      positionSource: s.mode === 'manual' ? 'manual' : 'contributor-adjusted',
      reason: q.reason || 'adjusted',
      nearby: q.nearby ?? [],
      synced: false,
    };
    this.changePoints((list) => [...list, point]);
    this.cancelEdit();
    this.selectedId.set(id);
  }

  async removePoint(): Promise<void> {
    const p = this.selected(),
      s = this.session();
    if (!p || !s || this.selectedProgress()?.hasPhotos) return;
    this.error.set('');
    if (s.synced) {
      try {
        await this.api.deletePoint(s.id, p.id);
      } catch (e) {
        if (!(e instanceof HttpErrorResponse && e.status === 404)) {
          this.error.set(
            e instanceof HttpErrorResponse && e.status === 409
              ? 'This point already has photos on the server, so it cannot be removed.'
              : requestError(e, 'The point could not be removed'),
          );
          return;
        }
      }
    }
    const i = this.points().findIndex((x) => x.id === p.id);
    this.changePoints((list) => list.filter((x) => x.id !== p.id));
    this.selectedId.set(this.points()[Math.min(i, this.points().length - 1)]?.id ?? '');
  }

  // Capture ---------------------------------------------------------------------------------

  /** The point whose "take photos here?" offer is showing, if any. */
  readonly photoPrompt = signal<string | null>(null);
  /** Points where the contributor chose "Not now" (this visit only). */
  private readonly skippedPrompts = new Set<string>();

  /** "Take photos": confirms the position if needed, then opens the camera. Any slot can be skipped. */
  takePhotosHere(): void {
    const p = this.selected();
    if (!p) return;
    if (p.confirmedX === null) this.confirmHere();
    this.photoPrompt.set(null);
    this.startCapture();
  }

  skipPhotos(): void {
    const id = this.photoPrompt();
    if (id) this.skippedPrompts.add(id);
    this.photoPrompt.set(null);
  }

  startCapture(): void {
    const p = this.selected();
    if (!p || p.confirmedX === null) return;
    this.cancelEdit();
    this.capturing.set(true);
  }

  async onSaved(photo: SavedPhoto): Promise<void> {
    const p = this.selected(),
      s = this.session();
    if (!p || !s) return;
    try {
      await this.queue.add(photo.blob, {
        sessionId: s.id,
        pointId: p.id,
        session: s.body,
        point: pointBody(p),
        slot: photo.slot,
        viewingAngleDeg: photo.viewingAngleDeg,
        positionSource: p.positionSource,
        capturedAt: photo.capturedAt,
      });
    } catch (e) {
      this.error.set(requestError(e, 'The photo could not be saved'));
    }
  }

  retry(r: QueuedPhoto): void {
    this.queue.retry(r.id);
  }

  pos(p: CapturePoint): XY {
    return pointPosition(p);
  }

  reasonLabel(reason: string): string {
    return (
      {
        start: 'Start of the corridor',
        end: 'End of the corridor',
        spacing: 'Regular spacing',
        turn: 'Turn',
        junction: 'Junction',
        door: 'Doorway',
        adjusted: 'Placed by you',
      }[reason] ?? reason
    );
  }

  sourceLabel(p: CapturePoint): string {
    if (p.confirmedX === null)
      return p.positionSource === 'planned' ? 'Planned, not confirmed' : 'Placed, not confirmed';
    return {
      planned: 'Planned',
      'contributor-confirmed': 'Confirmed by you',
      'contributor-adjusted': 'Adjusted by you',
      manual: 'Placed by you',
    }[p.positionSource];
  }

  pointOrder(pointId: string): number {
    return this.points().find((p) => p.id === pointId)?.order ?? 0;
  }
}
