import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Icon } from '../../shared/icon';
import { matchingCheckpoint, type MatchResult } from '../../core/place-match';
import { VisitorCamera } from './visitor-camera';
import { WalkingMap } from './walking-map';
import { GuidancePhotoView, type GuidancePhoto } from './guidance-photo';
import { type DestinationOption, type VisitorBuilding } from './visitor.models';
import { withDemoBuildings } from './visitor-demo';
import { DestinationSearch } from './visitor-destination-search';

@Component({
  selector: 'app-visitor-journey',
  imports: [Icon, WalkingMap, VisitorCamera, GuidancePhotoView, DestinationSearch],
  templateUrl: './visitor.html',
  styleUrls: [
    './visitor.scss',
    './visitor-search.scss',
    './visitor-guidance.scss',
    './visitor-prompt.scss',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VisitorJourney {
  private readonly http = inject(HttpClient);
  readonly buildings = signal<VisitorBuilding[]>(withDemoBuildings([]));
  readonly loading = signal(true);
  readonly error = signal('');
  readonly building = signal<VisitorBuilding | null>(null);
  readonly destination = signal<DestinationOption | null>(null);
  readonly destinationLabel = computed(
    () => this.destination()?.room?.label ?? this.destination()?.building.name ?? '',
  );
  readonly options = computed<DestinationOption[]>(() => {
    const building = this.building();
    return (
      building?.floors.flatMap((floor) =>
        (floor.destinations ?? []).map((room) => ({
          key: `${floor.target_id}:${room.id}`,
          building,
          floor,
          room,
        })),
      ) ?? []
    );
  });
  readonly buildingSuggestions = computed(() =>
    this.buildings().map((building) => ({
      key: building.id,
      label: building.name,
      detail: `${building.demo ? 'Demo · ' : ''}${building.address}`,
      searchText: `${building.slug ?? ''} ${building.name} ${building.address}`,
    })),
  );
  readonly roomSuggestions = computed(() =>
    this.options().map((option) => ({
      key: option.key,
      label: option.room!.label,
      detail: option.floor!.name,
      searchText: `${option.room!.label} ${option.room!.name} ${option.building.slug ?? ''}${option.room!.label}`,
    })),
  );
  readonly active = signal(false);
  readonly indoor = signal(false);
  readonly cameraOpen = signal(false);
  readonly environment = signal<'unknown' | 'inside' | 'outside'>('unknown');
  readonly locationPrompt = signal(false);
  readonly location = signal<{
    lat: number;
    lng: number;
    accuracy: number;
    timestamp: number;
  } | null>(null);
  readonly point = computed(() => {
    const building = this.building();
    return building ? { lat: building.latitude, lng: building.longitude } : null;
  });
  readonly locating = signal(false);
  readonly locationMessage = signal('');
  readonly message = signal('');
  readonly confirmedLocation = signal('');
  readonly suggestedLocation = signal('');
  readonly guidancePhoto = signal<GuidancePhoto | null>(null);
  readonly directions = computed(() => {
    const b = this.building();
    if (!b) return '';
    return (
      'https://www.google.com/maps/dir/?' +
      new URLSearchParams({
        api: '1',
        destination: `${b.latitude},${b.longitude}`,
        travelmode: 'walking',
        dir_action: 'navigate',
      })
    );
  });
  private watch?: number;
  private locationAttempt = 0;
  private locationRequested = false;
  private destroyed = false;
  private loadAttempt = 0;

  constructor() {
    const pause = () => {
      if (document.visibilityState !== 'hidden') {
        if (this.locationRequested && this.active() && !this.indoor()) this.locate();
        return;
      }
      this.cameraOpen.set(false);
      this.stopLocation();
      this.location.set(null);
      this.confirmedLocation.set('');
      this.suggestedLocation.set('');
      this.guidancePhoto.set(null);
      this.message.set('');
    };
    document.addEventListener('visibilitychange', pause);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.stopLocation();
      document.removeEventListener('visibilitychange', pause);
    });
    void this.load();
  }
  async load() {
    const attempt = ++this.loadAttempt;
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await firstValueFrom(
        this.http.get<{ buildings: VisitorBuilding[] }>('/api/maps/public/buildings/'),
      );
      if (!this.destroyed && attempt === this.loadAttempt)
        this.buildings.set(withDemoBuildings(response.buildings));
    } catch {
      if (!this.destroyed && attempt === this.loadAttempt)
        this.error.set(
          'Live destinations could not be loaded. You can still try the demo destinations.',
        );
    } finally {
      if (!this.destroyed && attempt === this.loadAttempt) this.loading.set(false);
    }
  }
  selectBuilding(id: string) {
    this.building.set(this.buildings().find((building) => building.id === id) ?? null);
    this.destination.set(null);
    this.confirmedLocation.set('');
    this.suggestedLocation.set('');
    this.message.set('');
  }
  selectRoom(key: string) {
    const option = this.options().find((option) => option.key === key);
    if (option) this.choose(option);
  }
  choose(option: DestinationOption) {
    this.building.set(option.building);
    this.destination.set(option.room ? option : null);
    this.confirmedLocation.set('');
    if (option.room) this.start();
  }
  start() {
    if (!this.destination()) return;
    this.active.set(true);
    this.environment.set('unknown');
    this.indoor.set(false);
    this.cameraOpen.set(false);
    this.locationPrompt.set(true);
  }
  enterIndoor() {
    this.chooseEnvironment(true);
  }
  chooseEnvironment(inside: boolean) {
    if (!this.destination()) return;
    this.environment.set(inside ? 'inside' : 'outside');
    this.locationPrompt.set(false);
    this.indoor.set(inside);
    if (inside) this.stopLocation();
    this.active.set(true);
    if (inside) this.recenter();
    else {
      this.cameraOpen.set(false);
      this.message.set('');
    }
  }
  showOutdoor() {
    this.chooseEnvironment(false);
    this.guidancePhoto.set(null);
    this.cameraOpen.set(false);
    this.indoor.set(false);
    this.location.set(null);
    this.confirmedLocation.set('');
    this.suggestedLocation.set('');
  }
  end(finished = false) {
    this.locationRequested = false;
    this.guidancePhoto.set(null);
    this.cameraOpen.set(false);
    this.stopLocation();
    this.active.set(false);
    this.indoor.set(false);
    this.environment.set('unknown');
    this.locationPrompt.set(false);
    this.destination.set(null);
    this.confirmedLocation.set('');
    this.suggestedLocation.set('');
    this.message.set(finished ? 'Navigation finished. Where to next?' : '');
  }
  acceptMatch(result: MatchResult) {
    if (!this.active() || !this.indoor() || this.building()?.demo) return;
    const floor = this.destination()?.floor;
    const checkpoints = [
      ...(floor?.checkpoints ?? []),
      ...(floor?.destinations ?? []).map((room) => ({ id: room.id, label: room.label })),
    ];
    const match =
      result.decision.outcome === 'likely_match'
        ? matchingCheckpoint(result.decision.location_id, checkpoints)
        : undefined;
    this.cameraOpen.set(false);
    if (!match) {
      this.message.set(
        'That photo could not be linked to this floor. Try another sign or landmark.',
      );
      return;
    }
    this.suggestedLocation.set(match.label || match.id);
  }
  confirmMatch() {
    this.confirmedLocation.set(this.suggestedLocation());
    this.suggestedLocation.set('');
    this.message.set('Location confirmed. Guidance photos for this route are not available yet.');
  }
  demoPhotoCaptured() {
    if (!this.active() || !this.indoor() || !this.building()?.demo) return;
    this.cameraOpen.set(false);
    this.message.set('Photo captured. Location matching is not connected for this demo.');
  }
  recenter() {
    if (!this.active() || !this.indoor() || !this.destination()) return;
    this.guidancePhoto.set(null);
    this.confirmedLocation.set('');
    this.suggestedLocation.set('');
    this.message.set('');
    this.cameraOpen.set(true);
  }
  locate() {
    if (this.locating() || this.destroyed) return;
    this.locationRequested = true;
    if (!navigator.geolocation) {
      this.locationMessage.set('Location is unavailable. You can still choose a destination.');
      return;
    }
    this.locating.set(true);
    this.locationMessage.set('Finding your location…');
    this.stopLocation();
    this.locating.set(true);
    const attempt = this.locationAttempt;
    this.watch = navigator.geolocation.watchPosition(
      (position) => {
        if (this.destroyed || attempt !== this.locationAttempt) return;
        this.location.set({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp,
        });
        this.locating.set(false);
        this.locationMessage.set(
          `Approximate location · accuracy ${Math.round(position.coords.accuracy)} m`,
        );
      },
      (error) => {
        if (this.destroyed || attempt !== this.locationAttempt) return;
        this.locating.set(false);
        this.locationMessage.set(
          error.code === 1
            ? 'Location permission is off. Choose a destination or allow access in Settings.'
            : 'Could not find your location. Try again or choose your destination.',
        );
        if (error.code === 1) this.stopLocation();
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  }
  private stopLocation() {
    this.locationAttempt++;
    if (this.watch !== undefined) navigator.geolocation?.clearWatch(this.watch);
    this.watch = undefined;
    this.locating.set(false);
  }
}
