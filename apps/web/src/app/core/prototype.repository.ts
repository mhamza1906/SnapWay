import { computed, DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';
import {
  Activity,
  Contribution,
  DemoRole,
  MapDocument,
  MappingTarget,
  PrototypeState,
} from './prototype.models';
import { createPrototypeSeed } from './prototype.seed';
import {
  validateMapDocument,
  validatePrototypeState,
  validatePublication,
} from './prototype.validation';

export const PROTOTYPE_STORAGE_KEY = 'snapway.prototype.v1';
export const MAX_PROTOTYPE_IMPORT_BYTES = 8_000_000;
export const PROTOTYPE_STORAGE = new InjectionToken<Storage | null>('Prototype browser storage', {
  providedIn: 'root',
  factory: () => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  },
});

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function emptyDocument(): MapDocument {
  return { rooms: [], nodes: [], edges: [], annotations: [], references: [] };
}

/** Local-only API seam. Replace persistence/commands here when the server contract lands. */
@Injectable({ providedIn: 'root' })
export class PrototypeRepository {
  private readonly storage = inject(PROTOTYPE_STORAGE);
  private readonly destroyRef = inject(DestroyRef);
  private readonly current = signal<PrototypeState>(freeze(createPrototypeSeed()));
  private readonly error = signal('');
  private persistedValue: string | null = null;
  readonly state = this.current.asReadonly();
  readonly storageError = this.error.asReadonly();
  readonly targets = computed(() => this.state().targets);
  readonly contributions = computed(() => this.state().contributions);
  readonly activity = computed(() => this.state().activity);
  readonly profile = computed(() => this.state().profile);

  constructor() {
    const storageChanged = (event: StorageEvent): void => this.receiveStorageChange(event);
    globalThis.addEventListener('storage', storageChanged);
    this.destroyRef.onDestroy(() => globalThis.removeEventListener('storage', storageChanged));
    if (!this.storage) {
      this.error.set(
        'Browser storage is unavailable. Enable local storage to save prototype changes.',
      );
      return;
    }
    try {
      this.persistedValue = this.storage.getItem(PROTOTYPE_STORAGE_KEY);
      if (this.persistedValue)
        this.current.set(freeze(validatePrototypeState(JSON.parse(this.persistedValue))));
    } catch {
      this.error.set(
        'Stored prototype data could not be loaded. Export a backup if needed, then import a valid export or reset the demo.',
      );
    }
  }

  getTarget(id: string): MappingTarget | undefined {
    return this.targets().find((target) => target.id === id);
  }
  getContribution(id: string): Contribution | undefined {
    return this.contributions().find((contribution) => contribution.id === id);
  }

  setRole(role: DemoRole): void {
    if (role !== 'admin' && role !== 'volunteer')
      throw new Error('Choose an administrator or volunteer demo role.');
    const next = this.copy();
    next.profile.role = role;
    this.record(
      next,
      'Demo role changed',
      `Previewing the ${role} workflow. This is not real authentication.`,
    );
    this.persist(next);
  }

  createTarget(
    input: Pick<MappingTarget, 'name' | 'building' | 'floor' | 'description'>,
  ): MappingTarget {
    this.requireAdmin();
    const next = this.copy();
    const target: MappingTarget = {
      id: this.id('target'),
      name: input.name.trim(),
      building: input.building.trim(),
      floor: input.floor.trim(),
      description: input.description.trim(),
      status: 'open',
      updatedAt: this.now(),
      published: null,
    };
    next.targets.unshift(target);
    this.record(next, 'Mapping target created', `${target.name} · ${target.floor}`, target.id);
    this.persist(next);
    return this.getTarget(target.id)!;
  }

  archiveTarget(id: string, archived: boolean): void {
    this.requireAdmin();
    const next = this.copy();
    const target = this.target(next, id);
    target.status = archived ? 'archived' : 'open';
    target.updatedAt = this.now();
    this.record(
      next,
      archived ? 'Mapping target archived' : 'Mapping target reopened',
      target.name,
      id,
    );
    this.persist(next);
  }

