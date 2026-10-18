import { TestBed } from '@angular/core/testing';
import { MovementLab } from './movement-lab';
import { NavigationSensors } from './navigation-sensors';
import type { LabPlan } from './movement-model';

const plan: LabPlan = {
  title: 'Test Level 1',
  floor: 'Level 1',
  width: 100,
  height: 100,
  entryId: 'entry',
  entryLabel: 'Point 19',
  entryEvidence: 'Test only',
  metresPerUnit: null,
  northDegrees: null,
  underlay: '/experiments/clean.svg',
  nodes: [
    { id: 'entry', label: 'Point 19', kind: 'junction', x: 10, y: 10 },
    { id: 'end', label: 'Point 20', kind: 'junction', x: 10, y: 60 },
  ],
  edges: [{ from: 'entry', to: 'end' }],
  nearby: [{ id: 'room', label: 'Test room', kind: 'room', x: 10, y: 60 }],
  outdoor: {
    lat: 43.78838,
    lng: -79.19103,
    radiusM: 70,
    maxAccuracyM: 20,
    label: 'Approximate building',
    coordinateEvidence: 'Unsurveyed',
    coordinateSource: 'https://example.org',
    addressSource: 'https://example.org',
  },
};

describe('Isolated movement experiment', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => structuredClone(plan) }),
    );
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hands two accurate GPS fixes to a clean SVG, requires calibration, and keeps simulation separate from sensors', async () => {
    const motion = vi.spyOn(NavigationSensors.prototype, 'startMotion').mockResolvedValue();
    const fixture = TestBed.createComponent(MovementLab);
    await fixture.whenStable();
    const component = fixture.componentInstance;
    component.receiveLocation({ ...plan.outdoor, accuracy: 5, timestamp: Date.now() - 2100 });
    expect(component.phase()).toBe('outdoor');
    component.receiveLocation({ ...plan.outdoor, accuracy: 5, timestamp: Date.now() });
    fixture.detectChanges();
    expect(component.phase()).toBe('indoor');
    expect(component.confirmed()).toBe(false);
    expect(fixture.nativeElement.querySelector('.map-wrap img').getAttribute('src')).toBe(
      '/experiments/clean.svg',
    );
    expect(fixture.nativeElement.querySelectorAll('.overlay text').length).toBe(0);
    component.calibrate();
    expect(component.calibrated()).toBe(false);
    component.simulateArrival();
    component.calibrateDemo();
    component.demoStep();
    expect(component.mode()).toBe('simulation');
    expect(component.position()!.y).toBeGreaterThan(10);
    expect(component.message()).toContain('SIMULATION');
    expect(motion).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores late permission failure after stopping and does not advance with stale headings', async () => {
    let fail!: (reason: Error) => void;
    vi.spyOn(NavigationSensors.prototype, 'startMotion').mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    vi.spyOn(NavigationSensors.prototype, 'dispose').mockResolvedValue();
    const fixture = TestBed.createComponent(MovementLab);
    await fixture.whenStable();
    const component = fixture.componentInstance;
    component.receiveLocation({ ...plan.outdoor, accuracy: 5, timestamp: Date.now() - 2100 });
    component.receiveLocation({ ...plan.outdoor, accuracy: 5, timestamp: Date.now() });
    component.confirmAnchor();
    const start = component.startMotion();
    component.pause('Stopped intentionally');
    fail(new Error('Late permission error'));
    await start;
    expect(component.message()).toBe('Stopped intentionally');
    component.confirmAnchor();
    component.heading.set({ degrees: 0, timestamp: Date.now() - 10000, reference: 'relative' });
    component.calibrate();
    component.receiveSteps({ total: 1, timestamp: Date.now(), source: 'native' });
    component.receiveSteps({ total: 2, timestamp: Date.now() + 1, source: 'native' });
    expect(component.count()).toBe(0);
    expect(component.position()).toEqual({ x: 10, y: 10 });
    expect(component.calibrated()).toBe(false);
  });

  it('uses the first real session step after measured calibration and rejects invalid sensor timestamps', async () => {
    vi.spyOn(NavigationSensors.prototype, 'startMotion').mockResolvedValue();
    vi.spyOn(NavigationSensors.prototype, 'dispose').mockResolvedValue();
    const fixture = TestBed.createComponent(MovementLab);
    await fixture.whenStable();
    const component = fixture.componentInstance;
    component.receiveLocation({ ...plan.outdoor, accuracy: 5, timestamp: Date.now() - 2100 });
    component.receiveLocation({ ...plan.outdoor, accuracy: 5, timestamp: Date.now() });
    component.confirmAnchor();
    await component.startMotion();
    component.measuredMetres = 5;
    component.heading.set({ degrees: 180, timestamp: NaN, reference: 'relative' });
    component.calibrate();
    expect(component.calibrated()).toBe(false);
    component.heading.set({ degrees: 180, timestamp: Date.now(), reference: 'relative' });
    component.calibrate();
    expect(component.calibrated()).toBe(true);
    component.receiveSteps({ total: 1, timestamp: NaN, source: 'native' });
    expect(component.count()).toBe(0);
    component.receiveSteps({ total: 1, timestamp: Date.now(), source: 'native' });
    expect(component.count()).toBe(1);
    expect(component.position()!.y).toBeGreaterThan(10);
  });
});
