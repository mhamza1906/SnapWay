import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { searchDestinations, type VisitorBuilding } from './visitor.models';
import { VisitorJourney } from './visitor';
import type { MatchResult } from '../../core/place-match';
import { GuidancePhotoView } from './guidance-photo';
import { WalkingMap } from './walking-map';
import { GoogleMapsService } from '../../core/google-maps.service';
import { AuthService } from '../../core/auth.service';
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

const anotherBuilding: VisitorBuilding = {
  ...building,
  id: 'ic',
  slug: 'ic',
  name: 'Instructional Centre (IC)',
  floors: [
    {
      ...building.floors[0],
      target_id: 'ic-floor1',
      publication_id: 'ic-published-v1',
      name: 'Floor 1',
      code: '1',
      checkpoints: [],
      destinations: [{ id: 'ic-room101', label: 'IC101', name: 'Classroom' }],
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
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            signedIn: signal(false),
            name: signal('Guest'),
            busy: signal(false),
            error: signal(''),
            landingPath: signal('/public'),
            refresh: async () => ({ authenticated: false }),
            switchMode: async () => false,
            signOut: async () => false,
          },
        },
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
      .expectOne('/api/maps/public/building-directory/')
      .flush({ buildings: published });
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    return fixture;
  }
  it('supports building-first selection before completing a room destination', async () => {
    const page = (await setup()).componentInstance;
    const results = searchDestinations([building], 'IA', null);
    expect(results.some((r) => !r.room && r.building.id === 'ia')).toBe(true);
    page.choose(results.find((r) => !r.room)!);
    expect(page.destination()).toBeNull();
    expect(page.options()[0].room?.label).toBe('IA2021');
    page.selectBuilding('');
    page.choose(searchDestinations([building], 'IA2021', null)[0]);
    expect(page.destination()?.room?.id).toBe('room-2021');
    expect(page.building()?.id).toBe('ia');
  });
  it('shows an empty directory without supplying demo destinations', async () => {
    const fixture = await setup([]);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    expect(page.buildings()).toEqual([]);
    expect(page.buildingSuggestions()).toEqual([]);
    expect(page.active()).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('No buildings are available yet.');
  });
  it('filters building and room searches, clears rooms when editing a building, and starts only on a room suggestion', async () => {
    const fixture = await setup([building, anotherBuilding]);
    const page = fixture.componentInstance;
    fixture.detectChanges();
    const buildingInput = fixture.nativeElement.querySelector(
      '#destination-building',
    ) as HTMLInputElement;
    const roomInput = fixture.nativeElement.querySelector('#destination-room') as HTMLInputElement;
    const type = (input: HTMLInputElement, value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const option = () =>
      fixture.nativeElement.querySelector('[role="option"]') as HTMLButtonElement;
    expect(roomInput.disabled).toBe(true);
    type(buildingInput, 'ia');
    expect(fixture.nativeElement.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(option().textContent).toContain('Sam Ibrahim Building');
    expect(page.building()).toBeNull();
    option().click();
    fixture.detectChanges();
    expect(roomInput.disabled).toBe(false);
    type(roomInput, 'ia 2021');
    expect(option().textContent).toContain('IA2021');
    expect(page.locationPrompt()).toBe(false);
    type(buildingInput, 'IC');
    expect(roomInput.disabled).toBe(true);
    expect(roomInput.value).toBe('');
    expect(option().textContent).toContain('Instructional Centre');
    option().click();
    fixture.detectChanges();
    type(roomInput, 'IA2021');
    expect(fixture.nativeElement.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('No matches found.');
    type(roomInput, 'ic 101');
    expect(page.active()).toBe(false);
    roomInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    fixture.detectChanges();
    expect(roomInput.getAttribute('aria-activedescendant')).toBe('destination-room-option-0');
    roomInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(page.active()).toBe(true);
    expect(fixture.nativeElement.querySelector('#position-question').textContent).toContain(
      'Instructional Centre (IC)',
    );
    expect(fixture.nativeElement.querySelector('input[role="combobox"]')).toBeNull();
    page.end();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#destination-room').value).toBe('');
    expect(page.locationPrompt()).toBe(false);
  });
  it('lists all rooms and leaves buildings without rooms inactive', async () => {
    const manyRooms = structuredClone(building);
    manyRooms.floors[0].destinations = Array.from({ length: 20 }, (_, i) => ({
      id: `room-${i}`,
      label: `IA${i}`,
      name: '',
    }));
    const page = (await setup([manyRooms])).componentInstance;
    page.selectBuilding('ia');
    expect(page.options()).toHaveLength(20);
    page.selectRoom(page.options()[19].key);
    expect(page.destinationLabel()).toBe('IA19');
    page.end();
    const empty = structuredClone(building);
    empty.floors = [];
    page.buildings.set([empty]);
    page.selectBuilding('ia');
    page.selectRoom('invalid');
    expect(page.options()).toEqual([]);
    expect(page.destination()).toBeNull();
    expect(page.active()).toBe(false);
  });
  it('loads only database buildings and exposes retry when the directory fails', async () => {
    const first = (await setup()).componentInstance;
    expect(first.buildings()).toEqual([building]);
    const fixture = TestBed.createComponent(VisitorJourney);
    TestBed.inject(HttpTestingController)
      .expectOne('/api/maps/public/building-directory/')
      .flush({}, { status: 503, statusText: 'Unavailable' });
    await vi.waitFor(() => expect(fixture.componentInstance.loading()).toBe(false));
    fixture.detectChanges();
    expect(fixture.componentInstance.buildings()).toEqual([]);
    expect(fixture.nativeElement.textContent).toContain('Buildings could not be loaded.');
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
  it('loads a route from a confirmed global match and previews photos without changing physical location', async () => {
    const fixture = await setup();
    const page = fixture.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    page.choose(searchDestinations([building], 'IA2021', null)[0]);
    page.enterIndoor();
    page.cameraOpen.set(false);
    page.acceptMatch({
      building_id: 'ia',
      node_id: 'node-on-another-floor',
      revision_id: 'floor1-rev',
      floor_name: 'Floor 1',
      localization_token: 'signed-location',
      matched_node: {
        node_id: 'node-on-another-floor',
        stable_id: 'floor1-checkpoint',
        revision_id: 'floor1-rev',
        target_id: 'floor1',
        label: 'West stair landing',
        kind: 'stairs',
        floor_id: 'floor1-id',
        floor_name: 'Floor 1',
        building_id: 'ia',
        building_name: building.name,
      },
      decision: { outcome: 'likely_match', location_id: 'node-on-another-floor' },
    } as MatchResult);
    expect(page.suggestedLocation()).toBe('West stair landing');
    expect(page.suggestedNode()?.node_id).toBe('node-on-another-floor');
    expect(page.confirmedNode()).toBeNull();
    http.expectNone('/api/navigation/photo-route/');
    page.confirmMatch();
    expect(page.confirmedNode()?.revision_id).toBe('floor1-rev');
    const request = http.expectOne('/api/navigation/photo-route/');
    expect(request.request.body).toEqual({
      publication_id: 'published-v1',
      destination_id: 'room-2021',
      localization_token: 'signed-location',
      preference: 'any',
    });
    const frame = {
      node_id: 'first',
      revision_id: 'floor1-rev',
      label: 'Corridor',
      floor_name: 'Floor 1',
      image_url: '/reference.jpg',
      instruction: 'Continue to the stairs.',
      next_angle: 45,
      previous_angle: null,
      transition: false,
      orientation_known: true,
    };
    request.flush({
      frames: [
        frame,
        { ...frame, node_id: 'last', label: 'Stairs', next_angle: null, previous_angle: -135 },
      ],
      total_cost: 2,
      preference: 'any',
      publication_ids: [],
    });
    await vi.waitFor(() => expect(page.routeLoading()).toBe(false));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.arrow.next').style.transform).toBe(
      'rotate(45deg)',
    );
    fixture.nativeElement.querySelector('.arrow.next').click();
    fixture.detectChanges();
    expect(page.frameIndex()).toBe(1);
    expect(page.confirmedLocation()).toBe('West stair landing');
    expect(page.confirmedNode()?.node_id).toBe('node-on-another-floor');
    expect(fixture.nativeElement.querySelector('.arrow.previous').style.transform).toBe(
      'rotate(-135deg)',
    );
    page.moveFrame(-1);
    page.moveFrame(-1);
    expect(page.frameIndex()).toBe(0);
    page.recenter();
    expect(page.route()).toBeNull();
    expect(page.confirmedNode()).toBeNull();
    expect(page.suggestedNode()).toBeNull();
  });
  it('ignores a route response after cancellation', async () => {
    const page = (await setup()).componentInstance;
    page.choose(searchDestinations([building], 'IA2021', null)[0]);
    page.enterIndoor();
    page.acceptMatch({
      building_id: 'ia',
      localization_token: 'signed-location',
      decision: { outcome: 'likely_match', location_id: 'junction' },
    } as MatchResult);
    page.confirmMatch();
    const request = TestBed.inject(HttpTestingController).expectOne('/api/navigation/photo-route/');
    page.end();
    request.flush({ frames: [], total_cost: 0, preference: 'any', publication_ids: [] });
    await Promise.resolve();
    expect(page.route()).toBeNull();
    expect(page.guidancePhoto()).toBeNull();
    expect(page.message()).toBe('');
  });
  it('recovers a failed image when a new route frame arrives', () => {
    const fixture = TestBed.createComponent(GuidancePhotoView);
    const frame = {
      imageUrl: '/broken.jpg',
      alt: 'Corridor',
      instruction: 'Continue',
      direction: 'straight',
    };
    fixture.componentRef.setInput('photo', frame);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('img').dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('could not load');
    fixture.componentRef.setInput('photo', { ...frame, imageUrl: '/next.jpg' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img').getAttribute('src')).toBe('/next.jpg');
  });
  it('accepts only likely matches in the selected building, with explicit confirmation', async () => {
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
      'Keep a nearby sign or landmark clearly in view',
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
