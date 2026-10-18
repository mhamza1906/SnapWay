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
  const markers: { map: unknown; content: HTMLElement; title: string; click?: () => void }[] = [];
  const sdk = {
    error: signal(''),
    load: async () => ({
      mapId: 'test',
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
            content: HTMLElement;
            title: string;
            click?: () => void;
            constructor(options: { map: unknown; content: HTMLElement; title: string }) {
              this.map = options.map;
              this.content = options.content;
              this.title = options.title;
              markers.push(this);
            }
            addListener(_event: string, callback: () => void) {
              this.click = callback;
              return { remove() {} };
            }
          },
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
      floors: Array.from({ length: 55 }, (_, i) => ({
        target_id: `t${i}`,
        name: `Floor ${i}`,
        code: String(i),
        publication_id: `p${i}`,
        sequence: 1,
      })),
    };
    http.expectOne('/api/maps/public/buildings/').flush({ buildings: [building] });
    await fixture.whenStable();
    expect(fixture.componentInstance.error()).toBe('');
    await vi.waitFor(() => expect(markers.length).toBe(1));
    expect(markers[0].content.querySelector('path')?.getAttribute('fill')).toBe('#f4c63d');
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
});