  startContribution(targetId: string): Contribution {
    const next = this.copy();
    const target = this.target(next, targetId, true);
    const contribution: Contribution = {
      id: this.id('contribution'),
      targetId,
      title: `${target.name} update`,
      author: next.profile.name,
      baseRevision: target.published?.version ?? 0,
      status: 'draft',
      document: structuredClone(target.published?.document ?? emptyDocument()),
      summary: '',
      feedback: '',
      version: 1,
      updatedAt: this.now(),
    };
    next.contributions.unshift(contribution);
    this.record(next, 'Contribution started', contribution.title, targetId);
    this.persist(next);
    return this.getContribution(contribution.id)!;
  }

  saveDraft(id: string, document: MapDocument, expectedVersion?: number): Contribution {
    const next = this.copy();
    const contribution = this.editable(next, id);
    if (expectedVersion !== undefined && contribution.version !== expectedVersion)
      throw new Error(
        'This draft changed since you opened it. Reload the draft before saving to avoid overwriting newer changes.',
      );
    contribution.document = validateMapDocument(document);
    contribution.version += 1;
    contribution.updatedAt = this.now();
    this.record(
      next,
      'Draft saved',
      `${contribution.title} · draft revision ${contribution.version}`,
      contribution.targetId,
    );
    this.persist(next);
    return this.getContribution(id)!;
  }

  submit(id: string, summary: string): Contribution {
    const next = this.copy();
    const contribution = this.editable(next, id);
    if (!summary.trim()) throw new Error('Add a short summary so reviewers know what changed.');
    if (!contribution.document.rooms.length)
      throw new Error('Add at least one room before submitting the map for review.');
    const target = this.target(next, contribution.targetId);
    if (contribution.baseRevision !== (target.published?.version ?? 0))
      throw new Error(
        'A newer map has been published. Compare and reconcile your draft with the latest revision before submitting.',
      );
    contribution.status = 'submitted';
    contribution.summary = summary.trim();
    contribution.feedback = '';
    contribution.version += 1;
    contribution.updatedAt = this.now();
    this.record(next, 'Contribution submitted', contribution.summary, contribution.targetId);
    this.persist(next);
    return this.getContribution(id)!;
  }

  review(
    id: string,
    decision: 'publish' | 'changes-requested' | 'rejected',
    feedback: string,
  ): Contribution {
    this.requireAdmin();
    if (!['publish', 'changes-requested', 'rejected'].includes(decision))
      throw new Error('Choose a supported review decision.');
    const next = this.copy();
    const contribution = this.contribution(next, id);
    const target = this.target(next, contribution.targetId, true);
    if (contribution.status !== 'submitted')
      throw new Error('Only submitted contributions can be reviewed.');
    if (decision !== 'publish' && !feedback.trim())
      throw new Error('Add review feedback so the contributor understands the decision.');
    if (decision === 'publish') {
      if (contribution.baseRevision !== (target.published?.version ?? 0))
        throw new Error(
          'This contribution is stale. Request changes and compare it with the latest publication before publishing.',
        );
      validatePublication(contribution.document);
      const history = target.revisions ?? (target.published ? [target.published] : []);
      target.published = {
        version: (target.published?.version ?? 0) + 1,
        document: structuredClone(contribution.document),
        publishedAt: this.now(),
        author: next.profile.name,
      };
      target.revisions = [...history, structuredClone(target.published)].slice(-20);
      target.updatedAt = this.now();
      contribution.status = 'merged';
    } else {
      contribution.status = decision;
    }
    contribution.feedback = feedback.trim();
    contribution.version += 1;
    contribution.updatedAt = this.now();
    this.record(
      next,
      decision === 'publish'
        ? 'Map revision published'
        : decision === 'changes-requested'
          ? 'Changes requested'
          : 'Contribution rejected',
      decision === 'publish'
        ? `${target.name} · revision ${target.published!.version}`
        : contribution.feedback,
      target.id,
    );
    this.persist(next);
    return this.getContribution(id)!;
  }

  /** Caller must show the latest map for comparison and obtain explicit reconciliation. */
  rebase(id: string): Contribution {
    const next = this.copy();
    const contribution = this.editable(next, id);
    const target = this.target(next, contribution.targetId);
    contribution.baseRevision = target.published?.version ?? 0;
    contribution.status = 'draft';
    contribution.version += 1;
    contribution.updatedAt = this.now();
    this.record(
      next,
      'Draft manually reconciled',
      `Manually reconciled against v${contribution.baseRevision}; draft geometry retained for explicit replacement after review.`,
      target.id,
    );
    this.persist(next);
    return this.getContribution(id)!;
  }

