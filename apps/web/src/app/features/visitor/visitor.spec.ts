import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { searchDestinations, type VisitorBuilding } from './visitor.models';
import { VisitorJourney } from './visitor';
import type { MatchResult } from '../../core/place-match';
import { GuidancePhotoView } from './guidance-photo';
import { WalkingMap } from './walking-map';
import { GoogleMapsService } from '../../core/google-maps.service';
import { signal } from '@angular/core';

const building: VisitorBuilding = {
  id: 'ia',
  slug: 'ia',
  name: 'IA Sam Ibrahim Building',
  address: 'Test campus',
  latitude: 43.78,
  longitude: -79.19,
  floors: [
    {
      target_id: 'floor2',
      name: 'Floor 2',
      code: '2',
      publication_id: 'published-v1',
      sequence: 1,
      destinations: [{ id: 'room-2021', label: 'IA2021', name: 'Classroom' }],
      checkpoints: [{ id: 'junction', label: 'East corridor' }],
    },
  ],
};

describe('Installed visitor journey', () => {
  it('renders a supplied guidance photo and its explicit directional arrow', () => {
    const fixture = TestBed.createComponent(GuidancePhotoView);
    fixture.componentRef.setInput('photo', {
      imageUrl: '/reviewed-hall.jpg',
      alt: 'Hallway to IA2021',
      instruction: 'Turn left at the sign.',
      direction: 'left',
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img').getAttribute('alt')).toBe(
      'Hallway to IA2021',
    );
    expect(fixture.nativeElement.querySelector('.arrow.left')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('Turn left at the sign.');
  });
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: GoogleMapsService,
          useValue: {
            error: signal(''),
            load: async () => {
              throw new Error('Maps disabled in this test.');
            },
          },
        },
      ],
    }),
  );
  async function setup(published: VisitorBuilding[] = [building]) {
    const fixture = TestBed.createComponent(VisitorJourney);
    TestBed.inject(HttpTestingController)
      .expectOne('/api/maps/public/buildings/')
      .flush({ buildings: published });
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    return fixture;
  }
  it('supports building-first selection and a direct room search', async () => {
    const page = (await setup()).componentInstance;
    const results = searchDestinations([building], 'IA', null);
    expect(results.some((r) => !r.room && r.building.id === 'ia')).toBe(true);
    page.choose(results.find((r) => !r.room)!);
    expect(page.destination()).toBeNull();
    expect(page.options()[0].room?.label).toBe('IA2021');
    page.changeBuilding();
    page.choose(searchDestinations([building], 'IA2021', null)[0]);
    expect(page.destination()?.room?.id).toBe('room-2021');
    expect(page.building()?.id).toBe('ia');
  });
  it('offers both real-location demos with an empty API and routes a room or building correctly', async () => {
    const page = (await setup([])).componentInstance;
    expect(page.buildings()).toHaveLength(2);
    page.choose(searchDestinations(page.buildings(), 'IA', null).find((option) => !option.room)!);
    expect(page.locationPrompt()).toBe(false);
    page.choose(page.options().find((option) => option.room?.label === 'IA5061')!);
    expect(page.destination()?.floor?.name).toBe('5th floor');
    expect(new URL(page.directions()).searchParams.get('destination')).toBe('43.788609,-79.191116');
    page.chooseEnvironment(true);
    expect(page.cameraOpen()).toBe(true);
    page.demoPhotoCaptured();
    expect(page.cameraOpen()).toBe(false);
    expect(page.confirmedLocation()).toBe('');
    expect(page.message()).toContain('your location has not been determined');
    page.end();
    page.changeBuilding();
    page.choose(
      searchDestinations(page.buildings(), 'IC', null).find(
        (option) => option.building.slug === 'ic',
      )!,
    );
    expect(page.destinationLabel()).toBe('Instructional Centre (IC)');
    expect(page.locationPrompt()).toBe(true);
    expect(page.destination()?.room).toBeUndefined();
    expect(page.building()?.floors).toEqual([]);
    expect(new URL(page.directions()).searchParams.get('destination')).toBe('43.786816,-79.189484');
  });
  it('prefers a matching published building and retains demos if discovery is unavailable', async () => {
    const first = (await setup()).componentInstance;
    expect(first.buildings().filter((item) => item.slug === 'ia')).toEqual([building]);
    const fixture = TestBed.createComponent(VisitorJourney);
    TestBed.inject(HttpTestingController)
      .expectOne('/api/maps/public/buildings/')
      .flush({}, { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    expect(fixture.componentInstance.buildings()).toHaveLength(2);
    expect(
      searchDestinations(fixture.componentInstance.buildings(), 'IA5061', null)[0].room?.label,
    ).toBe('IA5061');
  });
  it('matches a room number prefixed with the published building slug', () => {
    const fixture = structuredClone(building);
    fixture.name = 'Sam Ibrahim Building';
    fixture.floors[0].destinations![0].label = '2021';
    expect(searchDestinations([fixture], 'IA 2021', null)[0].room?.label).toBe('2021');
  });
  it('waits for a room before asking about its building and resets after the journey', async () => {
    const page = (await setup()).componentInstance;
    expect(page.locationPrompt()).toBe(false);
    page.chooseEnvironment(true);
    expect(page.cameraOpen()).toBe(false);
    page.choose(searchDestinations([building], 'IA', null).find((option) => !option.room)!);
    expect(page.locationPrompt()).toBe(false);
    page.choose(page.options()[0]);
    expect(page.locationPrompt()).toBe(true);
    expect(page.cameraOpen()).toBe(false);
    page.end();
    expect(page.locationPrompt()).toBe(false);
  });
  it('requires a room, builds walking navigation, and clears capture on cancel', async () => {
    const page = (await setup()).componentInstance;
    page.start();
    expect(page.active()).toBe(false);
    page.choose(searchDestinations([building], 'IA2021', null)[0]);
    const url = new URL(page.directions());
    expect(url.searchParams.get('travelmode')).toBe('walking');
    expect(url.searchParams.get('dir_action')).toBe('navigate');
    page.start();
    expect(page.active()).toBe(true);
    page.enterIndoor();
    page.recenter();
    expect(page.cameraOpen()).toBe(true);
    page.end();
    expect(page.cameraOpen()).toBe(false);
    expect(page.confirmedLocation()).toBe('');
    expect(page.active()).toBe(false);
  });
  it('accepts only likely matches on the selected floor, with explicit confirmation', async () => {
    const page = (await setup()).componentInstance;
    page.choose(searchDestinations([building], 'IA2021', null)[0]);
    page.enterIndoor();
    const result = {
      decision: { outcome: 'likely_match', location_id: 'junction' },
    } as MatchResult;
    page.acceptMatch(result);
    expect(page.confirmedLocation()).toBe('');
    expect(page.suggestedLocation()).toBe('East corridor');
    page.confirmMatch();
    expect(page.confirmedLocation()).toBe('East corridor');
    page.recenter();
    expect(page.confirmedLocation()).toBe('');
    page.acceptMatch({
      decision: { outcome: 'likely_match', location_id: 'another-floor' },
    } as MatchResult);
    expect(page.suggestedLocation()).toBe('');
    page.acceptMatch({
      decision: { outcome: 'uncertain', location_id: 'junction' },
    } as MatchResult);
    expect(page.confirmedLocation()).toBe('');
    page.end();
    page.acceptMatch(result);
    expect(page.suggestedLocation()).toBe('');
  });
  it('keeps GPS updates from reopening the prompt and opens camera only after indoor confirmation', async () => {
    const fixture = await setup();
    const page = fixture.componentInstance;
    page.choose(searchDestinations([building], 'IA2021', null)[0]);
    page.chooseEnvironment(false);
    page.location.set({ lat: 43.78, lng: -79.19, accuracy: 10, timestamp: Date.now() });
    // Flush the state effect without rendering an actual Google map.
    TestBed.tick();
    expect(page.locationPrompt()).toBe(false);
    expect(page.indoor()).toBe(false);
    page.chooseEnvironment(false);
    TestBed.tick();
    expect(page.locationPrompt()).toBe(false);
    expect(page.indoor()).toBe(false);
    page.locationPrompt.set(true);
    page.chooseEnvironment(true);
    expect(page.indoor()).toBe(true);
    expect(page.cameraOpen()).toBe(true);
    expect(page.confirmedLocation()).toBe('');
  });
  it('names the destination building after room selection and opens a guided camera from Yes', async () => {
    const fixture = await setup();
    const page = fixture.componentInstance;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.position-prompt')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Where are you headed?');
    expect(fixture.nativeElement.textContent).not.toContain('OUTDOOR MAP');
    expect(fixture.nativeElement.textContent).not.toContain('Choose a destination');
    expect(fixture.nativeElement.querySelectorAll('.map-location')).toHaveLength(1);
    expect(fixture.nativeElement.textContent).not.toContain('Location options');
    page.choose(searchDestinations([building], 'IA2021', null)[0]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.position-prompt').textContent).toContain(
      'Are you inside IA Sam Ibrahim Building?',
    );
    const yesButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find((button) =>
      (button as HTMLButtonElement).textContent?.includes('Yes, I’m inside'),
    ) as HTMLButtonElement;
    yesButton.click();
    fixture.detectChanges();
    expect(page.cameraOpen()).toBe(true);
    expect(fixture.nativeElement.querySelector('[role="dialog"]').textContent).toContain(
      'room number, corridor sign, or distinctive landmark',
    );
    expect(page.active()).toBe(true);
    expect(fixture.nativeElement.querySelector('input[role="combobox"]')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.recenter')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.map-location')).toBeNull();
    page.showOutdoor();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.recenter')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.map-location')).toHaveLength(1);
    expect(fixture.nativeElement.textContent).not.toContain('Confirm destination');
    page.end();
    expect(page.destination()).toBeNull();
    expect(page.locationPrompt()).toBe(false);
  });
  it('disables Google default controls so the outdoor location button has no overlapping control', async () => {
    const options = vi.fn();
    TestBed.overrideProvider(GoogleMapsService, {
      useValue: {
        error: signal(''),
        load: async () => ({
          mapId: 'test',
          maps: {
            Map: class {
              constructor(_element: HTMLElement, settings: unknown) {
                options(settings);
              }
              panTo() {}
              setZoom() {}
            },
            event: { clearInstanceListeners() {} },
          },
        }),
      },
    });
    const fixture = TestBed.createComponent(WalkingMap);
    fixture.detectChanges();
    await vi.waitFor(() => expect(options).toHaveBeenCalled());
    expect(options.mock.calls[0][0]).toMatchObject({
      disableDefaultUI: true,
      cameraControl: false,
      zoomControl: false,
    });
  });
  it('retains GPS watching after a transient error and ignores fixes after cancellation', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
    let success!: PositionCallback;
    let failure!: PositionErrorCallback;
    const clearWatch = vi.fn();
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: (ok: PositionCallback, error: PositionErrorCallback) => {
          success = ok;
          failure = error;
          return 7;
        },
        clearWatch,
      },
    });
    try {
      const page = (await setup()).componentInstance;
      page.locate();
      failure({ code: 2 } as GeolocationPositionError);
      expect(clearWatch).not.toHaveBeenCalled();
      page.end();
      expect(clearWatch).toHaveBeenCalledWith(7);
      success({
        coords: { latitude: 43.78, longitude: -79.19, accuracy: 10 },
        timestamp: Date.now(),
      } as GeolocationPosition);
      expect(page.location()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'geolocation', descriptor);
      else Reflect.deleteProperty(navigator, 'geolocation');
    }
  });
});
