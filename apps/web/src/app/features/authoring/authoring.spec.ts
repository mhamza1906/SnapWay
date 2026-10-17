import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthoringPage } from './authoring';
import { BuildingSummary, PIPELINE_BASE } from './pipeline.service';

const summary: BuildingSummary = {
  id: 'plan-1',
  name: 'Test building',
  validationErrors: 0,
  floors: [
    {
      floorId: 'floor-1',
      label: 'Floor 1',
      level: 1,
      geometryStatus: 'reviewed',
      regions: 3,
      rooms: [{ id: 'r1', label: '101', kind: 'room', ready: true, reason: '', doors: 1 }],
      spaces: [{ id: 'r1', label: '101', kind: 'room', doors: 1 }],
      needsAttention: [
        {
          spaceId: 's1',
          label: 'STAIR A',
          kind: 'lobby',
          status: 'unknown',
          reason: 'No doorway found yet',
        },
      ],
      assumed: [],
      counts: { verified: 1, assumed: 0, ready: 1, destinations: 2 },
    },
  ],
};
const building = {
  id: 'plan-1',
  name: 'Test building',
  floors: [{ id: 'floor-1', label: 'Floor 1' }],
};
const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('map authoring page', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AuthoringPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  async function start() {
    const fixture = TestBed.createComponent(AuthoringPage);
    fixture.detectChanges();
    http.expectOne(`${PIPELINE_BASE}/health`).flush({
      ok: true,
      provider: 'Vertex AI',
      configured: true,
      model: 'gemini-4-argon',
      effort: 'high',
      environment: 'prod',
    });
    await flush();
    http.expectOne(`${PIPELINE_BASE}/buildings`).flush({ buildings: [] });
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  it('shows which provider the pipeline uses, without any key', async () => {
    const fixture = await start();
    const badge = fixture.nativeElement.querySelector('[data-testid="provider"]') as HTMLElement;
    expect(badge.textContent).toContain('prod');
    expect(badge.textContent).toContain('Vertex AI gemini-4-argon');
  });

  it('uploads a plan, renders the floor and turns a stair into a room through the pipeline', async () => {
    const fixture = await start();
    const page = fixture.componentInstance;
    const input = { value: 'Test building' } as HTMLInputElement;
    const file = new File(['%PDF'], 'plan.pdf', { type: 'application/pdf' });
    const upload = page.upload({ target: { files: [file], value: '' } } as unknown as Event, input);
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/plans`);
    expect(req.request.body instanceof FormData).toBe(true);
    req.flush({ building, summary });
    await flush();
    http
      .expectOne(`${PIPELINE_BASE}/authoring/render`)
      .flush({ svg: '<svg viewBox="0 0 10 10"></svg>' });
    await upload;
    await flush();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Floor 1 · 1/2 rooms ready');
    expect(text).toContain('STAIR A');

    const make = page.makeRoom('s1', 'STAIR A');
    const edit = http.expectOne(`${PIPELINE_BASE}/authoring/doorways/define-room`);
    expect(edit.request.body).toEqual(jasmineLike({ floorId: 'floor-1', spaceId: 's1' }));
    edit.flush({
      building,
      summary: { ...summary, floors: [{ ...summary.floors[0], needsAttention: [] }] },
    });
    await flush();
    http.expectOne(`${PIPELINE_BASE}/authoring/render`).flush({ svg: '<svg></svg>' });
    await make;
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('STAIR A is now a room');
  });
});

// Partial match without depending on the building payload.
function jasmineLike(expected: Record<string, unknown>) {
  return expect.objectContaining(expected);
}
