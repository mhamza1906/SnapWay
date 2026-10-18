import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { GraphApiService } from '../../core/graph-api.service';
import { GraphEditorPage } from './graph-editor';

describe('GraphEditorPage', () => {
  let fixture: ComponentFixture<GraphEditorPage>;
  const api = {
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
});
