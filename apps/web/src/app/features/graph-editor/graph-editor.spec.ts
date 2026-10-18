import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { WorkspaceApi } from '../../core/workspace-api.service';
import { provideRouter } from '@angular/router';
import { GraphApiService } from '../../core/graph-api.service';
import { GraphEditorPage, MAP3D_SCENES } from './graph-editor';

describe('GraphEditorPage', () => {
  let fixture: ComponentFixture<GraphEditorPage>;
  const api = {
    pending: () => 0,
    me: async () => ({ authenticated: true, email: 'a@b.c' }),
    ensureDraft: async () => ({
      target_id: 't1',
      contribution_id: 'c1',
      revision_id: 'r1',
      coordinate_frame: { width: 1000, height: 640 },
      underlay_url: null,
    }),
    getGraph: async () => ({
      lock_version: 1,
      revision_id: 'r1',
      coordinate_frame: { width: 1000, height: 640 },
      underlay_url: null,
      nodes: [],
      edges: [],
    }),
    editGraph: async (
      _revision: string,
      version: number,
      command: { create_nodes?: { id?: string; x: number; y: number }[] },
    ) => ({
      lock_version: version + 1,
      revision_id: 'r1',
      coordinate_frame: { width: 1000, height: 640 },
      underlay_url: null,
      nodes: (command.create_nodes || []).map((n) => ({
        id: n.id || 'n1',
        x: n.x,
        y: n.y,
        label: '',
        kind: 'checkpoint',
      })),
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
    await TestBed.configureTestingModule({
      imports: [GraphEditorPage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ target: 't1' }) } },
        },
        { provide: WorkspaceApi, useValue: { edit: api.ensureDraft } },
        { provide: GraphApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(GraphEditorPage);
  });

  it('ensures draft and loads graph when authenticated', async () => {
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    expect(fixture.componentInstance.revisionId()).toBe('r1');
    expect(fixture.nativeElement.textContent).toContain('Edit your snapshot');
    expect(fixture.nativeElement.textContent).toContain('Auto-saves');
  });

  it('adds a waypoint optimistically before the server round-trip finishes', async () => {
    await fixture.componentInstance.ngOnInit();
    fixture.componentInstance.setTool('add');
    let resolveEdit!: (value: {
      lock_version: number;
      revision_id: string;
      coordinate_frame: { width: number; height: number };
      underlay_url: null;
      nodes: { id: string; x: number; y: number; label: string; kind: string }[];
      edges: never[];
    }) => void;
    api.editGraph = () =>
      new Promise((resolve) => {
        resolveEdit = resolve;
      });
    const pending = fixture.componentInstance.onCanvasClick({ x: 12, y: 34 });
    expect(fixture.componentInstance.nodes().length).toBe(1);
    expect(fixture.componentInstance.nodes()[0].x).toBe(12);
    await Promise.resolve();
    expect(typeof resolveEdit).toBe('function');
    resolveEdit({
      lock_version: 2,
      revision_id: 'r1',
      coordinate_frame: { width: 1000, height: 640 },
      underlay_url: null,
      nodes: fixture.componentInstance.nodes(),
      edges: [],
    });
    await pending;
    expect(fixture.componentInstance.version()).toBe(2);
  });

  it('offers no 3D view for targets without a prebuilt 3D map', async () => {
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.view-toggle')).toBeNull();
    fixture.componentInstance.setView('3d');
    expect(fixture.componentInstance.viewMode()).toBe('2d');
  });

  it('switches to the Sam Ibrahim 3D photo map and syncs the selected point', async () => {
    const page = fixture.componentInstance;
    await page.ngOnInit();
    const [target, path] = Object.entries(MAP3D_SCENES)[0];
    page.targetId.set(target);
    page.nodes.set([{ id: 'n13', x: 1, y: 2, label: 'Point 13', kind: 'checkpoint' }]);
    page.select(['n13']);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.view-toggle')).not.toBeNull();

    page.setView('3d');
    fixture.detectChanges();
    const frame = fixture.nativeElement.querySelector('iframe.map3d-frame') as HTMLIFrameElement;
    expect(page.viewMode()).toBe('3d');
    expect(frame.getAttribute('src')).toBe(`${path}#point-13`);

    page.select([]);
    page.onMap3dMessage(
      new MessageEvent('message', {
        origin: window.location.origin,
        data: { type: 'snapway-map3d-stop', nodeId: 'other-id', label: 'Point 13' },
      }),
    );
    expect(page.selectedIds()).toEqual(['n13']);

    page.setView('2d');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('iframe.map3d-frame')).toBeNull();
  });
});
