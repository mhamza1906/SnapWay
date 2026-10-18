import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { GraphApiService, NodePhoto } from '../../core/graph-api.service';
import { vi } from 'vitest';
import { GraphEditorPage } from './graph-editor';

describe('GraphEditorPage', () => {
  let fixture: ComponentFixture<GraphEditorPage>;
  const api = {
    listDrafts: vi.fn(async () => ({ drafts: [] })),
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
    await TestBed.configureTestingModule({
      imports: [GraphEditorPage],
      providers: [provideRouter([]), { provide: GraphApiService, useValue: api }],
    }).compileComponents();
    fixture = TestBed.createComponent(GraphEditorPage);
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
      expect(api.uploadNodePhoto).toHaveBeenLastCalledWith('r1', 'n1', expect.any(File), direction);
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
