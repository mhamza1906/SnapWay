import { TestBed } from '@angular/core/testing';
import { MapDocument } from './prototype.models';
import {
  PrototypeRepository,
  PROTOTYPE_STORAGE,
  PROTOTYPE_STORAGE_KEY,
} from './prototype.repository';
import { createPrototypeSeed } from './prototype.seed';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  quotaReached = false;
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.quotaReached) throw new DOMException('Quota reached', 'QuotaExceededError');
    this.values.set(key, value);
  }
}

describe('PrototypeRepository', () => {
  let storage: MemoryStorage;
  let repository: PrototypeRepository;

  function reload(): PrototypeRepository {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PROTOTYPE_STORAGE, useValue: storage }],
    });
    return TestBed.inject(PrototypeRepository);
  }

  function draftDocument(): MapDocument {
    return structuredClone(repository.getContribution('innovation-draft')!.document);
  }

  beforeEach(() => {
    storage = new MemoryStorage();
    repository = reload();
  });

  it('persists a draft across reloads without mutating the publication or caller document', () => {
    const document = draftDocument();
    const original = repository.getTarget('innovation')!.published!;
    document.rooms[0].name = 'Updated studio';
    const saved = repository.saveDraft('innovation-draft', document, 1);
    document.rooms[0].name = 'Caller mutation';
    expect(saved.document.rooms[0].name).toBe('Updated studio');
    expect(original.document.rooms[0].name).toBe('Studio 101');
    expect(Object.isFrozen(saved.document.rooms[0])).toBe(true);
    expect(reload().getContribution('innovation-draft')!.document.rooms[0].name).toBe(
      'Updated studio',
    );
  });

  it('publishes a separate immutable revision and blocks stale submission', () => {
    const previous = repository.getTarget('innovation')!.published!;
    const merged = repository.review('innovation-review', 'publish', 'Verified');
    const published = repository.getTarget('innovation')!.published!;
    expect(published.version).toBe(4);
    expect(merged.status).toBe('merged');
    expect(published.document).not.toBe(merged.document);
    expect(previous.version).toBe(3);
    expect(previous.document.annotations).toHaveLength(2);
    expect(() => repository.submit('innovation-draft', 'My changes')).toThrow(/newer map/);
  });

  it('retains explicit draft changes during manual reconciliation and requires review again', () => {
    const document = draftDocument();
    document.rooms[0].name = 'My manual replacement';
    repository.saveDraft('innovation-draft', document);
    repository.review('innovation-review', 'publish', 'Verified');
    const reconciled = repository.rebase('innovation-draft');
    expect(reconciled.baseRevision).toBe(4);
    expect(reconciled.document.rooms[0].name).toBe('My manual replacement');
    expect(reconciled.status).toBe('draft');
    repository.submit('innovation-draft', 'Compared with revision 4');
    repository.review('innovation-draft', 'publish', 'Reconciled');
    expect(repository.getTarget('innovation')!.published!.version).toBe(5);
  });

  it('requires reviewer changes before editing submitted data', () => {
    const submitted = structuredClone(repository.getContribution('innovation-review')!.document);
    expect(() => repository.saveDraft('innovation-review', submitted)).toThrow(/read-only/);
    expect(() => repository.rebase('innovation-review')).toThrow(/read-only/);
    repository.review('innovation-review', 'changes-requested', 'Clarify the label');
    expect(repository.saveDraft('innovation-review', submitted).status).toBe('changes-requested');
  });

  it('blocks stale publication when another contribution publishes first', () => {
    repository.submit('innovation-draft', 'New room labels');
    repository.review('innovation-review', 'publish', 'First accepted');
    const before = repository.exportData();
    expect(() => repository.review('innovation-draft', 'publish', 'Second')).toThrow(/stale/);
    expect(repository.exportData()).toBe(before);
  });

  it('blocks administrator commands for the volunteer demo role', () => {
    repository.setRole('volunteer');
    expect(() => repository.archiveTarget('innovation', true)).toThrow(/administrator/);
    expect(() =>
      repository.createTarget({ name: 'Test', building: 'North', floor: '1', description: '' }),
    ).toThrow(/administrator/);
    expect(() => repository.review('innovation-review', 'publish', '')).toThrow(/administrator/);
    expect(repository.saveDraft('innovation-draft', draftDocument()).version).toBe(2);
  });

  it('blocks writes to archived targets including pending reviews', () => {
    expect(() => repository.startContribution('library')).toThrow(/archived/);
    repository.archiveTarget('innovation', true);
    expect(() => repository.saveDraft('innovation-draft', draftDocument())).toThrow(/archived/);
    expect(() => repository.review('innovation-review', 'publish', '')).toThrow(/archived/);
    repository.archiveTarget('innovation', false);
    expect(repository.saveDraft('innovation-draft', draftDocument()).version).toBe(2);
  });

  it('enforces ownership even for the administrator demo profile', () => {
    const data = createPrototypeSeed();
    data.contributions[0].author = 'Another contributor';
    repository.importData(JSON.stringify(data));
    expect(() => repository.saveDraft('innovation-draft', draftDocument())).toThrow(
      /owns this draft/,
    );
    expect(() => repository.submit('innovation-draft', 'Changes')).toThrow(/owns this draft/);
  });

  it('does not overwrite a newer draft revision', () => {
    repository.saveDraft('innovation-draft', draftDocument(), 1);
    const before = repository.exportData();
    expect(() => repository.saveDraft('innovation-draft', draftDocument(), 1)).toThrow(
      /changed since/,
    );
    expect(repository.exportData()).toBe(before);
  });

  it('keeps both memory and saved data intact when local storage quota is exhausted', () => {
    repository.saveDraft('innovation-draft', draftDocument());
    const before = repository.exportData();
    const storedBefore = storage.getItem(PROTOTYPE_STORAGE_KEY);
    storage.quotaReached = true;
    const document = draftDocument();
    document.rooms[0].name = 'Unsaved update';
    expect(() => repository.saveDraft('innovation-draft', document)).toThrow(/Could not save/);
    expect(repository.exportData()).toBe(before);
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe(storedBefore);
    expect(repository.storageError()).toContain('previous saved data is intact');
  });

  it('detects another tab changing the saved snapshot before a write', () => {
    repository.saveDraft('innovation-draft', draftDocument());
    const before = repository.exportData();
    const external = JSON.parse(before);
    external.profile.role = 'volunteer';
    storage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(external));
    expect(() => repository.saveDraft('innovation-draft', draftDocument())).toThrow(/another tab/);
    expect(repository.exportData()).toBe(before);
    expect(JSON.parse(storage.getItem(PROTOTYPE_STORAGE_KEY)!).profile.role).toBe('volunteer');
  });

  it('rejects unsupported, malformed or broken-reference imports atomically', () => {
    const before = repository.exportData();
    expect(() => repository.importData('{')).toThrow(/valid JSON/);
    expect(() => repository.importData(JSON.stringify({ schemaVersion: 2 }))).toThrow(
      /Unsupported/,
    );
    expect(() => repository.importData(JSON.stringify({ schemaVersion: 1 }))).toThrow(/Profile/);
    const data = createPrototypeSeed();
    data.contributions[0].document.edges[0].to = 'missing-waypoint';
    expect(() => repository.importData(JSON.stringify(data))).toThrow(/existing, different/);
    expect(repository.exportData()).toBe(before);
    expect(storage.length).toBe(0);
  });

  it('rejects unsafe images, duplicated IDs and dangling references', () => {
    const document = draftDocument();
    document.sourceImage = 'javascript:alert(1)';
    expect(() => repository.saveDraft('innovation-draft', document)).toThrow(/Source image/);
    delete document.sourceImage;
    document.rooms[1].id = document.rooms[0].id;
    expect(() => repository.saveDraft('innovation-draft', document)).toThrow(/duplicate IDs/);
    const references = draftDocument();
    references.references.push({
      id: 'ref-one',
      name: 'Entry',
      image: '/demo/floor-plan.svg',
      nodeId: 'missing',
      direction: 'North',
      description: '',
      reviewed: false,
      createdAt: new Date().toISOString(),
    });
    expect(() => repository.saveDraft('innovation-draft', references)).toThrow(/existing waypoint/);
  });

  it('requires reviewed scene references and connected room waypoints for publication', () => {
    const document = draftDocument();
    document.references.push({
      id: 'ref-one',
      name: 'Entry',
      image: '/demo/floor-plan.svg',
      nodeId: 'entrance',
      direction: 'East',
      description: '',
      reviewed: false,
      createdAt: new Date().toISOString(),
    });
    repository.saveDraft('innovation-draft', document);
    repository.submit('innovation-draft', 'Reference added');
    expect(() => repository.review('innovation-draft', 'publish', '')).toThrow(
      /Review every scene/,
    );
    repository.review('innovation-draft', 'changes-requested', 'Review reference and routes');
    document.references[0].reviewed = true;
    document.edges = document.edges.filter((edge) => edge.to !== 'node-r106');
    repository.saveDraft('innovation-draft', document);
    repository.submit('innovation-draft', 'Reference reviewed');
    expect(() => repository.review('innovation-draft', 'publish', '')).toThrow(/Connect all room/);
  });

  it('bounds activity history and round trips valid exports', () => {
    for (let count = 0; count < 25; count++) repository.setRole(count % 2 ? 'admin' : 'volunteer');
    expect(repository.activity()).toHaveLength(20);
    const exported = repository.exportData();
    repository.resetDemo();
    repository.importData(exported);
    expect(repository.activity()).toHaveLength(20);
    expect(repository.profile().role).toBe('volunteer');
    expect(reload().profile().role).toBe('volunteer');
  });

  it('recovers invalid stored data without silently replacing the original bytes', () => {
    storage.setItem(PROTOTYPE_STORAGE_KEY, '{broken');
    repository = reload();
    expect(repository.storageError()).toContain('could not be loaded');
    expect(storage.getItem(PROTOTYPE_STORAGE_KEY)).toBe('{broken');
    repository.resetDemo();
    expect(repository.storageError()).toBe('');
    expect(reload().getTarget('innovation')!.published!.version).toBe(3);
  });

  it('retains immutable publication history across reload and accepts older exports', () => {
    const older = createPrototypeSeed();
    older.targets.forEach((target) => delete target.revisions);
    repository.importData(JSON.stringify(older));
    repository.review('innovation-review', 'publish', 'Approved');
    const history = reload().getTarget('innovation')!.revisions!;
    expect(history.map((revision) => revision.version)).toEqual([3, 4]);
    expect(history[0].document.annotations).toHaveLength(2);
    expect(history[1].document.annotations).toHaveLength(3);
    expect(Object.isFrozen(history[0].document.annotations)).toBe(true);
  });

  it('rejects imported history whose latest document differs from the published map', () => {
    const data = createPrototypeSeed();
    data.targets[0].revisions![0].document.rooms[0].name = 'Different history';
    const before = repository.exportData();
    expect(() => repository.importData(JSON.stringify(data))).toThrow(/latest retained revision/);
    expect(repository.exportData()).toBe(before);
  });

  it('receives valid publications from another tab while preserving held snapshots', () => {
    const pinned = repository.getTarget('innovation')!.published!;
    const external = createPrototypeSeed();
    const publication = external.targets[0].published!;
    publication.version = 4;
    publication.document.annotations.push({
      id: 'external-pin',
      x: 100,
      y: 320,
      text: 'New checkpoint',
      type: 'pin',
    });
    external.targets[0].revisions!.push(structuredClone(publication));
    storage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(external));
    globalThis.dispatchEvent(
      new StorageEvent('storage', {
        key: PROTOTYPE_STORAGE_KEY,
        newValue: JSON.stringify(external),
      }),
    );
    expect(repository.getTarget('innovation')!.published!.version).toBe(4);
    expect(pinned.version).toBe(3);
    expect(pinned.document.annotations).toHaveLength(2);
    expect(repository.storageError()).toBe('');
  });

  it('does not overwrite unsaved editor data after another tab updates its contribution', () => {
    const localDraft = draftDocument();
    localDraft.rooms[0].name = 'Unsaved local change';
    const external = createPrototypeSeed();
    external.contributions[0].version = 2;
    external.contributions[0].document.rooms[0].name = 'Saved from another tab';
    storage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(external));
    globalThis.dispatchEvent(new StorageEvent('storage', { key: PROTOTYPE_STORAGE_KEY }));
    expect(localDraft.rooms[0].name).toBe('Unsaved local change');
    expect(repository.getContribution('innovation-draft')!.document.rooms[0].name).toBe(
      'Saved from another tab',
    );
    expect(() => repository.saveDraft('innovation-draft', localDraft, 1)).toThrow(/changed since/);
  });

  it('keeps the last valid snapshot when another tab corrupts or clears storage', () => {
    repository.setRole('volunteer');
    const before = repository.exportData();
    storage.setItem(PROTOTYPE_STORAGE_KEY, '{broken');
    globalThis.dispatchEvent(new StorageEvent('storage', { key: PROTOTYPE_STORAGE_KEY }));
    expect(repository.exportData()).toBe(before);
    expect(repository.storageError()).toContain('last valid snapshot');
    storage.clear();
    globalThis.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(repository.exportData()).toBe(before);
    expect(repository.storageError()).toContain('cleared in another tab');
  });
});
