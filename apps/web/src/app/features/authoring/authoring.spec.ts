import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthoringPage } from './authoring';
import {
  AssumedDoor,
  BuildingSummary,
  EdgeOption,
  FloorSummary,
  IMAGE_PLACEHOLDER,
  PIPELINE_BASE,
  SpaceSummary,
} from './pipeline.service';

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

// A mapped floor with three walkable regions for the Regions panel.
const regionSpaces: SpaceSummary[] = [
  // 101 and the lobby each share a wall with Hallway 3, not with each other.
  { id: 'r1', label: '101', kind: 'room', doors: 1, stair: false, neighbours: ['h1'] },
  {
    id: 'h1',
    label: 'Hallway 3',
    kind: 'hallway',
    doors: 2,
    stair: false,
    neighbours: ['r1', 'l1'],
  },
  { id: 'l1', label: 'Open lobby 2', kind: 'lobby', doors: 1, stair: false, neighbours: ['h1'] },
];
/** The fixture with Hallway 3 as a room-type region, for room merge tests. */
function roomLike(): BuildingSummary {
  return withSpaces(regionSpaces.map((s) => (s.id === 'h1' ? { ...s, kind: 'room' } : s)));
}
function withSpaces(spaces: SpaceSummary[]): BuildingSummary {
  const floor: FloorSummary = {
    ...summary.floors[0],
    spaces,
    stairs: spaces.filter((s) => s.stair).map((s) => ({ id: s.id, label: s.label })),
  };
  return { ...summary, floors: [floor] };
}
// An assumed doorway on room 101 with one deduplicated option per neighbouring region.
function edge(key: number, label: string, kind: string, length: number): EdgeOption {
  return {
    key,
    adjacentId: `${kind}-${key}`,
    adjacentLabel: label,
    adjacentKind: kind,
    hallway: kind !== 'room',
    length,
    doors: 0,
    a: { x: 0, y: key },
    b: { x: length, y: key },
  };
}
const door: AssumedDoor = {
  doorId: 'd1',
  roomId: 'r1',
  roomLabel: '101',
  roomDoors: 2,
  edgeKey: 3,
  t: 0.5,
  width: 30,
  segment: { a: { x: 45, y: 3 }, b: { x: 75, y: 3 } },
  candidates: [
    edge(3, 'Hallway 3', 'corridor', 120.4),
    edge(5, 'Open lobby 2', 'lobby', 80),
    edge(7, '102', 'room', 40.6),
  ],
};
function withDoors(doors: AssumedDoor[], s = withSpaces(regionSpaces)): BuildingSummary {
  return { ...s, floors: [{ ...s.floors[0], assumed: doors }] };
}
// A 1000 × 800 floor, so "Show on map" visibly crops the viewBox (to at least 250 px).
const FULL_VIEW = '0 0 1000 800';
const roomsSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="${FULL_VIEW}">` +
  '<g data-room-id="r1" class="designed-room"><polygon points="100,100 200,100 200,200 100,200"/></g>' +
  '<g data-room-id="h1" class="designed-room"><polygon points="400,300 600,300 600,400 400,400"/></g>' +
  '<g data-room-id="l1" class="designed-room"><polygon points="600,300 700,300 700,400 600,400"/></g>' +
  '<g data-room-id="s1" class="designed-room"><polygon points="800,600 900,600 900,700 800,700"/></g>' +
  '<g data-door-id="d7" class="designed-door"><path d="M140,200L160,200"/><path d="M140,200L160,200"/><path d="M140,200L160,200" pointer-events="stroke"/></g>' +
  '<g data-door-id="d8" class="designed-door"><path d="M450,300L470,300"/><path d="M450,300L470,300"/><path d="M450,300L470,300" pointer-events="stroke"/></g></svg>';
// An image too big to send on every click, and a building that carries it everywhere.
const IMG = 'data:image/png;base64,' + 'A'.repeat(4000);
const IMG_HISTORY = 'data:image/png;base64,' + 'B'.repeat(4000);
const source = (dataUrl: string) => ({ name: 'plan.png', width: 1000, height: 800, dataUrl });
const heavyBuilding = {
  ...building,
  assets: {
    a1: { id: 'a1', name: 'plan.png', mime: 'image/png', dataUrl: IMG, hash: 'h', provenance: '' },
  },
  floors: [
    {
      id: 'floor-1',
      label: 'Floor 1',
      geometry: { spaces: [], source: source(IMG) },
      history: [
        { revision: 1, at: 't1', reason: 'old', geometry: { source: source(IMG_HISTORY) } },
      ],
    },
  ],
};

describe('map authoring page', () => {
  let http: HttpTestingController;
  // jsdom has no scrollIntoView; "Show on map" scrolls the map into view.
  const originalScroll = Element.prototype.scrollIntoView;
  let scroll: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll as unknown as Element['scrollIntoView'];
    await TestBed.configureTestingModule({
      imports: [AuthoringPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = originalScroll;
    http.verify();
  });

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

  /** Opens a saved building so the floor is mapped and the Regions panel shows. */
  async function startMapped(
    s: BuildingSummary = withSpaces(regionSpaces),
    saved: Record<string, unknown> = building,
  ) {
    const fixture = await start();
    const page = fixture.componentInstance;
    page.reviewer.set('Sam');
    const opening = page.open('plan-1');
    http.expectOne(`${PIPELINE_BASE}/buildings/plan-1`).flush(saved);
    await flush();
    http.expectOne(`${PIPELINE_BASE}/authoring/summary`).flush(s);
    await flush();
    http.expectOne(`${PIPELINE_BASE}/authoring/render`).flush({ svg: roomsSvg });
    await opening;
    await flush();
    fixture.detectChanges();
    return { fixture, page, el: fixture.nativeElement as HTMLElement };
  }
  const row = (el: HTMLElement, id: string) =>
    el.querySelector(`[data-testid="region"][data-region-id="${id}"]`) as HTMLElement;
  const within = <T extends HTMLElement>(parent: HTMLElement, testid: string) =>
    parent.querySelector(`[data-testid="${testid}"]`) as T;
  /** Answers the render request the last action made and returns its overlay. */
  async function renderOverlay(svg = roomsSvg) {
    await flush();
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/render`);
    const overlay = req.request.body.overlay;
    req.flush({ svg });
    await flush();
    return overlay;
  }
  /** Selection, "Show on map" and previews are drawn in the browser: no render request. */
  async function noRender(fixture: { detectChanges(): void }) {
    await flush();
    http.expectNone(`${PIPELINE_BASE}/authoring/render`);
    fixture.detectChanges();
  }
  const mapSvg = (el: HTMLElement) => el.querySelector('[data-testid="map"] svg') as SVGSVGElement;
  /** Region ids drawn selected on the map. */
  const drawnSelected = (el: HTMLElement) =>
    [...mapSvg(el).querySelectorAll('[data-room-id].is-selected')].map((g) =>
      g.getAttribute('data-room-id'),
    );
  const doorSegment = (el: HTMLElement) =>
    mapSvg(el).querySelector('[data-client-overlay] line[data-door-segment]');

  /** Answers the render request the last action made and returns its body. */
  async function renderBody() {
    await flush();
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/render`);
    const body = req.request.body;
    req.flush({ svg: roomsSvg });
    await flush();
    return body;
  }
  /** Every embedded image is the placeholder; no image data is sent. */
  function expectLight(b: typeof heavyBuilding) {
    for (const a of Object.values(b.assets)) expect(a.dataUrl).toBe(IMAGE_PLACEHOLDER);
    for (const f of b.floors) {
      expect(f.geometry.source.dataUrl).toBe(IMAGE_PLACEHOLDER);
      for (const h of f.history) expect(h.geometry.source.dataUrl).toBe(IMAGE_PLACEHOLDER);
    }
    const text = JSON.stringify(b);
    expect(text).not.toContain('A'.repeat(100));
    expect(text).not.toContain('B'.repeat(100));
  }
  /** Opens a building with embedded images; summary and render get the light copy. */
  async function startMappedHeavy() {
    const fixture = await start();
    const page = fixture.componentInstance;
    const opening = page.open('plan-1');
    http.expectOne(`${PIPELINE_BASE}/buildings/plan-1`).flush(structuredClone(heavyBuilding));
    await flush();
    const sum = http.expectOne(`${PIPELINE_BASE}/authoring/summary`);
    expectLight(sum.request.body.building);
    sum.flush(withSpaces(regionSpaces));
    await flush();
    expectLight((await renderBody()).building);
    await opening;
    await flush();
    fixture.detectChanges();
    // Lightening a request never touches the building the page holds.
    const held = page.building() as unknown as typeof heavyBuilding;
    expect(held.assets.a1.dataUrl).toBe(IMG);
    expect(held.floors[0].geometry.source.dataUrl).toBe(IMG);
    expect(held.floors[0].history[0].geometry.source.dataUrl).toBe(IMG_HISTORY);
    return { fixture, page };
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
    http.expectNone(`${PIPELINE_BASE}/authoring/plans`);
  });

  it('lists regions with kind, stair badge and default-name flags, and filters them', async () => {
    const { fixture, el } = await startMapped(
      withSpaces([{ ...regionSpaces[0], stair: true }, regionSpaces[1], regionSpaces[2]]),
    );
    const panel = within(el, 'regions');
    expect(panel.textContent).toContain('the AI only suggests room names');
    expect(panel.textContent).not.toMatch(/developer|admin/i);
    expect(el.querySelectorAll('[data-testid="region"]').length).toBe(3);
    expect(within(row(el, 'r1'), 'stair-badge')).not.toBeNull();
    expect(within<HTMLSelectElement>(row(el, 'r1'), 'region-kind').value).toBe('stair');
    expect(within(row(el, 'r1'), 'default-name')).toBeNull();
    expect(within(row(el, 'h1'), 'default-name')).not.toBeNull();
    expect(within(row(el, 'l1'), 'default-name')).not.toBeNull();
    expect(row(el, 'h1').textContent).toContain('hallway');

    const filter = within<HTMLInputElement>(el, 'region-filter');
    filter.value = 'hall';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const rows = [...el.querySelectorAll('[data-testid="region"]')] as HTMLElement[];
    expect(rows.map((r) => r.dataset['regionId'])).toEqual(['h1']);
  });

  it('renames a region with the reviewer name and shows the new label', async () => {
    const { fixture, page, el } = await startMapped();
    const save = within<HTMLButtonElement>(row(el, 'r1'), 'region-save');
    expect(save.disabled).toBe(true);
    const input = within<HTMLInputElement>(row(el, 'r1'), 'region-name');
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(save.disabled).toBe(true);
    expect(input.maxLength).toBe(120);
    input.value = ' Room 101 ';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(save.disabled).toBe(false);

    save.click();
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/spaces/rename`);
    expect(req.request.body).toEqual(
      jasmineLike({ floorId: 'floor-1', spaceId: 'r1', label: 'Room 101', reviewer: 'Sam' }),
    );
    expect(req.request.body.building).toEqual(building);
    req.flush({
      building,
      summary: withSpaces([{ ...regionSpaces[0], label: 'Room 101' }, ...regionSpaces.slice(1)]),
    });
    expect(await renderOverlay()).toEqual({});
    fixture.detectChanges();
    expect(row(el, 'r1').textContent).toContain('Room 101');
    expect(within<HTMLInputElement>(row(el, 'r1'), 'region-name').value).toBe('Room 101');
    expect(within<HTMLButtonElement>(row(el, 'r1'), 'region-save').disabled).toBe(true);
    expect(page.message()).toContain('"101" renamed to "Room 101"');
  });

  it('marks a region as a stair from "Use as"', async () => {
    const { fixture, page, el } = await startMapped();
    const select = within<HTMLSelectElement>(row(el, 'h1'), 'region-kind');
    select.value = 'stair';
    select.dispatchEvent(new Event('change'));
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/spaces/kind`);
    expect(req.request.body).toEqual(
      jasmineLike({ floorId: 'floor-1', spaceId: 'h1', kind: 'stair', reviewer: 'Sam' }),
    );
    expect(page.busy()).toBe(true);
    req.flush({
      building,
      summary: withSpaces([
        regionSpaces[0],
        { ...regionSpaces[1], kind: 'lobby', use: 'stair', stair: true },
        regionSpaces[2],
      ]),
    });
    await renderOverlay();
    fixture.detectChanges();
    expect(within(row(el, 'h1'), 'stair-badge')).not.toBeNull();
    expect(within(row(el, 'h1'), 'kind-badge')).toBeNull();
    expect(within<HTMLSelectElement>(row(el, 'h1'), 'region-kind').value).toBe('stair');
    expect(within(el, 'region-counts').textContent).toContain('1 stair(s)');
    expect(page.message()).toBe('Hallway 3 is now a stair.');
  });

  it('keeps the open building, floor and panel when you leave the page and come back', async () => {
    const first = await startMapped();
    within<HTMLButtonElement>(first.el, 'show-regions').click();
    await noRender(first.fixture);
    first.fixture.destroy();
    // Back on Authoring: no reload; the floor is drawn again from the kept building.
    const again = TestBed.createComponent(AuthoringPage);
    again.detectChanges();
    expect(again.componentInstance.building()).toBe(building);
    expect(again.componentInstance.floorId()).toBe('floor-1');
    expect(again.componentInstance.reviewer()).toBe('Sam');
    expect(again.componentInstance.sidePanel()).toBe('regions');
    expect(await renderOverlay()).toEqual({});
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
    again.detectChanges();
    expect(within(again.nativeElement, 'regions').hidden).toBe(false);
  });

  it('Select: Doorways picks a doorway on the map to move or remove, whatever its state', async () => {
    const { fixture, page, el } = await startMapped();
    const hit = () =>
      el.querySelector('[data-testid="map"] [data-door-id="d7"] > path:last-child')!;
    expect(hit().getAttribute('pointer-events')).toBe('none');
    within<HTMLButtonElement>(el, 'select-doorways').click();
    await noRender(fixture);
    expect(hit().getAttribute('pointer-events')).toBe('stroke');
    expect(within(el, 'door-pick-hint')).not.toBeNull();
    hit().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/doorways/describe`);
    expect(req.request.body).toEqual(jasmineLike({ floorId: 'floor-1', doorId: 'd7' }));
    req.flush({
      doorId: 'd7',
      label: 'Doorway',
      roomId: 'r1',
      roomLabel: '101',
      state: 'verified',
      assumed: false,
      joins: [
        { id: 'r1', label: '101' },
        { id: 'h1', label: 'Hallway 3' },
      ],
      edgeKey: 0,
      t: 0.5,
      width: 20,
      segment: { a: { x: 140, y: 200 }, b: { x: 160, y: 200 } },
      candidates: [
        {
          key: 0,
          adjacentId: 'h1',
          adjacentLabel: 'Hallway 3',
          adjacentKind: 'corridor',
          hallway: true,
          length: 100,
          doors: 1,
          a: { x: 100, y: 200 },
          b: { x: 200, y: 200 },
        },
      ],
    });
    await noRender(fixture);
    const card = within<HTMLElement>(el, 'selected-door');
    expect(card.textContent).toContain('101');
    expect(card.textContent).toContain('Verified on the plan');
    expect(page.sidePanel()).toBe('doorways');
    expect(el.querySelector('[data-door-segment]')).not.toBeNull();
    within<HTMLButtonElement>(card, 'selected-door-remove').click();
    await noRender(fixture);
    // Removing asks how: made into a wall, or the line removed.
    http.expectNone(`${PIPELINE_BASE}/authoring/doorways/remove`);
    within<HTMLButtonElement>(within(el, 'remove-choice'), 'remove-as-wall').click();
    await flush();
    const rm = http.expectOne(`${PIPELINE_BASE}/authoring/doorways/remove`);
    expect(rm.request.body).toEqual(
      jasmineLike({ floorId: 'floor-1', doorId: 'd7', reviewer: 'Sam', as: 'wall' }),
    );
    rm.flush({ building, summary: withSpaces(regionSpaces) });
    expect(await renderOverlay()).toEqual({});
    fixture.detectChanges();
    expect(within(el, 'selected-door')).toBeNull();
    expect(page.message()).toBe(
      'Doorway between 101 and Hallway 3 made into a wall; paths rebuilt.',
    );
    within<HTMLButtonElement>(el, 'select-rooms').click();
    await noRender(fixture);
    expect(hit().getAttribute('pointer-events')).toBe('none');
  });

  it('selects several doorways by clicking (click again to unselect) and removes them together', async () => {
    const { fixture, page, el } = await startMapped();
    within<HTMLButtonElement>(el, 'select-doorways').click();
    await noRender(fixture);
    const info = (id: string, x: number, y: number, other: string) => ({
      doorId: id,
      label: 'Doorway',
      roomId: 'r1',
      roomLabel: '101',
      state: 'legacy',
      assumed: false,
      joins: [
        { id: 'r1', label: '101' },
        { id: 'h1', label: other },
      ],
      edgeKey: 0,
      t: 0.5,
      width: 20,
      segment: { a: { x, y }, b: { x: x + 20, y } },
      candidates: [],
    });
    const click = async (id: string) => {
      el.querySelector(
        `[data-testid="map"] [data-door-id="${id}"] > path:last-child`,
      )!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    };
    await click('d7');
    http
      .expectOne(`${PIPELINE_BASE}/authoring/doorways/describe`)
      .flush(info('d7', 140, 200, 'Hallway 3'));
    await noRender(fixture);
    await click('d8');
    http
      .expectOne(`${PIPELINE_BASE}/authoring/doorways/describe`)
      .flush(info('d8', 450, 300, 'Lobby 2'));
    await noRender(fixture);
    expect(page.selectedDoorIds()).toEqual(['d7', 'd8']);
    expect(within(el, 'selected-door')).toBeNull();
    expect(within(el, 'selected-doors').textContent).toContain('2 doorways selected');
    expect(el.querySelectorAll('[data-door-segment]').length).toBe(2);
    // Clicking d8 again unselects it: back to the single-doorway card, no new request.
    await click('d8');
    await noRender(fixture);
    expect(page.selectedDoorIds()).toEqual(['d7']);
    expect(within(el, 'selected-door')).not.toBeNull();
    await click('d8');
    await noRender(fixture);
    within<HTMLButtonElement>(el, 'doors-as-wall').click();
    await flush();
    const rm = http.expectOne(`${PIPELINE_BASE}/authoring/doorways/remove`);
    expect(rm.request.body).toEqual(
      jasmineLike({ floorId: 'floor-1', doorIds: ['d7', 'd8'], reviewer: 'Sam', as: 'wall' }),
    );
    rm.flush({ building, summary: withSpaces(regionSpaces) });
    expect(await renderOverlay()).toEqual({});
    fixture.detectChanges();
    expect(page.selectedDoorIds()).toEqual([]);
    expect(page.message()).toBe('2 doorways made into walls; paths rebuilt.');
  });

  it('shows one tool panel at a time: Doorways or Regions, switched by the toggle', async () => {
    const { fixture, el } = await startMapped();
    const doors = el.querySelector<HTMLElement>('[aria-labelledby="doors-title"]')!,
      regions = within<HTMLElement>(el, 'regions');
    expect([doors.hidden, regions.hidden]).toEqual([false, true]);
    within<HTMLButtonElement>(el, 'show-regions').click();
    await noRender(fixture);
    expect([doors.hidden, regions.hidden]).toEqual([true, false]);
    expect(within(el, 'show-regions').getAttribute('aria-selected')).toBe('true');
    within<HTMLButtonElement>(el, 'show-doorways').click();
    await noRender(fixture);
    expect([doors.hidden, regions.hidden]).toEqual([false, true]);
    // Clicking a region on the map opens the Regions panel.
    el.querySelector('[data-testid="map"] [data-room-id="h1"] polygon')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await noRender(fixture);
    expect(regions.hidden).toBe(false);
  });

  it('highlights selected regions on the map; ticking never starts a merge', async () => {
    const { fixture, page, el } = await startMapped();
    expect(within(el, 'merge-regions')).toBeNull();

    expect(drawnSelected(el)).toEqual([]);

    within<HTMLInputElement>(row(el, 'r1'), 'region-select').click();
    await noRender(fixture);
    expect(within(el, 'merge-regions')).toBeNull();
    expect(row(el, 'r1').classList).toContain('selected');
    expect(drawnSelected(el)).toEqual(['r1']);

    within<HTMLInputElement>(row(el, 'h1'), 'region-select').click();
    await noRender(fixture);
    expect(within(el, 'merge-regions')).toBeNull();
    expect(within(el, 'open-merge')).not.toBeNull();
    expect(drawnSelected(el)).toEqual(['r1', 'h1']);

    within<HTMLInputElement>(row(el, 'r1'), 'region-select').click();
    await noRender(fixture);
    expect(within(el, 'merge-regions')).toBeNull();
    expect(drawnSelected(el)).toEqual(['h1']);
    // Highlighting never zooms.
    expect(mapSvg(el).getAttribute('viewBox')).toBe(FULL_VIEW);

    within<HTMLButtonElement>(within(el, 'region-selection'), 'clear-selection').click();
    await noRender(fixture);
    expect(within(el, 'region-selection')).toBeNull();
    expect(drawnSelected(el)).toEqual([]);
    await page.mergeRegions();
    http.expectNone(`${PIPELINE_BASE}/authoring/spaces/merge`);
  });

  it('keeps the selection drawn on the map after an edit re-renders it', async () => {
    const { fixture, el } = await startMapped();
    within<HTMLInputElement>(row(el, 'h1'), 'region-select').click();
    await noRender(fixture);
    const input = within<HTMLInputElement>(row(el, 'r1'), 'region-name');
    input.value = 'Room 101';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    within<HTMLButtonElement>(row(el, 'r1'), 'region-save').click();
    fixture.detectChanges();
    // The row being edited says so while the edit runs.
    expect(within(row(el, 'r1'), 'saving').textContent).toContain('Saving…');
    expect(within(row(el, 'h1'), 'saving')).toBeNull();
    http.expectOne(`${PIPELINE_BASE}/authoring/spaces/rename`).flush({
      building,
      summary: withSpaces([{ ...regionSpaces[0], label: 'Room 101' }, ...regionSpaces.slice(1)]),
    });
    // The service draws no selection; the browser re-applies it to the new SVG.
    expect(await renderOverlay()).toEqual({});
    fixture.detectChanges();
    expect(within(row(el, 'r1'), 'saving')).toBeNull();
    expect(drawnSelected(el)).toEqual(['h1']);
  });

  it('toggles a region when it is clicked on the map', async () => {
    const { fixture, page, el } = await startMapped();
    const polygon = el.querySelector('[data-testid="map"] [data-room-id="h1"] polygon')!;
    polygon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await noRender(fixture);
    expect(page.selectedRegions()).toEqual(['h1']);
    expect(within<HTMLInputElement>(row(el, 'h1'), 'region-select').checked).toBe(true);
    expect(drawnSelected(el)).toEqual(['h1']);
    // Clicking it again unselects it.
    el.querySelector('[data-testid="map"] [data-room-id="h1"] polygon')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await noRender(fixture);
    expect(page.selectedRegions()).toEqual([]);
    expect(drawnSelected(el)).toEqual([]);
  });

  it('merges two rooms from the Merge rooms menu: the second into the first', async () => {
    const { fixture, page, el } = await startMapped(roomLike());
    within<HTMLButtonElement>(el, 'open-merge').click();
    await noRender(fixture);
    const start = within<HTMLSelectElement>(el, 'merge-start');
    start.value = 'r1';
    start.dispatchEvent(new Event('change'));
    await noRender(fixture);
    // Only Hallway 3 shares a wall with 101; the lobby is not offered.
    const offered = () =>
      [...el.querySelectorAll('[data-testid="merge-candidate"]')].map((b) =>
        b.getAttribute('data-region-id'),
      );
    expect(offered()).toEqual(['h1']);
    expect(within<HTMLButtonElement>(el, 'merge-regions').disabled).toBe(true);
    expect(drawnSelected(el)).toEqual(['r1']);
    within<HTMLButtonElement>(el, 'merge-candidate').click();
    await noRender(fixture);
    // The lobby is close to the hallway but is a hallway-type region, so it is not offered.
    expect(offered()).toEqual([]);
    expect(page.mergeGroup()).toEqual(['r1', 'h1']);
    expect(drawnSelected(el)).toEqual(['r1', 'h1']);
    expect(el.querySelector('[data-testid="merge-members"]')!.textContent).toMatch(
      /Keep \(selected first\)\s*101.*Remove \(merged into 101\)\s*Hallway 3/s,
    );

    const name = within<HTMLInputElement>(el, 'merge-name');
    name.value = 'Main stair';
    name.dispatchEvent(new Event('input'));
    const stair = within<HTMLInputElement>(el, 'merge-stair');
    expect(stair.checked).toBe(false);
    stair.click();
    fixture.detectChanges();
    expect(stair.checked).toBe(true);

    const merge = within<HTMLButtonElement>(el, 'merge-regions');
    expect(merge.textContent).toContain('Merge Hallway 3 into 101');
    merge.click();
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/spaces/merge`);
    expect(req.request.body).toEqual(
      jasmineLike({
        floorId: 'floor-1',
        spaceIds: ['r1', 'h1'],
        label: 'Main stair',
        stair: true,
        reviewer: 'Sam',
      }),
    );
    req.flush({
      building,
      summary: withSpaces([
        { id: 'r1', label: 'Main stair', kind: 'stair', doors: 3, stair: true, neighbours: ['l1'] },
        { ...regionSpaces[2], neighbours: ['r1'] },
      ]),
      spaceId: 'r1',
      absorbed: [{ id: 'c9', label: 'Closet 9' }],
      carved: [{ id: 'h7', label: 'Hallway 7' }],
    });
    expect(await renderOverlay()).toEqual({});
    fixture.detectChanges();
    expect(page.mergeGroup()).toBeNull();
    expect(page.mergeName()).toBe('');
    expect(within(el, 'merge-box')).toBeNull();
    expect(row(el, 'h1')).toBeNull();
    expect(within(row(el, 'r1'), 'stair-badge')).not.toBeNull();
    expect(page.message()).toBe(
      'Merged 2 regions into "Main stair". Also merged in what lay between them: Closet 9. Took only the part between the rooms from: Hallway 7.',
    );
  });

  it('with two rooms ticked, Merge rooms merges them: the first ticked is kept, the second removed', async () => {
    const { fixture, page, el } = await startMapped(roomLike());
    within<HTMLInputElement>(row(el, 'h1'), 'region-select').click();
    within<HTMLInputElement>(row(el, 'r1'), 'region-select').click();
    await noRender(fixture);
    within<HTMLButtonElement>(el, 'open-merge').click();
    await noRender(fixture);
    expect(page.mergeGroup()).toEqual(['h1', 'r1']);
    expect(within(el, 'merge-regions').textContent).toContain('Merge 101 into Hallway 3');
    expect(el.querySelector('[data-testid="merge-members"]')!.textContent).toMatch(
      /Keep \(selected first\)\s*Hallway 3.*Remove \(merged into Hallway 3\)\s*101/s,
    );
    within<HTMLButtonElement>(el, 'cancel-merge').click();
    await noRender(fixture);
  });

  it('only merges regions of the same type that are close to a chosen one', async () => {
    const { fixture, page, el } = await startMapped(roomLike());
    const click = async (id: string) => {
      el.querySelector(`[data-testid="map"] [data-room-id="${id}"] polygon`)!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await noRender(fixture);
    };
    within<HTMLButtonElement>(row(el, 'r1'), 'merge-from').click();
    await noRender(fixture);
    expect(page.mergeGroup()).toEqual(['r1']);
    await click('h1');
    expect(page.mergeGroup()).toEqual(['r1', 'h1']);
    // The lobby is close to the hallway piece, but it is a hallway and 101 is a room.
    await click('l1');
    expect(page.mergeGroup()).toEqual(['r1', 'h1']);
    expect(page.message()).toBe(
      'Open lobby 2 is a hallway and 101 is a room; hallways, rooms and stairs only merge with their own type.',
    );
    // Removing a room drops any room that was only close through it; removing the first starts over.
    within<HTMLButtonElement>(
      [...el.querySelectorAll<HTMLElement>('[data-testid="merge-members"] li')][1],
      'merge-remove',
    ).click();
    await noRender(fixture);
    expect(page.mergeGroup()).toEqual(['r1']);
    within<HTMLButtonElement>(el, 'merge-remove').click();
    await noRender(fixture);
    expect(page.mergeGroup()).toEqual([]);
    within<HTMLButtonElement>(el, 'cancel-merge').click();
    await noRender(fixture);
    expect(page.mergeGroup()).toBeNull();
    http.expectNone(`${PIPELINE_BASE}/authoring/spaces/merge`);
  });

  it('lists merged rooms and unmerges one; a merge with a later merge waits', async () => {
    const merged: BuildingSummary = withSpaces(regionSpaces);
    merged.floors[0].merges = [
      {
        recordId: 'm2',
        keptId: 'r1',
        label: '101',
        keptLabel: '101',
        removedId: 'x2',
        removedLabel: 'Store',
        at: '2026-10-17T12:00:00Z',
        undoable: true,
        reason: null,
      },
      {
        recordId: 'm1',
        keptId: 'r1',
        label: '101',
        keptLabel: '101',
        removedId: 'x1',
        removedLabel: 'Closet',
        at: '2026-10-17T11:00:00Z',
        undoable: false,
        reason: 'Merged again since; unmerge the later merge first.',
      },
    ];
    const { fixture, page, el } = await startMapped(merged);
    const items = [...el.querySelectorAll<HTMLElement>('[data-testid="merged-item"]')];
    expect(items.map((i) => i.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      '✓Store merged into 101 Unmerge',
      '✓Closet merged into 101Merged again since; unmerge the later merge first. Unmerge',
    ]);
    expect(within<HTMLButtonElement>(items[1], 'unmerge').disabled).toBe(true);
    within<HTMLButtonElement>(items[0], 'unmerge').click();
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/spaces/unmerge`);
    expect(req.request.body).toEqual(
      jasmineLike({ floorId: 'floor-1', recordId: 'm2', reviewer: 'Sam' }),
    );
    req.flush({ building, summary: withSpaces(regionSpaces) });
    expect(await renderOverlay()).toEqual({});
    fixture.detectChanges();
    expect(within(el, 'merged-list')).toBeNull();
    expect(page.message()).toBe('Unmerged "Store" from "101"; both rooms are back.');
  });

  it('shows a needs-attention region on the map, then the whole floor again, without a request', async () => {
    const { fixture, page, el } = await startMapped();
    within<HTMLInputElement>(row(el, 'r1'), 'region-select').click();
    await noRender(fixture);
    expect(drawnSelected(el)).toEqual(['r1']);

    const locate = within<HTMLButtonElement>(within(el, 'needs-attention'), 'locate');
    expect(locate.getAttribute('aria-label')).toBe('Show STAIR A on the map');
    locate.click();
    expect(page.busy()).toBe(false);
    await noRender(fixture);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(scroll.mock.contexts[0]).toBe(within(el, 'map'));
    // Locating replaces the Regions selection and zooms to the region (+25%, at least 250 px).
    expect(page.selectedRegions()).toEqual([]);
    expect(row(el, 'r1').classList).not.toContain('selected');
    expect(drawnSelected(el)).toEqual(['s1']);
    expect(mapSvg(el).getAttribute('viewBox')).toBe('725 525 250 250');
    expect(mapSvg(el).getAttribute('width')).toBe('250');
    expect(mapSvg(el).getAttribute('height')).toBe('250');
    expect(within(el, 'focus-bar').textContent).toContain('Showing STAIR A');

    within<HTMLButtonElement>(el, 'whole-floor').click();
    await noRender(fixture);
    expect(page.focused()).toBeNull();
    expect(within(el, 'focus-bar')).toBeNull();
    expect(mapSvg(el).getAttribute('viewBox')).toBe(FULL_VIEW);
    expect(mapSvg(el).getAttribute('width')).toBe('1000');
    expect(mapSvg(el).getAttribute('height')).toBe('800');
    expect(drawnSelected(el)).toEqual([]);
  });

  it('locates a region from its row, and selecting regions shows the whole floor again', async () => {
    const { fixture, page, el } = await startMapped();
    const locate = within<HTMLButtonElement>(row(el, 'h1'), 'locate');
    expect(locate.getAttribute('aria-label')).toBe('Show Hallway 3 on the map');
    locate.click();
    await noRender(fixture);
    expect(within(el, 'focus-bar').textContent).toContain('Showing Hallway 3');
    expect(mapSvg(el).getAttribute('viewBox')).toBe('350 225 300 250');
    expect(drawnSelected(el)).toEqual(['h1']);

    within<HTMLInputElement>(row(el, 'r1'), 'region-select').click();
    await noRender(fixture);
    expect(page.focused()).toBeNull();
    expect(within(el, 'focus-bar')).toBeNull();
    expect(mapSvg(el).getAttribute('viewBox')).toBe(FULL_VIEW);
    expect(drawnSelected(el)).toEqual(['r1']);
  });

  it('locates an assumed doorway with its segment and keeps the room in view while editing', async () => {
    const { fixture, el } = await startMapped(withDoors([door]));
    const item = within(el, 'assumed-door');
    within<HTMLButtonElement>(item, 'locate').click();
    await noRender(fixture);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(within(el, 'focus-bar').textContent).toContain('Showing 101 and its doorway (magenta)');
    expect(mapSvg(el).getAttribute('viewBox')).toBe('25 25 250 250');
    expect(drawnSelected(el)).toEqual(['r1']);
    let line = doorSegment(el)!;
    expect(
      ['x1', 'y1', 'x2', 'y2', 'stroke', 'pointer-events'].map((a) => line.getAttribute(a)),
    ).toEqual(['45', '3', '75', '3', '#c2185b', 'none']);

    // The position preview is drawn in the browser and stays zoomed on the room.
    const range = item.querySelector('input[type="range"]') as HTMLInputElement;
    range.value = '0.25';
    range.dispatchEvent(new Event('input'));
    await noRender(fixture);
    line = doorSegment(el)!;
    expect(mapSvg(el).querySelectorAll('[data-door-segment]').length).toBe(1);
    expect(Number(line.getAttribute('x1'))).toBeCloseTo(15.1);
    expect(Number(line.getAttribute('x2'))).toBeCloseTo(45.1);
    expect(mapSvg(el).getAttribute('viewBox')).toBe('25 25 250 250');
    expect(scroll).toHaveBeenCalledTimes(1);

    // After the move the map stays on the room; the real doorway is drawn by the server.
    const apply = [...item.querySelectorAll('button')].find((b) =>
      b.textContent!.includes('Apply move'),
    )!;
    apply.click();
    fixture.detectChanges();
    expect(within(item, 'saving').textContent).toContain('Saving…');
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/doorways/edit`);
    expect(req.request.body).toEqual(jasmineLike({ doorId: 'd1', edgeKey: 3, t: 0.25 }));
    req.flush({ building, summary: withDoors([{ ...door, t: 0.25 }]) });
    expect(await renderOverlay()).toEqual({});
    fixture.detectChanges();
    expect(within(el, 'focus-bar').textContent).toContain('Showing 101');
    expect(within(el, 'focus-bar').textContent).not.toContain('doorway');
    expect(mapSvg(el).getAttribute('viewBox')).toBe('25 25 250 250');
    expect(drawnSelected(el)).toEqual(['r1']);
    expect(doorSegment(el)).toBeNull();
    expect(within(el, 'saving')).toBeNull();

    within<HTMLButtonElement>(el, 'whole-floor').click();
    await noRender(fixture);
    expect(mapSvg(el).getAttribute('viewBox')).toBe(FULL_VIEW);
  });

  it('sends authoring calls without images and keeps the real images in the building', async () => {
    const { fixture, page } = await startMappedHeavy();
    // Edits send the light copy too.
    const make = page.makeRoom('s1', 'STAIR A');
    const edit = http.expectOne(`${PIPELINE_BASE}/authoring/doorways/define-room`);
    expectLight(edit.request.body.building);
    // The service echoes the placeholders, adds a history entry from the current geometry
    // and sends one real image of its own (a new asset).
    const echoed = structuredClone(edit.request.body.building);
    echoed.floors[0].history.push({
      revision: 2,
      at: 't2',
      reason: 'room',
      geometry: { source: source(IMAGE_PLACEHOLDER) },
    });
    const SERVER_IMG = 'data:image/png;base64,SERVER==';
    echoed.assets.a2 = { ...echoed.assets.a1, id: 'a2', dataUrl: SERVER_IMG };
    edit.flush({ building: echoed, summary: withSpaces(regionSpaces) });
    await flush();
    expectLight((await renderBody()).building);
    await make;
    fixture.detectChanges();

    const held = page.building() as unknown as typeof heavyBuilding & {
      assets: Record<string, { dataUrl: string }>;
    };
    expect(held.assets['a1'].dataUrl).toBe(IMG);
    expect(held.assets['a2'].dataUrl).toBe(SERVER_IMG);
    expect(held.floors[0].geometry.source.dataUrl).toBe(IMG);
    expect(held.floors[0].history.map((h) => h.geometry.source.dataUrl)).toEqual([
      IMG_HISTORY,
      IMG,
    ]);

    // Saving a copy and the paid AI run send the full building.
    const saving = page.saveCopy();
    const save = http.expectOne(`${PIPELINE_BASE}/buildings/copies`);
    expect(save.request.body).toBe(held);
    expect(JSON.stringify(save.request.body)).not.toContain(IMAGE_PLACEHOLDER);
    save.flush({ key: 'plan-1', updated: true });
    await flush();
    http.expectOne(`${PIPELINE_BASE}/buildings`).flush({ buildings: [] });
    await saving;

    const building_ = page.buildWithAi(false);
    const job = http.expectOne(`${PIPELINE_BASE}/map-jobs`);
    expect(job.request.body.building).toBe(held);
    expect(job.request.body.building.floors[0].geometry.source.dataUrl).toBe(IMG);
    job.flush({ id: 'job-1' });
    await flush();
    http.expectOne(`${PIPELINE_BASE}/map-jobs/job-1`).flush({
      id: 'job-1',
      status: 'complete',
      result: { status: 'complete', stats: { calls: 1, tokens: 10 }, summary: {} },
    });
    await flush();
    const apply = http.expectOne(`${PIPELINE_BASE}/map-jobs/job-1/apply`);
    expect(apply.request.body.building.assets.a1.dataUrl).toBe(IMG);
    apply.flush({ building: structuredClone(held) });
    await flush();
    const place = http.expectOne(`${PIPELINE_BASE}/authoring/doorways/place`);
    expectLight(place.request.body.building);
    place.flush({
      building: structuredClone(place.request.body.building),
      summary: withSpaces(regionSpaces),
    });
    await flush();
    await renderBody();
    await building_;
    const after = page.building() as unknown as typeof heavyBuilding;
    expect(after.assets.a1.dataUrl).toBe(IMG);
    expect(after.floors[0].geometry.source.dataUrl).toBe(IMG);
    expect(after.floors[0].history[0].geometry.source.dataUrl).toBe(IMG_HISTORY);
  });

  it('labels "Opens onto" options and counts the room doorways separately', async () => {
    const { el } = await startMapped(withDoors([door]));
    const item = within(el, 'assumed-door');
    const select = within<HTMLSelectElement>(item, 'opens-onto');
    expect([...select.options].map((o) => o.textContent!.trim())).toEqual([
      'Hallway 3 · hallway · 120 px (current)',
      'Open lobby 2 · lobby · 80 px',
      '102 · room · 41 px',
    ]);
    expect(select.value).toBe('3');
    expect(within(item, 'room-doors').textContent!.trim()).toBe('This room has 2 doorway(s).');
    expect(item.textContent).toContain('Opens onto (3 options)');
    expect(within(item, 'opens-onto-text')).toBeNull();
  });

  it('shows a single "Opens onto" option as text instead of a select', async () => {
    const { el } = await startMapped(
      withDoors([{ ...door, roomDoors: 1, candidates: [door.candidates[0]] }]),
    );
    const item = within(el, 'assumed-door');
    expect(within(item, 'opens-onto')).toBeNull();
    expect(item.querySelector('select')).toBeNull();
    expect(within(item, 'opens-onto-text').textContent).toContain(
      'Hallway 3 · hallway · 120 px (current)',
    );
    expect(within(item, 'room-doors').textContent).toContain('This room has 1 doorway(s).');
  });

  it('offers every role and explains them to the map author', async () => {
    const { el } = await startMapped();
    expect(within(el, 'role-intro').textContent).toContain('Choose how each region is used');
    expect(within(el, 'role-intro').textContent).toContain('people also walk through');
    expect(within(el, 'role-intro').textContent).toContain('routes never use it');
    const select = within<HTMLSelectElement>(row(el, 'r1'), 'region-kind');
    expect(select.getAttribute('aria-label')).toBe('Use 101 as');
    expect([...select.options].map((o) => [o.value, o.textContent!.trim()])).toEqual([
      ['room', 'Room'],
      ['hall-room', 'Hall room'],
      ['corridor', 'Hallway'],
      ['lobby', 'Lobby or hall'],
      ['stair', 'Stair'],
      ['closed', 'Closed (no access)'],
    ]);
    expect(select.value).toBe('room');
    expect(within(row(el, 'r1'), 'kind-badge').textContent!.trim()).toBe('room');
    expect(row(el, 'r1').querySelector('[data-testid="region-stair"]')).toBeNull();
  });

  it('posts each role and shows the recorded role', async () => {
    const { fixture, page, el } = await startMapped();
    const base = regionSpaces[0];
    // What the pipeline records for each role (kind, use, stair, closed).
    const recorded: [string, Partial<SpaceSummary>, string, string][] = [
      ['hall-room', { kind: 'room', use: 'hall' }, 'hall-badge', 'a hall room'],
      ['corridor', { kind: 'corridor', use: null }, 'kind-badge', 'a hallway'],
      ['lobby', { kind: 'lobby', use: null }, 'kind-badge', 'a lobby or hall'],
      ['stair', { kind: 'lobby', use: 'stair', stair: true }, 'stair-badge', 'a stair'],
      [
        'closed',
        { kind: 'lobby', use: 'closed', stair: false, closed: true },
        'closed-badge',
        'closed',
      ],
      ['room', { kind: 'room', use: null, closed: false }, 'kind-badge', 'a room'],
    ];
    for (const [role, fields, badge, words] of recorded) {
      const select = within<HTMLSelectElement>(row(el, 'r1'), 'region-kind');
      select.value = role;
      select.dispatchEvent(new Event('change'));
      const req = http.expectOne(`${PIPELINE_BASE}/authoring/spaces/kind`);
      expect(req.request.body).toEqual(
        jasmineLike({ floorId: 'floor-1', spaceId: 'r1', kind: role, reviewer: 'Sam' }),
      );
      req.flush({
        building,
        summary: withSpaces([{ ...base, ...fields }, ...regionSpaces.slice(1)]),
      });
      await renderOverlay();
      fixture.detectChanges();
      expect(within<HTMLSelectElement>(row(el, 'r1'), 'region-kind').value).toBe(role);
      expect(within(row(el, 'r1'), badge)).not.toBeNull();
      expect(page.message()).toContain(`101 is now ${words}`);
    }
    expect(page.message()).toBe('101 is now a room. It is open again.');
  });

  it('shows a hall room with its badge and finds it with the filter', async () => {
    const { fixture, el } = await startMapped(
      withSpaces([{ ...regionSpaces[0], use: 'hall' }, ...regionSpaces.slice(1)]),
    );
    expect(within(row(el, 'r1'), 'hall-badge').textContent!.trim()).toBe('Hall room');
    expect(within(row(el, 'r1'), 'kind-badge')).toBeNull();
    expect(within<HTMLSelectElement>(row(el, 'r1'), 'region-kind').value).toBe('hall-room');
    const filter = within<HTMLInputElement>(el, 'region-filter');
    filter.value = 'hall room';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const rows = [...el.querySelectorAll('[data-testid="region"]')] as HTMLElement[];
    expect(rows.map((r) => r.dataset['regionId'])).toEqual(['r1']);
  });

  it('lists a closed region with its badge and re-opens it by choosing another role', async () => {
    const { fixture, page, el } = await startMapped(
      withSpaces([
        ...regionSpaces.slice(0, 2),
        { ...regionSpaces[2], use: 'closed', closed: true },
      ]),
    );
    expect(within(row(el, 'l1'), 'closed-badge').textContent!.trim()).toBe('Closed');
    expect(row(el, 'l1').classList).toContain('closed');
    expect(within<HTMLSelectElement>(row(el, 'l1'), 'region-kind').value).toBe('closed');
    expect(within(el, 'region-counts').textContent).toContain('2 walkable');
    expect(within(el, 'region-counts').textContent).toContain('1 closed');
    const filter = within<HTMLInputElement>(el, 'region-filter');
    filter.value = 'closed';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(
      [...el.querySelectorAll<HTMLElement>('[data-testid="region"]')].map(
        (r) => r.dataset['regionId'],
      ),
    ).toEqual(['l1']);

    const select = within<HTMLSelectElement>(row(el, 'l1'), 'region-kind');
    select.value = 'lobby';
    select.dispatchEvent(new Event('change'));
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/spaces/kind`);
    expect(req.request.body).toEqual(jasmineLike({ spaceId: 'l1', kind: 'lobby' }));
    req.flush({
      building,
      summary: withSpaces([
        ...regionSpaces.slice(0, 2),
        { ...regionSpaces[2], use: null, closed: false },
      ]),
    });
    await renderOverlay();
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(within(row(el, 'l1'), 'closed-badge')).toBeNull();
    expect(within(row(el, 'l1'), 'kind-badge').textContent!.trim()).toBe('lobby');
    expect(row(el, 'l1').classList).not.toContain('closed');
    expect(within(el, 'region-counts').textContent).not.toContain('closed');
    expect(page.message()).toBe(
      'Open lobby 2 is now a lobby or hall; routes and doorway placement treat it as circulation. It is open again.',
    );
  });

  it('turns a stair into a hallway without asking, and says it is no longer a stair', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const { fixture, page, el } = await startMapped(
      withSpaces([{ ...regionSpaces[0], kind: 'lobby', stair: true }, ...regionSpaces.slice(1)]),
    );
    const select = within<HTMLSelectElement>(row(el, 'r1'), 'region-kind');
    expect(select.value).toBe('stair');

    select.value = 'corridor';
    select.dispatchEvent(new Event('change'));
    const req = http.expectOne(`${PIPELINE_BASE}/authoring/spaces/kind`);
    expect(req.request.body).toEqual(jasmineLike({ spaceId: 'r1', kind: 'corridor' }));
    expect(page.busy()).toBe(true);
    fixture.detectChanges();
    expect(within<HTMLSelectElement>(row(el, 'r1'), 'region-kind').disabled).toBe(true);
    req.flush({
      building,
      summary: withSpaces([
        { ...regionSpaces[0], kind: 'corridor', stair: false },
        ...regionSpaces.slice(1),
      ]),
    });
    await renderOverlay();
    fixture.detectChanges();
    expect(confirm).not.toHaveBeenCalled();
    expect(page.message()).toBe(
      '101 is now a hallway; routes and doorway placement treat it as circulation. It is no longer a stair.',
    );
    expect(within(row(el, 'r1'), 'stair-badge')).toBeNull();
    expect(within(row(el, 'r1'), 'kind-badge').textContent!.trim()).toBe('hallway');
    expect(within<HTMLSelectElement>(row(el, 'r1'), 'region-kind').value).toBe('corridor');
    confirm.mockRestore();
  });

  it('shows a refused role change as an error and keeps the region role', async () => {
    const { fixture, page, el } = await startMapped();
    const select = within<HTMLSelectElement>(row(el, 'h1'), 'region-kind');
    expect(select.value).toBe('corridor');
    select.value = 'room';
    select.dispatchEvent(new Event('change'));
    http
      .expectOne(`${PIPELINE_BASE}/authoring/spaces/kind`)
      .flush({ error: 'Unknown kind.' }, { status: 400, statusText: 'Bad Request' });
    await flush();
    fixture.detectChanges();
    expect(page.error()).toBe('Unknown kind.');
    expect(page.busy()).toBe(false);
    expect(within<HTMLSelectElement>(row(el, 'h1'), 'region-kind').value).toBe('corridor');
    expect(within(el, 'error').textContent).toContain('Unknown kind.');
  });

  it('opens the saved Sam Ibrahim project without starting a model job', async () => {
    const fixture = await start();
    const el = fixture.nativeElement as HTMLElement;
    within<HTMLButtonElement>(el, 'open-sam-project').click();
    http.expectOne(`${PIPELINE_BASE}/buildings/sam-ibrahim`).flush({
      ...building,
      id: 'sam-ibrahim-hardcoded',
      name: 'Sam Ibrahim Building',
    });
    await flush();
    http.expectOne(`${PIPELINE_BASE}/authoring/summary`).flush({
      ...summary,
      id: 'sam-ibrahim-hardcoded',
      name: 'Sam Ibrahim Building',
    });
    await renderOverlay();
    fixture.detectChanges();
    expect(within(el, 'sam-project-notice').textContent).toContain('manually inferred');
    http.expectNone(`${PIPELINE_BASE}/map-jobs`);
  });

  it('routes between floors and keeps the route and endpoints while changing the displayed floor', async () => {
    const upper: FloorSummary = {
      ...summary.floors[0],
      floorId: 'floor-2',
      label: 'Floor 2',
      level: 2,
      rooms: [
        { id: 'r2', label: '201', kind: 'room', ready: true, reason: '', doors: 1 },
        { id: 'r3', label: '202', kind: 'room', ready: false, reason: 'No opening', doors: 0 },
      ],
    };
    const { fixture, page, el } = await startMapped(
      { ...summary, floors: [summary.floors[0], upper] },
      { ...building, floors: [...building.floors, { id: 'floor-2', label: 'Floor 2' }] },
    );
    const destination = el.querySelector('[aria-label="Route destination"]') as HTMLSelectElement;
    expect([...destination.options].map((option) => option.textContent?.trim())).toContain(
      'Floor 2 · 201',
    );
    expect([...destination.options].find((option) => option.value === 'r3')?.disabled).toBe(true);
    await page.setRouteEndpoint('from', 'r1');
    await page.setRouteEndpoint('to', 'r2');
    await page.setRoutePreference('elevator');
    const previewing = page.previewRoute();
    const request = http.expectOne(`${PIPELINE_BASE}/authoring/routes`);
    expect(request.request.body).toEqual(
      jasmineLike({ from: 'r1', to: 'r2', options: { excludeStairs: true } }),
    );
    const lowerPath = [
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    ];
    const upperPath = [
      [
        { x: 5, y: 6 },
        { x: 7, y: 8 },
      ],
    ];
    request.flush({
      route: {
        steps: 3,
        floors: [
          { floorId: 'floor-1', segments: lowerPath },
          { floorId: 'floor-2', segments: upperPath },
        ],
        transitions: [
          {
            connectorId: 'lift-b',
            label: 'Elevator B',
            type: 'elevator',
            fromFloorId: 'floor-1',
            toFloorId: 'floor-2',
          },
        ],
        instructions: [
          {
            text: 'Take Elevator B to Floor 2.',
            floorId: 'floor-1',
            targetFloorId: 'floor-2',
            step: 1,
          },
        ],
      },
    });
    expect(await renderOverlay()).toEqual({ routes: lowerPath });
    await previewing;
    fixture.detectChanges();
    expect(within(el, 'route-details').textContent).toContain('Elevator B · Floor 1 → Floor 2');
    const selecting = page.selectFloor('floor-2');
    expect(await renderOverlay()).toEqual({ routes: upperPath });
    await selecting;
    fixture.detectChanges();
    expect(page.routeFrom()).toBe('r1');
    expect(page.routeTo()).toBe('r2');
    expect(page.routePreview()?.steps).toBe(3);
    expect((el.querySelector('[aria-label="Route destination"]') as HTMLSelectElement).value).toBe(
      'r2',
    );

    const changing = page.setRoutePreference('stairs');
    expect(await renderOverlay()).toEqual({});
    await changing;
    expect(page.routePreview()).toBeNull();
    const retrying = page.previewRoute();
    const stairsRequest = http.expectOne(`${PIPELINE_BASE}/authoring/routes`);
    expect(stairsRequest.request.body.options).toEqual({ elevatorPenalty: 1000 });
    stairsRequest.flush({ route: null, message: 'No connected route.' });
    expect(await renderOverlay()).toEqual({ routes: [] });
    await retrying;
    expect(page.routePreview()).toBeNull();
    expect(page.routeNote()).toBe('No connected route.');
  });

  it('invalidates a displayed route when building data reloads while preserving available endpoints', async () => {
    const { page } = await startMapped();
    page.routeFrom.set('r1');
    page.routeTo.set('r1');
    page.routePreview.set({ steps: 0, floors: [{ floorId: 'floor-1', segments: [] }] });
    const reopening = page.open('plan-1');
    http.expectOne(`${PIPELINE_BASE}/buildings/plan-1`).flush(building);
    await flush();
    http.expectOne(`${PIPELINE_BASE}/authoring/summary`).flush(summary);
    await renderOverlay();
    await reopening;
    expect(page.routePreview()).toBeNull();
    expect(page.routeFrom()).toBe('r1');
    expect(page.routeTo()).toBe('r1');
  });
});

// Partial match without depending on the building payload.
function jasmineLike(expected: Record<string, unknown>) {
  return expect.objectContaining(expected);
}
