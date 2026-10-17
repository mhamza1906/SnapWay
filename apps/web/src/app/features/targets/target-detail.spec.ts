import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { By } from '@angular/platform-browser';
import { vi } from 'vitest';
import {
  PrototypeRepository,
  PROTOTYPE_STORAGE,
  PROTOTYPE_STORAGE_KEY,
} from '../../core/prototype.repository';
import { MapCanvas } from '../../shared/map-canvas';
import { TargetsPage } from './targets';
import { TargetDetailPage } from './target-detail';

describe('mapping target UI journeys', () => {
  let harness: RouterTestingHarness;
  let repository: PrototypeRepository;

  function button(label: string): HTMLButtonElement {
    return [...harness.routeNativeElement!.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === label,
    )!;
  }

  beforeEach(async () => {
    localStorage.removeItem(PROTOTYPE_STORAGE_KEY);
    await TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'targets', component: TargetsPage },
          { path: 'targets/:id', component: TargetDetailPage },
        ]),
        { provide: PROTOTYPE_STORAGE, useValue: localStorage },
      ],
    }).compileComponents();
    repository = TestBed.inject(PrototypeRepository);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => localStorage.removeItem(PROTOTYPE_STORAGE_KEY));

  it('shows required-field feedback, then creates a real target and navigates to its detail', async () => {
    await harness.navigateByUrl('/targets', TargetsPage);
    const before = repository.targets().length;
    const form = harness.routeNativeElement!.querySelector('form')!;
    const dialog = harness.routeNativeElement!.querySelector('dialog')!;
    dialog.close = vi.fn();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await harness.fixture.whenStable();
    expect(repository.targets()).toHaveLength(before);
    expect(harness.routeNativeElement!.textContent).toContain('Complete every field');
    for (const [control, value] of Object.entries({
      name: 'Test Learning Centre',
      building: 'North Campus',
      floor: 'Level 2',
      description: 'Map the study rooms and accessible entrances.',
    })) {
      const field = form.querySelector(`[formControlName="${control}"]`) as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await harness.fixture.whenStable();
    const created = repository.targets().find((target) => target.name === 'Test Learning Centre')!;
    expect(created).toBeDefined();
    expect(TestBed.inject(Router).url).toBe(`/targets/${created.id}`);
    expect(harness.routeDebugElement!.componentInstance).toBeInstanceOf(TargetDetailPage);
    expect(harness.routeNativeElement!.textContent).toContain('No publication yet');
    expect(dialog.close).toHaveBeenCalledOnce();
  });

  it('renders a selected historical map without changing the current publication', async () => {
    repository.review('innovation-review', 'publish', 'Approved');
    const page = await harness.navigateByUrl('/targets/innovation', TargetDetailPage);
    const latest = repository.getTarget('innovation')!.published!;
    button('View map').click();
    await harness.fixture.whenStable();
    expect(page.displayedRevision()!.version).toBe(3);
    const map = harness.routeDebugElement!.query(By.directive(MapCanvas))
      .componentInstance as MapCanvas;
    expect(map.document().annotations).toHaveLength(2);
    expect(repository.getTarget('innovation')!.published).toBe(latest);
    expect(latest.version).toBe(4);
    expect(latest.document.annotations).toHaveLength(3);
    button('Return to latest').click();
    await harness.fixture.whenStable();
    expect(page.displayedRevision()!.version).toBe(4);
  });

  it('archives only after confirmation and makes contribution creation unavailable in the page', async () => {
    await harness.navigateByUrl('/targets/innovation', TargetDetailPage);
    const dialog = harness.routeNativeElement!.querySelector('dialog')!;
    dialog.showModal = vi.fn();
    dialog.close = vi.fn();
    button('Archive').click();
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(repository.getTarget('innovation')!.status).toBe('open');
    button('Archive target').click();
    await harness.fixture.whenStable();
    expect(repository.getTarget('innovation')!.status).toBe('archived');
    expect(button('Start contribution').disabled).toBe(true);
    const before = repository.contributions().length;
    button('Start contribution').click();
    await harness.fixture.whenStable();
    expect(repository.contributions()).toHaveLength(before);
    expect(harness.routeNativeElement!.textContent).toContain('This target is archived');
  });

  it('recovers from an unknown target through the real browse link', async () => {
    await harness.navigateByUrl('/targets/no-such-target', TargetDetailPage);
    expect(harness.routeNativeElement!.textContent).toContain('find this target');
    const browse = harness.routeNativeElement!.querySelector(
      'a[href="/targets"]',
    ) as HTMLAnchorElement;
    expect(browse.textContent).toContain('Browse targets');
    browse.click();
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/targets');
    expect(harness.routeDebugElement!.componentInstance).toBeInstanceOf(TargetsPage);
  });
});
