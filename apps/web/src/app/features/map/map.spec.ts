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
        marker: {
          AdvancedMarkerElement: class {
            map: unknown;
            constructor(public options: { title?: string }) {
              markers.push(options);
            }
            addListener(_event: string, callback: () => void) {
              Object.assign(this.options, { click: callback });
              return { remove() {} };
            }
          },
        },
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
});
