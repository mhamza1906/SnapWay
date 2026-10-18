import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { GoogleMapsService } from '../../core/google-maps.service';
import { PublicMapPage } from './map';
import { AuthService } from '../../core/auth.service';

describe('Public building discovery', () => {
  const originalGeolocation = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalGeolocation) Object.defineProperty(navigator, 'geolocation', originalGeolocation);
    else Reflect.deleteProperty(navigator, 'geolocation');
  });
  const map = { panTo: vi.fn(), setZoom: vi.fn(), fitBounds: vi.fn() };
  const markers: { title?: string; click?: () => void }[] = [];
  const sdk = {
    error: signal(''),
    load: async () => ({
      mapId: 'TEST_MAP',
      maps: {
        Map: class {
          constructor() {
            return map;
          }
        },
        LatLngBounds: class {
          extend() {}
        },
        Size: class {
          constructor(
            public width: number,
            public height: number,
          ) {}
        },
        Marker: class {
          map: unknown;
          title?: string;
          click?: () => void;
          constructor(options: { title?: string; map: unknown }) {
            this.map = options.map;
            this.title = options.title;
            markers.push(this);
          }
          setMap(value: unknown) {
            this.map = value;
          }
          addListener(_event: string, callback: () => void) {
            this.click = callback;
            return { remove() {} };
          }
        },
        marker: { AdvancedMarkerElement: class {} },
        event: { clearInstanceListeners() {} },
      },
    }),
  };

  beforeEach(() => {
    markers.length = 0;
    TestBed.configureTestingModule({
      imports: [PublicMapPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: GoogleMapsService, useValue: sdk },
      ],
    });
  });

  it('uses published server coordinates for markers and walking directions', async () => {
    TestBed.inject(AuthService).session.set({
      authenticated: true,
      username: 'Mapper',
      mode: 'developer',
    });
    const fixture = TestBed.createComponent(PublicMapPage);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('a[href="/overview"]').textContent).toContain(
      'Open workspace',
    );
    const http = TestBed.inject(HttpTestingController);
    const building = {
      id: 'real-id',
      name: 'Real building',
      address: 'Real address',
      latitude: 43.1,
      longitude: -80.1,
      floors: [
        { target_id: 't', name: 'First floor', code: '1', publication_id: 'p', sequence: 2 },
      ],
    };
    http.expectOne('/api/maps/public/buildings/').flush({ buildings: [building] });
    http.expectOne('/api/maps/drafts/ensure/').flush({ drafts: [] });
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    fixture.detectChanges();
    expect(markers[0].title).toBe('Real building');
    markers[0].click?.();
    expect(fixture.componentInstance.selected()?.id).toBe('real-id');
    const link = fixture.nativeElement.querySelector(
      'a[href*="google.com/maps/dir/"]',
    ) as HTMLAnchorElement;
    expect(new URL(link.href).searchParams.get('destination')).toBe('43.1,-80.1');
    expect(fixture.nativeElement.textContent).not.toContain('Innovation');
    fixture.componentInstance.query.set('not-in-the-catalog');
    expect(fixture.componentInstance.filtered()).toEqual([]);
    fixture.componentInstance.query.set('REAL ADDRESS');
    expect(fixture.componentInstance.filtered().length).toBe(1);
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (
          ok: (position: {
            coords: { latitude: number; longitude: number; accuracy: number };
          }) => void,
        ) => ok({ coords: { latitude: 43.2, longitude: -80.2, accuracy: 12 } }),
      },
    });
    fixture.componentInstance.locate();
    expect(fixture.componentInstance.location()?.accuracy).toBe(12);
    expect(map.panTo).toHaveBeenLastCalledWith({ lat: 43.2, lng: -80.2, accuracy: 12 });
    expect(fixture.componentInstance.locationMessage()).toContain('accuracy about 12 m');
    http.verify();
  });

  it('shows an honest empty state and handles denied geolocation', async () => {
    const fixture = TestBed.createComponent(PublicMapPage);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/maps/public/buildings/').flush({ buildings: [] });
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No published buildings yet');
    expect(fixture.nativeElement.querySelector('.saved-maps')).toBeNull();
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_ok: unknown, fail: (error: { code: number }) => void) =>
          fail({ code: 1 }),
      },
    });
    fixture.componentInstance.locate();
    expect(fixture.componentInstance.locationMessage()).toContain('permission was denied');
    expect(fixture.componentInstance.location()).toBeNull();
    http.verify();
  });

  it('opens the selected saved Sam Ibrahim walk when Google Maps fails, including after late sign-in', async () => {
    vi.spyOn(sdk, 'load').mockRejectedValueOnce(new Error('Google Maps is not configured yet.'));
    const fixture = TestBed.createComponent(PublicMapPage);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/maps/public/buildings/').flush({ buildings: [] });
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    const auth = TestBed.inject(AuthService);
    auth.session.set({ authenticated: true, username: 'arjun' });
    fixture.detectChanges();
    http.expectOne('/api/maps/drafts/ensure/').flush({
      drafts: [
        { target_id: 'level-2', title: 'Sam Ibrahim · Level 2 circulation 2', floor: 'Level 2' },
        { target_id: 'level-5', title: 'Sam Ibrahim · Level 5 circulation 1', floor: 'Level 5' },
      ],
    });
    await vi.waitFor(() => expect(fixture.componentInstance.walksLoading()).toBe(false));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Google Maps is not configured yet.');
    expect(fixture.nativeElement.textContent).toContain('2 saved maps');
    expect(fixture.nativeElement.textContent).toContain('Sam Ibrahim · Level 5');
    const picker = fixture.nativeElement.querySelector('.saved-maps select') as HTMLSelectElement;
    picker.value = 'level-5';
    picker.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    const link = fixture.nativeElement.querySelector('.saved-maps a') as HTMLAnchorElement;
    const url = new URL(link.href);
    expect(url.pathname).toBe('/graph-editor');
    expect(url.searchParams.get('mode')).toBe('photos');
    expect(url.searchParams.get('target')).toBe('level-5');
    expect(fixture.componentInstance.buildings()).toEqual([]);
    auth.session.set({ authenticated: false });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.saved-maps')).toBeNull();
    expect(fixture.componentInstance.savedMaps()).toEqual([]);
    http.verify();
  });

  it('retries a failed saved-map request and discards its response after sign-out', async () => {
    const auth = TestBed.inject(AuthService);
    auth.session.set({ authenticated: true, username: 'arjun' });
    const fixture = TestBed.createComponent(PublicMapPage);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/maps/public/buildings/').flush({ buildings: [] });
    http
      .expectOne('/api/maps/drafts/ensure/')
      .flush({}, { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(fixture.componentInstance.walksLoading()).toBe(false));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Your saved maps could not be loaded.');
    fixture.nativeElement.querySelector('.saved-maps button').click();
    fixture.detectChanges();
    const retry = http.expectOne('/api/maps/drafts/ensure/');
    auth.session.set({ authenticated: false });
    fixture.detectChanges();
    retry.flush({ drafts: [{ target_id: 'private', title: 'Private walk', floor: '1' }] });
    await Promise.resolve();
    fixture.detectChanges();
    expect(fixture.componentInstance.savedMaps()).toEqual([]);
    expect(fixture.nativeElement.querySelector('.saved-maps')).toBeNull();
    http.verify();
  });
});