  resetDemo(): void {
    this.persist(createPrototypeSeed());
  }
  exportData(): string {
    return JSON.stringify(this.state(), null, 2);
  }

  importData(json: string): void {
    if (new TextEncoder().encode(json).byteLength > MAX_PROTOTYPE_IMPORT_BYTES)
      throw new Error('This export is too large. Keep prototype imports below 8 MB.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('Choose a valid JSON export from this SnapWay prototype.');
    }
    const next = validatePrototypeState(parsed);
    this.record(next, 'Prototype data imported', 'Validated local export restored.');
    this.persist(next);
  }

  private copy(): PrototypeState {
    return structuredClone(this.state());
  }
  private now(): string {
    return new Date().toISOString();
  }
  private id(prefix: string): string {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  private requireAdmin(): void {
    if (this.profile().role !== 'admin')
      throw new Error('Switch to the administrator demo role to perform this action.');
  }
  private target(state: PrototypeState, id: string, writable = false): MappingTarget {
    const target = state.targets.find((item) => item.id === id);
    if (!target) throw new Error('This mapping target could not be found.');
    if (writable && target.status === 'archived')
      throw new Error(
        'This target is archived. Ask an administrator to reopen it before making changes.',
      );
    return target;
  }
  private contribution(state: PrototypeState, id: string): Contribution {
    const contribution = state.contributions.find((item) => item.id === id);
    if (!contribution) throw new Error('This contribution could not be found.');
    return contribution;
  }
  private editable(state: PrototypeState, id: string): Contribution {
    const contribution = this.contribution(state, id);
    this.target(state, contribution.targetId, true);
    if (contribution.author !== state.profile.name)
      throw new Error('Only the contributor who owns this draft can edit it.');
    if (!['draft', 'changes-requested'].includes(contribution.status))
      throw new Error(
        'This contribution is read-only. Submitted contributions can be edited after a reviewer requests changes.',
      );
    return contribution;
  }
  private record(state: PrototypeState, title: string, detail: string, targetId?: string): void {
    const activity: Activity = {
      id: this.id('activity'),
      title,
      detail: detail.slice(0, 1000),
      at: this.now(),
      ...(targetId ? { targetId } : {}),
    };
    state.activity = [activity, ...state.activity].slice(0, 20);
  }
  private persist(value: PrototypeState): void {
    const next = validatePrototypeState(value);
    try {
      if (!this.storage)
        throw new Error(
          'Browser storage is unavailable. Enable local storage to save prototype changes.',
        );
      if (this.storage.getItem(PROTOTYPE_STORAGE_KEY) !== this.persistedValue)
        throw new Error(
          'Prototype data changed in another tab. Reload this page before saving so those changes are preserved.',
        );
      const serialized = JSON.stringify(next);
      this.storage.setItem(PROTOTYPE_STORAGE_KEY, serialized);
      this.persistedValue = serialized;
    } catch (error) {
      const message =
        error instanceof Error && error.message.includes('another tab')
          ? error.message
          : 'Could not save to browser storage. Your previous saved data is intact; try a smaller image or export and reset the demo.';
      this.error.set(message);
      throw new Error(message);
    }
    this.current.set(freeze(next));
    this.error.set('');
  }

  private receiveStorageChange(event: StorageEvent): void {
    if (!this.storage || (event.key !== PROTOTYPE_STORAGE_KEY && event.key !== null)) return;
    if (event.storageArea && event.storageArea !== this.storage) return;
    try {
      const serialized = this.storage.getItem(PROTOTYPE_STORAGE_KEY);
      if (serialized === this.persistedValue) return;
      if (serialized === null) {
        this.error.set(
          'Prototype storage was cleared in another tab. Export this session if needed, then reload to start fresh.',
        );
        return;
      }
      // Read the current stored value: delayed events must not roll state back to an old value.
      const next = validatePrototypeState(JSON.parse(serialized));
      this.persistedValue = serialized;
      this.current.set(freeze(next));
      this.error.set('');
    } catch {
      this.error.set(
        'Another tab saved invalid or unreadable prototype data. This session has kept its last valid snapshot.',
      );
    }
  }
}
