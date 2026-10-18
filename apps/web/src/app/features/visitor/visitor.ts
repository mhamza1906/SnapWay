import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { Icon } from '../../shared/icon';
import { matchingCheckpoint, type MatchResult, type DetectedNode } from '../../core/place-match';
import { VisitorCamera } from './visitor-camera';
import { WalkingMap } from './walking-map';
import { GuidancePhotoView, type GuidancePhoto } from './guidance-photo';
import { type DestinationOption, type VisitorBuilding } from './visitor.models';
import { DestinationSearch } from './visitor-destination-search';
import { type PhotoRoute, type RoutePreference } from './visitor-route';
import { timeout } from 'rxjs';

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
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  readonly buildings = signal<VisitorBuilding[]>([]);
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
      detail: [
        building.address,
        `${building.floors.length} ${building.floors.length === 1 ? 'floor' : 'floors'}`,
      ]
        .filter(Boolean)
        .join(' · '),
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
  readonly suggestedNode = signal<DetectedNode | null>(null);
  readonly confirmedNode = signal<DetectedNode | null>(null);
  readonly guidancePhoto = signal<GuidancePhoto | null>(null);
  readonly preference = signal<RoutePreference>('any');
  readonly routeLoading = signal(false);
  readonly route = signal<PhotoRoute | null>(null);
  readonly frameIndex = signal(0);
  private matchedLocation: MatchResult | null = null;
  private routeAttempt = 0;

  setPreference(value: string) {
    if (!['any', 'avoid_stairs', 'avoid_elevators'].includes(value)) return;
    this.preference.set(value as RoutePreference);
    if (this.confirmedLocation()) void this.loadRoute();
  }
  private clearRoute() {
    this.routeAttempt++;
    this.routeLoading.set(false);
    this.route.set(null);
    this.frameIndex.set(0);
    this.guidancePhoto.set(null);
  }
  private clearDetectedNode() {
    this.suggestedLocation.set('');
    this.confirmedLocation.set('');
    this.suggestedNode.set(null);
    this.confirmedNode.set(null);
    this.matchedLocation = null;
  }
  moveFrame(offset: number) {
    const frames = this.route()?.frames;
    const index = this.frameIndex() + offset;
    if (!frames || index < 0 || index >= frames.length) return;
    this.frameIndex.set(index);
    const frame = frames[index];
    this.guidancePhoto.set({
      imageUrl: frame.image_url,
      alt: `${frame.label} · ${frame.floor_name}`,
      instruction: frame.instruction,
      direction: 'straight',
      nextAngle: frame.next_angle,
      previousAngle: frame.previous_angle,
      hasNext: index + 1 < frames.length,
      hasPrevious: index > 0,
      transition: frame.transition,
      step: index + 1,
      count: frames.length,
    });
  }
  async loadRoute() {
    const location = this.matchedLocation;
    const destination = this.destination();
    this.clearRoute();
    const attempt = this.routeAttempt;
    if (!location?.localization_token || !destination?.floor || !destination.room) {
      this.message.set('This photo match has no route location. Take another photo to continue.');
      return;
    }
    this.routeLoading.set(true);
    this.message.set('Finding your route…');
    try {
      const route = await firstValueFrom(
        this.http
          .post<PhotoRoute>('/api/navigation/photo-route/', {
            publication_id: destination.floor.publication_id,
            destination_id: destination.room.id,
            localization_token: location.localization_token,
            preference: this.preference(),
          })
          .pipe(timeout(15000)),
      );
      if (this.destroyed || attempt !== this.routeAttempt) return;
      this.route.set(route);
      this.moveFrame(0);
      this.message.set(
        'Follow the photos and check each checkpoint around you. Arrows preview the route.',
      );
    } catch (error: unknown) {
      if (this.destroyed || attempt !== this.routeAttempt) return;
      const detail = (error as { error?: { detail?: string } })?.error?.detail;
      this.message.set(detail || 'The route could not load. Try again or take another photo.');
    } finally {
      if (attempt === this.routeAttempt) this.routeLoading.set(false);
    }
  }
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
      this.clearRoute();
      this.clearDetectedNode();
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
      this.clearRoute();
      this.stopLocation();
      document.removeEventListener('visibilitychange', pause);
    });
    void this.auth.refresh().catch(() => undefined);
    void this.load();
  }
  async switchToDeveloper() {
    if (await this.auth.switchMode('developer'))
      await this.router.navigateByUrl(this.auth.landingPath());
  }
  async signOut() {
    if (await this.auth.signOut()) await this.router.navigateByUrl('/sign-in');
  }
  async load() {
    const attempt = ++this.loadAttempt;
    this.loading.set(true);
    this.error.set('');
    try {
      const response = await firstValueFrom(
        this.http.get<{ buildings: VisitorBuilding[] }>('/api/maps/public/building-directory/'),
      );
      if (!this.destroyed && attempt === this.loadAttempt) this.buildings.set(response.buildings);
    } catch {
      if (!this.destroyed && attempt === this.loadAttempt)
        this.error.set('Buildings could not be loaded.');
    } finally {
      if (!this.destroyed && attempt === this.loadAttempt) this.loading.set(false);
    }
  }
  selectBuilding(id: string) {
    this.clearRoute();
    this.clearDetectedNode();
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
    this.clearRoute();
    this.clearDetectedNode();
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
    this.clearRoute();
    this.clearDetectedNode();
    this.chooseEnvironment(false);
    this.guidancePhoto.set(null);
    this.cameraOpen.set(false);
    this.indoor.set(false);
    this.location.set(null);
    this.confirmedLocation.set('');
    this.suggestedLocation.set('');
  }
  end(finished = false) {
    this.clearRoute();
    this.clearDetectedNode();
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
    if (!this.active() || !this.indoor()) return;
    this.clearRoute();
    this.suggestedLocation.set('');
    this.clearDetectedNode();
    const node = result.matched_node;
    if (node) {
      this.cameraOpen.set(false);
      if (
        result.decision.outcome !== 'likely_match' ||
        !result.localization_token ||
        node.building_id !== this.building()?.id ||
        (result.node_id != null && result.node_id !== node.node_id) ||
        (result.revision_id != null && result.revision_id !== node.revision_id)
      ) {
        this.message.set(
          'That photo could not be linked to this building. Try another sign or landmark.',
        );
        return;
      }
      this.matchedLocation = result;
      this.suggestedNode.set(node);
      this.suggestedLocation.set(node.label);
      this.message.set('');
      return;
    }
    if (result.building_id && result.building_id !== this.building()?.id) {
      this.cameraOpen.set(false);
      this.message.set(
        'That photo matches a different building. Check your destination and try again.',
      );
      return;
    }
    const floors = this.building()?.floors ?? [];
    const checkpoints = [
      ...floors.flatMap((floor) => floor.checkpoints ?? []),
      ...floors
        .flatMap((floor) => floor.destinations ?? [])
        .map((room) => ({ id: room.id, label: room.label })),
    ];
    const match =
      result.decision.outcome === 'likely_match'
        ? matchingCheckpoint(
            result.node_id ?? result.decision.node_id ?? result.decision.location_id,
            checkpoints,
          )
        : undefined;
    this.cameraOpen.set(false);
    const scopedGlobal =
      result.decision.outcome === 'likely_match' &&
      result.building_id === this.building()?.id &&
      !!result.localization_token;
    if (!match && !scopedGlobal) {
      this.message.set(
        'That photo could not be linked to this building. Try another sign or landmark.',
      );
      return;
    }
    this.matchedLocation = result;
    this.suggestedLocation.set(
      match?.label || result.floor_name || match?.id || 'the recognized checkpoint',
    );
  }
  confirmMatch() {
    if (!this.suggestedLocation()) return;
    this.confirmedLocation.set(this.suggestedLocation());
    this.confirmedNode.set(this.suggestedNode());
    this.suggestedNode.set(null);
    this.suggestedLocation.set('');
    void this.loadRoute();
  }
  recenter() {
    if (!this.active() || !this.indoor() || !this.destination()) return;
    this.clearRoute();
    this.clearDetectedNode();
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
