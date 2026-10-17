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
    page.planType.set('floor');
    page.cleanFirst.set(false);
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

  it('asks how many floors a building plan shows before uploading anything', async () => {
    const fixture = await start();
    const page = fixture.componentInstance;
    const file = new File(['x'], 'board.jpg', { type: 'image/jpeg' });
    await page.upload(
      { target: { files: [file], value: '' } } as unknown as Event,
      {
        value: '',
      } as HTMLInputElement,
    );
    expect(page.error()).toContain('floor plan or a building plan');
    page.planType.set('building');
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelector('[data-testid="floor-prompt"]') as HTMLElement)
        .textContent,
    ).toContain('Enter the number of floors');
    await page.upload(
      { target: { files: [file], value: '' } } as unknown as Event,
      {
        value: '',
      } as HTMLInputElement,
    );
    expect(page.error()).toContain('How many floors');
    http.expectNone(`${PIPELINE_BASE}/authoring/clean-plans`);
  });

  it('cleans a building plan into its floors before mapping', async () => {
    const fixture = await start();
    const page = fixture.componentInstance;
    page.planType.set('building');
    page.floorCount.set(2);
    page.floorNames.set('Level B, Level 1');
    const file = new File(['x'], 'board.jpg', { type: 'image/jpeg' });
    const upload = page.upload(
      { target: { files: [file], value: '' } } as unknown as Event,
      {
        value: 'Sam',
      } as HTMLInputElement,
    );
    const start_ = http.expectOne(`${PIPELINE_BASE}/authoring/clean-plans`);
    const form = start_.request.body as FormData;
    expect(form.get('mode')).toBe('building');
    expect(form.get('floors')).toBe('2');
    expect(form.get('labels')).toBe('Level B, Level 1');
    start_.flush({ id: 'job-1' });
    await flush();
    const img = 'data:image/jpeg;base64,AA==';
    http.expectOne(`${PIPELINE_BASE}/authoring/clean-plans/job-1`).flush({
      id: 'job-1',
      status: 'complete',
      mode: 'building',
      floors: 2,
      progress: { stage: 'finished', message: '2 clean floor(s) ready' },
      result: {
        building,
        summary,
        elapsedMs: 41000,
        imageModel: 'gemini-3-pro-image',
        usage: { calls: 3, tokens: 9000, images: 2, cachedImages: 0 },
        floors: ['Level B', 'Level 1'].map((label, i) => ({
          label,
          level: i,
          crop: { left: 0, top: 0, width: 10, height: 10 },
          cached: false,
          latencyMs: 30000,
          model: 'gemini-3-pro-image',
          originalPreview: img,
          cleanPreview: img,
        })),
      },
    });
    await flush();
    http.expectOne(`${PIPELINE_BASE}/authoring/render`).flush({ svg: '<svg></svg>' });
    await upload;
    fixture.detectChanges();
    const grid = fixture.nativeElement.querySelector('[data-testid="clean-floors"]') as HTMLElement;
    expect(grid.querySelectorAll('figure').length).toBe(2);
    expect(grid.textContent).toContain('Level B');
    expect(page.message()).toContain('2 clean floor(s) from gemini-3-pro-image');
  });
});

// Partial match without depending on the building payload.
function jasmineLike(expected: Record<string, unknown>) {
  return expect.objectContaining(expected);
}
