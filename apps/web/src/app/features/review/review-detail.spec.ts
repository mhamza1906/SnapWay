import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import {
  PrototypeRepository,
  PROTOTYPE_STORAGE,
  PROTOTYPE_STORAGE_KEY,
} from '../../core/prototype.repository';
import { ReviewDetailPage } from './review-detail';

describe('ReviewDetailPage', () => {
  let fixture: ComponentFixture<ReviewDetailPage>;
  let repository: PrototypeRepository;
  let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;

  function button(text: string): HTMLButtonElement {
    return [...fixture.nativeElement.querySelectorAll('button')].find((item) =>
      (item as HTMLButtonElement).textContent?.includes(text),
    ) as HTMLButtonElement;
  }

  beforeEach(async () => {
    localStorage.removeItem(PROTOTYPE_STORAGE_KEY);
    params = new BehaviorSubject(convertToParamMap({ id: 'innovation-review' }));
    await TestBed.configureTestingModule({
      imports: [ReviewDetailPage],
      providers: [
        provideRouter([]),
        { provide: PROTOTYPE_STORAGE, useValue: localStorage },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: params.asObservable(), snapshot: { paramMap: params.value } },
        },
      ],
    }).compileComponents();
    repository = TestBed.inject(PrototypeRepository);
    fixture = TestBed.createComponent(ReviewDetailPage);
    await fixture.whenStable();
  });

  afterEach(() => localStorage.removeItem(PROTOTYPE_STORAGE_KEY));

  it('compares two real maps and presents the actual annotation addition', () => {
    expect(fixture.nativeElement.querySelectorAll('app-map-canvas')).toHaveLength(2);
    const rows = [
      ...fixture.nativeElement.querySelectorAll('.diff-table tbody tr'),
    ] as HTMLElement[];
    const annotations = rows.find((row) => row.textContent?.includes('Labels & pins'))!;
    expect(annotations.textContent).toContain('+1');
    expect(fixture.nativeElement.textContent).toContain('Confirm lift access');
  });

  it('requires feedback before a real request-changes command and then unlocks editing', async () => {
    button('Request changes').click();
    await fixture.whenStable();
    expect(repository.getContribution('innovation-review')!.status).toBe('submitted');
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'Add specific feedback',
    );
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Please verify the new landmark location.';
    textarea.dispatchEvent(new Event('input'));
    button('Request changes').click();
    await fixture.whenStable();
    expect(repository.getContribution('innovation-review')!.status).toBe('changes-requested');
    expect(fixture.nativeElement.textContent).toContain('Please verify the new landmark location.');
    expect(fixture.nativeElement.querySelector('a[href="/editor/innovation-review"]')).toBeTruthy();
  });

  it('publishes only after the explicit confirmation and shows the updated revision', async () => {
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn();
    button('Publish revision').click();
    expect(dialog.showModal).toHaveBeenCalled();
    expect(repository.getTarget('innovation')!.published!.version).toBe(3);
    button('Confirm publication').click();
    await fixture.whenStable();
    expect(repository.getTarget('innovation')!.published!.version).toBe(4);
    expect(repository.getContribution('innovation-review')!.status).toBe('merged');
    expect(fixture.nativeElement.textContent).toContain('This contribution has been published');
  });

  it('refuses confirmation after the reviewed draft changes', async () => {
    const dialog = fixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn();
    button('Publish revision').click();
    repository.review('innovation-review', 'changes-requested', 'Hold this change.');
    await fixture.whenStable();
    fixture.componentInstance.publish(dialog);
    await fixture.whenStable();
    expect(repository.getTarget('innovation')!.published!.version).toBe(3);
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      'map changed',
    );
  });

  it('requires explicit manual reconciliation acknowledgement and preserves the complete draft', async () => {
    repository.review('innovation-review', 'publish', 'Approved');
    params.next(convertToParamMap({ id: 'innovation-draft' }));
    await fixture.whenStable();
    const before = JSON.stringify(repository.getContribution('innovation-draft')!.document);
    const reconcile = button('Record manual reconciliation');
    expect(reconcile.disabled).toBe(true);
    const checkbox = fixture.nativeElement.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    checkbox.click();
    await fixture.whenStable();
    expect(reconcile.disabled).toBe(false);
    reconcile.click();
    await fixture.whenStable();
    expect(repository.getContribution('innovation-draft')!.baseRevision).toBe(4);
    expect(JSON.stringify(repository.getContribution('innovation-draft')!.document)).toBe(before);
    expect(fixture.nativeElement.querySelector('.reconciliation-panel')).toBeNull();
  });

  it('renders a useful not-found page when a contribution no longer exists', async () => {
    params.next(convertToParamMap({ id: 'missing-contribution' }));
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('Contribution not found');
    expect(fixture.nativeElement.querySelector('a[href="/review"]')).toBeTruthy();
  });

  it('compares a retained starting publication after the current revision advances', async () => {
    repository.review('innovation-review', 'publish', 'Approved');
    params.next(convertToParamMap({ id: 'innovation-draft' }));
    await fixture.whenStable();
    expect(fixture.componentInstance.publishedMap().annotations).toHaveLength(3);
    button('Starting revision 3').click();
    await fixture.whenStable();
    expect(fixture.componentInstance.publishedMap().annotations).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('input[type="checkbox"]').disabled).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('Starting publication');
  });

  it('lets reviewers inspect the actual linked photo and source image without navigating away', async () => {
    repository.review('innovation-review', 'changes-requested', 'Add scene evidence');
    const document = structuredClone(repository.getContribution('innovation-review')!.document);
    document.sourceImage = '/demo/floor-plan.svg';
    document.references.push({
      id: 'review-reference',
      name: 'Entrance photograph',
      image: '/demo/floor-plan.svg',
      nodeId: 'entrance',
      direction: 'East',
      description: 'The main entrance faces the corridor.',
      reviewed: true,
      createdAt: new Date().toISOString(),
    });
    repository.saveDraft('innovation-review', document);
    repository.submit('innovation-review', 'Scene evidence attached');
    await fixture.whenStable();
    const dialog = fixture.nativeElement.querySelector('.evidence-dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();
    fixture.nativeElement.querySelector('button[aria-label="Enlarge Entrance photograph"]').click();
    await fixture.whenStable();
    expect(dialog.showModal).toHaveBeenCalled();
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/demo/floor-plan.svg');
    expect(fixture.nativeElement.textContent).toContain('Main entrance');
    expect(fixture.nativeElement.textContent).toContain('Facing East');
  });
});
