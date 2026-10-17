import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { vi } from 'vitest';
import { PrototypeRepository } from '../../core/prototype.repository';
import { createPrototypeSeed } from '../../core/prototype.seed';
import { CapturePanel } from './capture-panel';
import { NavigationPage } from './navigation';

describe('visitor navigation session', () => {
  afterEach(() => vi.useRealTimers());

  async function setup(targetId = '') {
    const targets = signal(createPrototypeSeed().targets);
    await TestBed.configureTestingModule({
      imports: [NavigationPage],
      providers: [
        { provide: PrototypeRepository, useValue: { targets } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ target: targetId }) } },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(NavigationPage);
    await fixture.whenStable();
    const page = fixture.componentInstance;
    const destination = page.map().nodes.find((node) => !!node.roomId)!;
    const start = page.map().nodes.find((node) => !node.roomId)!;
    return { targets, fixture, page, destination, start };
  }

  it('opens the published target selected by the workspace link', async () => {
    const target = createPrototypeSeed().targets.filter((item) => !!item.published)[1];
    const { page } = await setup(target.id);
    expect(page.session()?.id).toBe(target.id);
  });

  it('requires heading confirmation and advances through actual connected checkpoints to arrival', async () => {
    const { page, destination, start, fixture } = await setup();
    page.chooseDestination(destination.id);
    page.chooseStart(start.id);
    expect(page.routeIds().length).toBeGreaterThan(1);
    page.startGuidance();
    expect(page.phase()).toBe('planning');
    page.headingConfirmed.set(true);
    page.startGuidance();
    expect(page.phase()).toBe('guiding');
    for (let i = 1; i < page.routeIds().length; i++) page.nextStep();
    await fixture.whenStable();
    expect(page.phase()).toBe('arrived');
    expect(page.position()).toBe(destination.id);
    expect(fixture.nativeElement.textContent).toContain('simulated arrival');
  });

  it('pins an immutable publication and requires explicit refresh to see a later revision', async () => {
    const { page, targets, destination } = await setup();
    page.chooseDestination(destination.id);
    const id = page.session()!.id;
    const original = page.session()!.published!.version;
    targets.update((items) =>
      items.map((target) =>
        target.id !== id
          ? target
          : {
              ...target,
              published: { ...target.published!, version: original + 1 },
            },
      ),
    );
    expect(page.session()!.published!.version).toBe(original);
    expect(page.publicationChanged()).toBe(true);
    page.refreshPublication();
    expect(page.session()!.published!.version).toBe(original + 1);
    expect(page.destination()).toBe('');
  });

  it('cancels an in-flight photo when the destination changes and preserves the confirmed checkpoint', async () => {
    const { page, fixture, destination, start } = await setup();
    page.chooseStart(start.id);
    page.openCamera();
    page.device.permission.set('granted');
    await fixture.whenStable();
    const capture = fixture.debugElement.query(By.directive(CapturePanel))
      .componentInstance as CapturePanel;
    vi.useFakeTimers();
    const pending = capture.capture();
    page.chooseDestination(destination.id);
    await vi.runAllTimersAsync();
    await pending;
    expect(capture.result()).toBeNull();
    expect(page.start()).toBe(start.id);
    expect(page.cameraOpen()).toBe(false);
  });

  it('reports same-version imported replacements and removed publications while preserving the pinned map', async () => {
    const { page, targets, fixture } = await setup();
    const session = page.session()!;
    const originalName = page.map().rooms[0].name;
    targets.update((items) =>
      items.map((target) => {
        if (target.id !== session.id) return target;
        const replacement = structuredClone(target);
        replacement.published!.document.rooms[0].name = 'Imported replacement';
        return replacement;
      }),
    );
    expect(page.publicationChanged()).toBe(true);
    expect(page.map().rooms[0].name).toBe(originalName);
    targets.set([]);
    await fixture.whenStable();
    expect(page.publicationUnavailable()).toBe(true);
    expect(fixture.nativeElement.textContent).toContain('cached snapshot');
    expect(page.session()).toBe(session);
    page.leaveUnavailableSession();
    await fixture.whenStable();
    expect(page.session()).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('No published maps yet');
  });
});
