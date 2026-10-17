import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';
import { PrototypeRepository, PROTOTYPE_STORAGE } from '../../core/prototype.repository';
import { EditorPage } from './editor';

// Real 1×1 PNG bytes travel through File and FileReader; only browser image decoding is mocked.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6h1cAAAAASUVORK5CYII=';

describe('Editor image upload boundary', () => {
  let fixture: ComponentFixture<EditorPage>;
  let page: EditorPage;
  let repository: PrototypeRepository;
  let params: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let decode: 'success' | 'failure' | 'pending';
  let decodingStarted: ((finish: () => void) => void) | undefined;

  function pngFile(): File {
    return new File(
      [Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0))],
      'floor-plan.png',
      { type: 'image/png' },
    );
  }

  function fileEvent(file: File): Event {
    const input = document.createElement('input');
    input.type = 'file';
    Object.defineProperty(input, 'files', { value: [file] });
    const event = new Event('change');
    Object.defineProperty(event, 'target', { value: input });
    return event;
  }

  beforeEach(async () => {
    decode = 'success';
    decodingStarted = undefined;
    vi.stubGlobal(
      'Image',
      class {
        onload: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        set src(_source: string) {
          if (decode === 'pending') {
            decodingStarted?.(() => this.onload?.(new Event('load')));
          } else {
            queueMicrotask(() =>
              decode === 'failure'
                ? this.onerror?.(new Event('error'))
                : this.onload?.(new Event('load')),
            );
          }
        }
      },
    );
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

  afterEach(() => vi.unstubAllGlobals());

  it('attaches real FileReader PNG data, saves it and reloads the saved draft', async () => {
    await page.upload(fileEvent(pngFile()), 'source');
    await fixture.whenStable();
    expect(page.document().sourceImage).toBe(`data:image/png;base64,${PNG}`);
    expect(page.layer()).toBe('source');
    expect(page.dirty()).toBe(true);
    expect(page.save()).toBe(true);
    const stored = repository.getContribution('innovation-draft')!.document.sourceImage;
    expect(stored).toBe(`data:image/png;base64,${PNG}`);
    page.document.set({ rooms: [], nodes: [], edges: [], annotations: [], references: [] });
    page.reloadSaved();
    expect(page.document().sourceImage).toBe(stored);
    expect(repository.getTarget('innovation')!.published!.document.sourceImage).toBeUndefined();
    expect(page.uploading()).toBe(false);
  });

  it('rejects unsupported and oversized files while retaining the existing draft image', async () => {
    page.useSample();
    const before = JSON.stringify(page.document());
    await page.upload(
      fileEvent(new File(['<svg/>'], 'untrusted.svg', { type: 'image/svg+xml' })),
      'source',
    );
    expect(page.error()).toContain('SVG uploads are not supported');
    expect(JSON.stringify(page.document())).toBe(before);
    const large = new File([new Uint8Array(1024 * 1024 + 1)], 'large.png', { type: 'image/png' });
    await page.upload(fileEvent(large), 'source');
    expect(page.error()).toContain('smaller than 1 MB');
    expect(JSON.stringify(page.document())).toBe(before);
    expect(page.uploading()).toBe(false);
  });

  it('keeps the previous image and editable draft when decoding fails after file reading', async () => {
    page.useSample();
    const before = JSON.stringify(page.document());
    decode = 'failure';
    await page.upload(fileEvent(pngFile()), 'source');
    expect(page.error()).toContain('not a readable image');
    expect(JSON.stringify(page.document())).toBe(before);
    expect(page.dirty()).toBe(true);
    expect(page.uploading()).toBe(false);
  });

  it('ignores a late decoded upload after navigation to a different editable contribution', async () => {
    const other = repository.startContribution('science');
    decode = 'pending';
    const decoder = new Promise<() => void>((resolve) => {
      decodingStarted = resolve;
    });
    const uploading = page.upload(fileEvent(pngFile()), 'source');
    const finishDecoding = await decoder;
    params.next(convertToParamMap({ id: other.id }));
    await fixture.whenStable();
    expect(page.id()).toBe(other.id);
    finishDecoding();
    await uploading;
    expect(page.document().sourceImage).toBeUndefined();
    expect(page.document().rooms).toHaveLength(0);
    expect(page.dirty()).toBe(false);
    expect(repository.getContribution('innovation-draft')!.document.sourceImage).toBeUndefined();
    expect(page.uploading()).toBe(false);
  });
});
