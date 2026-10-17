import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';
import { PrototypeRepository, PROTOTYPE_STORAGE } from '../../core/prototype.repository';
import { EditorPage } from './editor';

describe('Editor draft interactions', () => {
  let fixture: ComponentFixture<EditorPage>;
  let page: EditorPage;
  let repository: PrototypeRepository;
  let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;

  beforeEach(async () => {
    params = new BehaviorSubject(convertToParamMap({ id: 'innovation-draft' }));
    const values = new Map<string, string>();
    TestBed.configureTestingModule({
      imports: [EditorPage],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { paramMap: params, snapshot: { paramMap: params.value } },
        },
        {
          provide: PROTOTYPE_STORAGE,
          useValue: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(EditorPage);
    page = fixture.componentInstance;
    repository = TestBed.inject(PrototypeRepository);
    await fixture.whenStable();
  });

  afterEach(() => vi.useRealTimers());

  it('edits a room through its form, undoes and redoes it, then saves only the draft', async () => {
    page.select('r101');
    await fixture.whenStable();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('[formControlName="name"]');
    input.value = 'Design studio';
    input.dispatchEvent(new Event('input'));
    const form: HTMLFormElement = input.closest('form')!;
    form.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(page.document().rooms[0].name).toBe('Design studio');
    expect(page.document().nodes.find((node) => node.id === 'node-r101')?.label).toBe(
      'Design studio',
    );
    expect(page.dirty()).toBe(true);
    page.undo();
    expect(page.document().rooms[0].name).toBe('Studio 101');
    page.redo();
    expect(page.save()).toBe(true);
    expect(repository.getContribution('innovation-draft')!.document.rooms[0].name).toBe(
      'Design studio',
    );
    expect(repository.getTarget('innovation')!.published!.document.rooms[0].name).toBe(
      'Studio 101',
    );
    expect(page.dirty()).toBe(false);
  });

  it('adds a marker and a connected waypoint without duplicate graph edges', () => {
    page.setTool('pin');
    page.place({ x: 400, y: 320 });
    expect(page.document().annotations.at(-1)?.type).toBe('pin');
    page.setTool('waypoint');
    page.place({ x: 450, y: 320 });
    const newNode = page.selected();
    const previousCount = page.document().edges.length;
    page.setTool('connect');
    page.select('hall-centre');
    page.select(newNode);
    expect(page.document().edges).toHaveLength(previousCount + 1);
    page.setTool('connect');
    page.select(newNode);
    page.select('hall-centre');
    expect(page.document().edges).toHaveLength(previousCount + 1);
    expect(page.error()).toContain('already connected');
  });

  it('requires explicit AI apply and rejects a proposal after a newer manual edit', async () => {
    page.select('r101');
    await fixture.whenStable();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    page.suggest('Rename selected room to AI studio');
    page.runAssistant();
    await vi.advanceTimersByTimeAsync(1600);
    expect(page.aiState()).toBe('proposal');
    expect(page.document().rooms[0].name).toBe('Studio 101');
    page.properties.patchValue({ name: 'Manual studio' });
    page.applyProperties();
    page.applyProposal();
    expect(page.aiState()).toBe('error');
    expect(page.aiDescription()).toContain('stale');
    expect(page.document().rooms[0].name).toBe('Manual studio');
  });

  it('cancels delayed AI results and recovers from a simulated failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    page.suggest('Add label Quiet area');
    const originalCount = page.document().annotations.length;
    page.runAssistant();
    page.cancelAssistant();
    await vi.advanceTimersByTimeAsync(1600);
    expect(page.aiState()).toBe('cancelled');
    expect(page.document().annotations).toHaveLength(originalCount);
    page.aiFailure.set(true);
    page.runAssistant();
    await vi.advanceTimersByTimeAsync(1600);
    expect(page.aiState()).toBe('error');
    page.runAssistant(true);
    await vi.advanceTimersByTimeAsync(1600);
    expect(page.aiState()).toBe('proposal');
    page.applyProposal();
    expect(page.document().annotations).toHaveLength(originalCount + 1);
    page.applyProposal();
    expect(page.document().annotations).toHaveLength(originalCount + 1);
  });

  it('retains newer edits when another session changes the saved draft version', () => {
    page.setTool('label');
    page.place({ x: 120, y: 410 });
    const saved = repository.getContribution('innovation-draft')!;
    repository.saveDraft(saved.id, saved.document, saved.version);
    expect(page.save()).toBe(false);
    expect(page.dirty()).toBe(true);
    expect(page.error()).toMatch(/changed|version|newer|conflict/i);
  });

  it('adds reviewed evidence and protects waypoints referenced by it', () => {
    page.useSample('reference');
    page.referenceForm.patchValue({ nodeId: 'hall-centre', reviewed: true });
    page.saveReference();
    expect(page.document().references).toHaveLength(1);
    expect(page.document().references[0].reviewed).toBe(true);
    page.select('hall-centre');
    page.removeSelected();
    expect(page.document().nodes.some((node) => node.id === 'hall-centre')).toBe(true);
    expect(page.error()).toContain('reference photos');
  });

  it('updates to another contribution on route changes and blocks submitted edits', async () => {
    params.next(convertToParamMap({ id: 'innovation-review' }));
    await fixture.whenStable();
    expect(page.id()).toBe('innovation-review');
    expect(page.readonly()).toBe(true);
    const before = JSON.stringify(page.document());
    page.useSample();
    page.setTool('pin');
    page.place({ x: 400, y: 300 });
    expect(page.save()).toBe(false);
    expect(JSON.stringify(page.document())).toBe(before);
    params.next(convertToParamMap({ id: 'missing' }));
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Contribution not found');
  });
});
