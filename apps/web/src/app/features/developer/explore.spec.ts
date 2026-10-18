import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { GoogleMapsService } from '../../core/google-maps.service';
import { AuthService } from '../../core/auth.service';
import { ExplorePage } from './explore';

describe('Developer Explore', () => {
  const map = { addListener: vi.fn(), panTo: vi.fn(), setZoom: vi.fn(), fitBounds: vi.fn() };
  const markers: {
    map: unknown;
    title: string;
    icon?: { url: string };
    click?: () => void;
    setMap?: (value: unknown) => void;
  }[] = [];
  const sdk = {
    error: signal(''),
    load: async () => ({
      mapId: 'DEMO_MAP_ID',
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
          title: string;
          icon?: { url: string };
          click?: () => void;
          constructor(options: { map: unknown; title: string; icon?: { url: string } }) {
            this.map = options.map;
            this.title = options.title;
            this.icon = options.icon;
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
        marker: {
          AdvancedMarkerElement: class {},
        },
        event: { clearInstanceListeners: vi.fn() },
        importLibrary: async () => ({}),
      },
    }),
  };
  beforeEach(() => {
    markers.length = 0;
    map.addListener.mockClear();
    TestBed.configureTestingModule({
      imports: [ExplorePage],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: GoogleMapsService, useValue: sdk },
        { provide: AuthService, useValue: { canAdmin: () => false } },
      ],
    });
  });
  it('keeps yellow markers while opening, closing and progressively scrolling a long floor list', async () => {
    const fixture = TestBed.createComponent(ExplorePage);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    const building = {
      id: 'b1',
      name: 'Published building',
      address: 'Campus',
      latitude: 43.7,
      longitude: -79.1,
      published: true,
      floors: Array.from({ length: 55 }, (_, i) => ({
        target_id: `t${i}`,
        name: `Floor ${i}`,
        code: String(i),
        publication_id: `p${i}`,
        sequence: 1,
        published: true,
      })),
    };
    http.expectOne('/api/maps/workspace/buildings/').flush({ buildings: [building] });
    await fixture.whenStable();
    expect(fixture.componentInstance.error()).toBe('');
    await vi.waitFor(() => expect(markers.length).toBe(1));
    expect(markers[0].icon?.url).toContain(encodeURIComponent('#f4c63d'));
    markers[0].click!();
    fixture.detectChanges();
    expect(fixture.componentInstance.visibleFloors().length).toBe(20);
    fixture.componentInstance.moreFloors({
      target: { scrollTop: 950, clientHeight: 400, scrollHeight: 1400 },
    } as unknown as Event);
    expect(fixture.componentInstance.visibleFloors().length).toBe(40);
    fixture.componentInstance.moreFloors({
      target: { scrollTop: 950, clientHeight: 400, scrollHeight: 1400 },
    } as unknown as Event);
    expect(fixture.componentInstance.visibleFloors().length).toBe(55);
    fixture.componentInstance.selected.set(null);
    fixture.componentInstance.query.set('Different building');
    fixture.detectChanges();
    expect(markers[0].map).toBe(map);
    expect(markers.length).toBe(1);
    http.verify();
    fixture.destroy();
    expect(markers[0].map).toBeNull();
  });

  it('renders draft buildings with red markers', async () => {
    const fixture = TestBed.createComponent(ExplorePage);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/maps/workspace/buildings/').flush({
      buildings: [
        {
          id: 'b2',
          name: 'Draft building',
          address: '',
          latitude: 43.788,
          longitude: -79.19,
          published: false,
          floors: [
            {
              target_id: 't-draft',
              name: 'Floor 2',
              code: '2',
              publication_id: null,
              sequence: 0,
              published: false,
            },
          ],
        },
      ],
    });
    await fixture.whenStable();
    await vi.waitFor(() => expect(markers.length).toBe(1));
    expect(markers[0].icon?.url).toContain(encodeURIComponent('#e25b45'));
    fixture.destroy();
  });
});
