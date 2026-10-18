import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component, output } from '@angular/core';
import { By } from '@angular/platform-browser';
import { VisitorCamera } from '../visitor/visitor-camera';
import type { MatchResult } from '../../core/place-match';
import { provideRouter } from '@angular/router';
import { GraphApiService, NodePhoto } from '../../core/graph-api.service';
import { vi } from 'vitest';
import { PhotoWalkEditorPage } from './photo-walk-editor';

@Component({ selector: 'app-visitor-camera', template: '' })
class PreviewCamera {
  readonly closed = output<void>();
  readonly matched = output<MatchResult>();
  readonly liveMatched = output<MatchResult>();
}

describe('PhotoWalkEditorPage', () => {
  let fixture: ComponentFixture<PhotoWalkEditorPage>;
  const api = {
    listDrafts: vi.fn(async () => ({ drafts: [] })),
    getIndexStatus:
      vi.fn<
        (
          ...args: string[]
        ) => Promise<{ state: string | null; asset_id?: string; profile?: Record<string, unknown> }>
      >(),
    listNodePhotos: vi.fn<(...args: string[]) => Promise<{ photos: NodePhoto[] }>>(),
    uploadNodePhoto: vi.fn<(...args: unknown[]) => Promise<NodePhoto>>(),
    me: async () => ({ authenticated: true, email: 'a@b.c' }),
    ensureDraft: async () => ({
      target_id: 't1',
      contribution_id: 'c1',
      revision_id: 'r1',
      coordinate_frame: { width: 1000, height: 640 },
      underlay_url: null,
    }),
    getGraph: async () => ({
      revision_id: 'r1',
      coordinate_frame: { width: 1000, height: 640 },
      underlay_url: null,
      nodes: [],
      edges: [],
    }),
    addNode: async () => ({ id: 'n1', x: 1, y: 2, label: '', kind: 'checkpoint' }),
    removeNode: async () => undefined,
    addEdge: async () => ({ id: 'e1', from_node_id: 'n1', to_node_id: 'n2', cost: 1 }),
    removeEdge: async () => undefined,
    uploadUnderlay: async () => ({
      underlay_url: '/media/x.png',
      coordinate_frame: { width: 1000, height: 640 },
    }),
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    api.listNodePhotos.mockReset().mockResolvedValue({ photos: [] });
    api.uploadNodePhoto.mockReset();
    api.getIndexStatus.mockReset().mockResolvedValue({ state: null });
    await TestBed.configureTestingModule({
      imports: [PhotoWalkEditorPage],
      providers: [provideRouter([]), { provide: GraphApiService, useValue: api }],
    })
      .overrideComponent(PhotoWalkEditorPage, {
        remove: { imports: [VisitorCamera] },
        add: { imports: [PreviewCamera] },
      })
      .compileComponents();
    fixture = TestBed.createComponent(PhotoWalkEditorPage);
  });

  it('ensures draft and loads graph when authenticated', async () => {
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    expect(fixture.componentInstance.revisionId()).toBe('r1');
    expect(fixture.nativeElement.textContent).toContain('Graph editor');
    expect(fixture.nativeElement.textContent).toContain('Auto-saves');
  });

  const photo = (
    direction: 'front' | 'right' | 'back' | 'left',
    id: string = direction,
  ): NodePhoto => ({
    id,
    asset_id: id,
    direction,
    url: '/test-image.png',
    content_type: 'image/png',
    byte_size: 12,
    status: 'proposed',
  });
  const picked = () =>
    ({
      target: {
        files: [new File(['test'], 'photo.png', { type: 'image/png' })],
        value: 'photo.png',
      },
    }) as unknown as Event;
  async function selectPoint() {
    const page = fixture.componentInstance;
    fixture.detectChanges();
    await vi.waitFor(() => expect(page.status()).toContain('Auto-saves'));
    page.setTool('select');
    await page.onNodeClick('n1');
    expect(page.revisionId()).toBe('r1');
    expect(page.selectedNodeId()).toBe('n1');
    expect(page.photosLoading()).toBe(false);
    return page;
  }

  it('uploads four named views, counts completion and replaces just one direction', async () => {
    const page = await selectPoint();
    for (const direction of ['front', 'right', 'back', 'left'] as const) {
      api.uploadNodePhoto.mockResolvedValueOnce(photo(direction));
      await page.onDirectionPicked(picked(), direction);
      expect(api.uploadNodePhoto).toHaveBeenLastCalledWith(
        'r1',
        'n1',
        expect.any(File),
        direction,
        'walking_relative',
      );
    }
    expect(page.directionCount()).toBe(4);
    api.uploadNodePhoto.mockResolvedValueOnce(photo('front', 'replacement'));
    await page.onDirectionPicked(picked(), 'front');
    expect(page.photos()).toHaveLength(4);
    expect(page.photoFor('front')?.id).toBe('replacement');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Point photos (4/4)');
  });

  it('keeps the old view when R2 rejects an upload', async () => {
    const page = await selectPoint();
    page.photos.set([photo('front')]);
    api.uploadNodePhoto.mockRejectedValueOnce({ error: { detail: 'Could not save to R2' } });
    await page.onDirectionPicked(picked(), 'front');
    expect(page.photoFor('front')?.id).toBe('front');
    expect(page.error()).toBe('Could not save to R2');
    expect(page.photoUploading()).toBe(false);
  });

  it('does not show a completed upload on a different selected point', async () => {
    const page = await selectPoint();
    let finish!: (value: NodePhoto) => void;
    api.uploadNodePhoto.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const uploading = page.onDirectionPicked(picked(), 'front');
    await page.onNodeClick('n2');
    finish(photo('front'));
    await uploading;
    expect(page.photos()).toEqual([]);
    expect(page.selectedNodeId()).toBe('n2');
  });

  it('ignores photo lists that arrive after another point is selected', async () => {
    const page = await selectPoint();
    let finish!: (value: { photos: NodePhoto[] }) => void;
    api.listNodePhotos.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = page.onNodeClick('n1');
    await page.onNodeClick('n2');
    finish({ photos: [photo('left')] });
    await first;
    expect(page.photos()).toEqual([]);
    expect(page.photosLoading()).toBe(false);
  });

  it('phone collection sorts numbered stops, skips path vertices and hides editing controls', async () => {
    const page = await selectPoint();
    page.nodes.set([
      { id: 'n10', x: 10, y: 0, label: 'Point 10', kind: 'checkpoint' },
      { id: 'bend', x: 5, y: 0, label: 'Path junction / bend', kind: 'junction' },
      { id: 'n2', x: 2, y: 0, label: 'Point 2', kind: 'junction' },
    ]);
    await page.setPhotoMode(true);
    expect(page.capturePoints().map((p) => p.id)).toEqual(['n2', 'n10']);
    expect(page.selectedNodeId()).toBe('n2');
    await page.onNodeClick('bend');
    expect(page.selectedNodeId()).toBe('n2');
    await page.movePoint(1);
    expect(page.selectedNodeId()).toBe('n10');
    page.onKey(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(page.nodes()).toHaveLength(3);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Collect reference photos');
    expect(fixture.nativeElement.querySelector('[aria-label="Graph tools"]')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.walk-camera input')).toHaveLength(4);
  });

  it('keeps a phone photo pending until cloud storage accepts it', async () => {
    const page = await selectPoint();
    page.nodes.set([{ id: 'n1', x: 1, y: 2, label: 'Point 1', kind: 'checkpoint' }]);
    await page.setPhotoMode(true);
    page.cloudReady.set(false);
    vi.spyOn(page.phoneQueue, 'prepare').mockResolvedValue(
      new File(['jpeg'], 'p.jpg', { type: 'image/jpeg' }),
    );
    await page.onDirectionPicked(picked(), 'front');
    expect(page.pendingPhotos()).toHaveLength(1);
    expect(page.uploadedViews()).toBe(0);
    expect(api.uploadNodePhoto).not.toHaveBeenCalled();
    const graph = vi.spyOn(api, 'getGraph').mockResolvedValue({
      revision_id: 'r1',
      coordinate_frame: { width: 1000, height: 640 },
      underlay_url: null,
      nodes: page.nodes(),
      edges: [],
    } as never);
    api.uploadNodePhoto.mockRejectedValueOnce(new Error('Network unavailable'));
    await page.retryPending();
    expect(page.pendingPhotos()).toHaveLength(1);
    api.uploadNodePhoto.mockResolvedValueOnce(photo('front'));
    await page.retryPending();
    expect(graph).toHaveBeenCalled();
    expect(page.pendingPhotos()).toHaveLength(0);
    expect(page.uploadedViews()).toBe(1);
  });

  it('does not open a camera or enable testing without a ready saved index', async () => {
    const page = await selectPoint();
    fixture.detectChanges();
    expect(api.getIndexStatus).toHaveBeenCalledWith('r1');
    expect(fixture.nativeElement.querySelector('app-visitor-camera')).toBeNull();
    const action = fixture.nativeElement.querySelector(
      '[data-testid="test-live-matching"]',
    ) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    page.openLiveTest();
    expect(page.liveCameraOpen()).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('No ready reference index');
  });

  async function readyPreview() {
    const page = await selectPoint();
    api.getIndexStatus.mockResolvedValue({
      state: 'ready',
      asset_id: 'index-asset',
      profile: { n_references: 104 },
    });
    await page.refreshIndexStatus();
    page.nodes.set([
      { id: 'n1', x: 1, y: 2, label: 'Point 1', kind: 'checkpoint' },
      { id: 'n2', x: 3, y: 4, label: 'Point 2', kind: 'checkpoint' },
    ]);
    fixture.detectChanges();
    return page;
  }
  const match = (
    outcome: 'likely_match' | 'uncertain' = 'likely_match',
    revision = 'r1',
  ): MatchResult => ({
    node_id: 'n2',
    revision_id: revision,
    matched_node: {
      node_id: 'n2',
      stable_id: 'stable2',
      revision_id: revision,
      target_id: 't1',
      label: 'Server label',
      kind: 'checkpoint',
      floor_id: 'floor',
      floor_name: 'Level 1',
      building_id: 'building',
      building_name: 'Sam',
    },
    reference_set: '',
    decision: { outcome, reference_id: 'reference', location_id: 'n2', reasons: [] },
    candidates: [],
    candidates_backend: 'megaloc',
    backend_used: 'megaloc',
    fallback_used: false,
    second_opinion_used: false,
    thresholds_id: 'calibration',
    timings_ms: {},
  });

  it('opens ready-index testing only on request and highlights a supported node without editing it', async () => {
    const page = await readyPreview();
    expect(fixture.nativeElement.textContent).toContain('104 reference photos');
    expect(page.liveCameraOpen()).toBe(false);
    const before = page.nodes();
    (
      fixture.nativeElement.querySelector('[data-testid="test-live-matching"]') as HTMLButtonElement
    ).click();
    fixture.detectChanges();
    const camera = fixture.debugElement.query(By.directive(PreviewCamera))
      .componentInstance as PreviewCamera;
    camera.liveMatched.emit(match());
    await vi.waitFor(() => expect(page.selectedNodeId()).toBe('n2'));
    expect(page.liveMatchStatus()).toContain('Point 2');
    const positions = (nodes: typeof before) =>
      nodes.map(({ id, label, x, y }) => ({ id, label, x, y }));
    expect(positions(page.nodes())).toEqual(positions(before));
    expect(page.liveCameraOpen()).toBe(true);
    camera.closed.emit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-visitor-camera')).toBeNull();
  });

  it('ignores uncertain and other-revision matches and closes after a single match', async () => {
    const page = await readyPreview();
    page.openLiveTest();
    await page.acceptLiveMatch(match('uncertain'));
    expect(page.selectedNodeId()).toBe('n1');
    await page.acceptLiveMatch(match('likely_match', 'other-revision'));
    expect(page.selectedNodeId()).toBe('n1');
    expect(page.liveMatchStatus()).toContain('another saved map');
    await page.acceptSingleMatch(match());
    expect(page.selectedNodeId()).toBe('n2');
    expect(page.liveCameraOpen()).toBe(false);
    await page.acceptLiveMatch({ ...match(), node_id: 'n1' });
    expect(page.selectedNodeId()).toBe('n2');
  });

  it('keeps uploaded and queued photo locations visible after an adaptive replan', () => {
    const page = fixture.componentInstance;
    page.revisionId.set('r1');
    page.nodes.set([
      { id: 'active', x: 0, y: 0, label: 'Point 1', kind: 'checkpoint' },
      { id: 'path', x: 1, y: 0, label: 'Path junction / bend', kind: 'junction' },
      {
        id: 'uploaded',
        x: 2,
        y: 0,
        label: 'Path junction / bend',
        kind: 'junction',
        photo_directions: ['front'],
      },
      { id: 'queued', x: 3, y: 0, label: 'Path junction / bend', kind: 'junction' },
    ]);
    page.phoneQueue.items.set([
      {
        id: 'pending',
        owner: 'a@b.c',
        revisionId: 'r1',
        nodeId: 'queued',
        direction: 'right',
        blob: new Blob(['image']),
        filename: 'queued.jpg',
      },
    ]);
    expect(new Set(page.capturePoints().map((node) => node.id))).toEqual(
      new Set(['active', 'uploaded', 'queued']),
    );
    expect(page.uploadedViews()).toBe(1);
  });
});
