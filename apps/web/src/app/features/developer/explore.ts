import { HttpClient } from '@angular/common/http';
import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import {
  GoogleMapsService,
  MapHandle,
  MapsRuntime,
  MarkerHandle,
  MapClick,
  detachMarker,
  mapPinIcon,
} from '../../core/google-maps.service';
import { AuthService } from '../../core/auth.service';
import { UiService } from '../../core/ui.service';
import { WorkspaceChrome } from '../../core/workspace-chrome.service';
import { Icon } from '../../shared/icon';
import { PublicBuilding } from '../map/map';

type ExploreFloor = PublicBuilding['floors'][number] & { published?: boolean };
type Building = Omit<PublicBuilding, 'floors'> & {
  place_id?: string;
  published?: boolean;
  floors: ExploreFloor[];
};
interface PlaceData {
  id: string;
  displayName?: string;
  formattedAddress?: string;
  location?: { lat(): number; lng(): number };
  fetchFields(options: { fields: string[] }): Promise<unknown>;
}
interface PlacesLibrary {
  Place: {
    new (options: { id: string }): PlaceData;
    searchByText(options: Record<string, unknown>): Promise<{ places: PlaceData[] }>;
  };
}

@Component({
  selector: 'app-developer-explore',
  imports: [RouterLink, Icon],
  template: `<section class="explore" aria-label="Explore buildings">
    <div #canvas class="map-canvas"></div>
    @if (error() || sdk.error()) {
      <div class="map-message error" role="alert">
        {{ error() || sdk.error() }}<button class="btn" (click)="retry()">Retry</button>
      </div>
    }
    @if (note()) {
      <div class="map-note" role="status">{{ note() }}</div>
    }
    @if (selected(); as building) {
      <aside class="floor-panel" aria-label="Published floors" (scroll)="moreFloors($event)">
        <header>
          <div>
            <p class="eyebrow">{{ building.published ? 'MAPPED PLACE' : 'DRAFT PLACE' }}</p>
            <h1>{{ building.name }}</h1>
            <p>{{ building.floors.length }} floor{{ building.floors.length === 1 ? '' : 's' }}</p>
          </div>
          <button
            class="btn ghost icon-only"
            aria-label="Close floor list"
            (click)="selected.set(null)"
          >
            <app-icon name="close" />
          </button>
        </header>
        @for (floor of visibleFloors(); track floor.target_id) {
          <article class="floor-card">
            <div class="floor-number" [class.draft]="!floor.published">
              <app-icon name="layers" /><strong>{{ floor.code }}</strong>
            </div>
            <div>
              <h2>{{ floor.name }}</h2>
              <p>
                {{ floor.published ? 'Published · Version ' + floor.sequence : 'Editing snapshot' }}
              </p>
              <a
                class="btn secondary"
                routerLink="/graph-editor"
                [queryParams]="{ target: floor.target_id }"
                >Open editing snapshot <app-icon name="arrow-right"
              /></a>
            </div>
          </article>
        }
        @if (visibleFloors().length < building.floors.length) {
          <button class="btn more" (click)="limit.update(addPage)">Load more floors</button>
        }
        <a
          class="btn new-floor"
          routerLink="/authoring"
          [queryParams]="{
            building: building.name,
            buildingId: building.id,
            lat: building.latitude,
            lng: building.longitude,
            address: building.address,
          }"
          ><app-icon name="plus" />{{
            auth.canAdmin() ? 'Initialize another floor' : 'Request another floor'
          }}</a
        >
      </aside>
    }
    @if (candidate(); as place) {
      <aside class="floor-panel candidate" aria-label="Create a floor">
        <header>
          <div>
            <p class="eyebrow">A NEW PLACE TO MAP</p>
            <h1>{{ place.name }}</h1>
          </div>
          <button
            class="btn ghost icon-only"
            aria-label="Close building selection"
            (click)="candidate.set(null)"
          >
            <app-icon name="close" />
          </button>
        </header>
        <div class="candidate-body">
          <div class="new-place-icon"><app-icon name="building" /></div>
          <h2>{{ auth.canAdmin() ? 'Publish a new floor here?' : 'Request a new map here?' }}</h2>
          <p>
            {{
              auth.canAdmin()
                ? 'Initialize the floor plan, refine its graph, then publish it when ready.'
                : 'Create a floor plan and submit it for an administrator to review.'
            }}
          </p>
          <a
            class="btn primary"
            routerLink="/authoring"
            [queryParams]="{
              building: place.name,
              placeId: place.id,
              lat: place.lat,
              lng: place.lng,
              address: place.address,
            }"
            >{{ auth.canAdmin() ? 'Initialize new map' : 'Request new map' }}
            <app-icon name="arrow-right"
          /></a>
        </div>
      </aside>
    }
    <div class="map-legend">
      <span class="yellow-dot"></span>Published <span class="red-dot"></span>Draft
      <span class="legend-hint">Select any building to map a new floor</span>
    </div>
    @if (buildings().length && !selected() && !candidate()) {
      <details class="available">
        <summary>{{ buildings().length }} mapped buildings</summary>
        <div>
          @for (building of buildings(); track building.id) {
            <button (click)="choose(building)">
              {{ building.name }}<small>{{ building.floors.length }} floors</small>
            </button>
          }
        </div>
      </details>
    }
  </section>`,
  styleUrls: ['./explore.scss', './explore-overlays.scss'],
})
export class ExplorePage implements AfterViewInit {
  readonly sdk = inject(GoogleMapsService);
  readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly ui = inject(UiService);
  private readonly chrome = inject(WorkspaceChrome);
  private readonly destroy = inject(DestroyRef);
  readonly canvas = viewChild.required<ElementRef<HTMLElement>>('canvas');
  readonly buildings = signal<Building[]>([]);
  readonly selected = signal<Building | null>(null);
  readonly candidate = signal<{
    id?: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
  } | null>(null);
  readonly query = signal('');
  readonly error = signal('');
  readonly note = signal('');
  readonly loading = signal(true);
  readonly searching = signal(false);
  readonly limit = signal(20);
  readonly visibleFloors = computed(() => this.selected()?.floors.slice(0, this.limit()) ?? []);
  readonly addPage = (value: number) => value + 20;
  private maps?: MapsRuntime;
  private map?: MapHandle;
  private markers: MarkerHandle[] = [];
  private userMarker?: MarkerHandle;
  private destroyed = false;
  private clickVersion = 0;

  constructor() {
    this.chrome.bindExplore({
      search: (query) => this.runSearch(query),
      locate: () => this.locate(),
    });
    this.destroy.onDestroy(() => {
      this.destroyed = true;
      this.chrome.unbindExplore();
      this.markers.forEach((m) => detachMarker(this.maps, m));
      if (this.userMarker) detachMarker(this.maps, this.userMarker);
      if (this.map) this.maps?.event.clearInstanceListeners(this.map);
    });
  }

  ngAfterViewInit() {
    void this.initialize();
  }

  async initialize() {
    this.loading.set(true);
    this.error.set('');
    try {
      await this.ui.runBusy(async () => {
        const [runtime, data] = await Promise.all([
          this.sdk.load(),
          firstValueFrom(
            this.http.get<{ buildings: Building[] }>('/api/maps/workspace/buildings/'),
          ),
        ]);
        if (this.destroyed) return;
        this.maps = runtime.maps;
        this.buildings.set(data.buildings);
        const mapOptions: Record<string, unknown> = {
          center: { lat: 43.784, lng: -79.187 },
          zoom: 16,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: true,
          gestureHandling: 'greedy',
        };
        // Cloud mapId is optional styling; omit DEMO_MAP_ID so classic markers stay reliable.
        if (runtime.mapId && runtime.mapId !== 'DEMO_MAP_ID') mapOptions['mapId'] = runtime.mapId;
        this.map ??= new runtime.maps.Map(this.canvas().nativeElement, mapOptions);
        this.maps.event.clearInstanceListeners(this.map);
        this.map.addListener('click', (event) => void this.onMapClick(event));
        this.renderMarkers();
        if (data.buildings.length === 1) {
          const b = data.buildings[0];
          this.map.panTo({ lat: b.latitude, lng: b.longitude });
          this.map.setZoom(17);
        } else if (data.buildings.length) {
          const bounds = new runtime.maps.LatLngBounds();
          data.buildings.forEach((b) => bounds.extend({ lat: b.latitude, lng: b.longitude }));
          this.map.fitBounds(bounds, 100);
        }
        if (navigator.permissions) {
          const p = await navigator.permissions.query({ name: 'geolocation' }).catch(() => null);
          if (!this.destroyed && p?.state === 'granted') this.locate();
        }
      }, 'Opening map…');
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Could not load buildings. Please retry.');
    } finally {
      this.loading.set(false);
    }
  }

  private renderMarkers() {
    if (!this.maps || !this.map) return;
    this.markers.forEach((m) => detachMarker(this.maps, m));
    this.markers = this.buildings().map((building) => {
      const fill = building.published ? '#f4c63d' : '#e25b45';
      const marker = new this.maps!.Marker({
        map: this.map,
        position: { lat: building.latitude, lng: building.longitude },
        title: `${building.name} · ${building.floors.length} floors`,
        icon: mapPinIcon(this.maps!, fill),
        optimized: false,
      });
      marker.addListener('click', () => this.choose(building));
      return marker;
    });
  }

  retry() {
    if (this.sdk.error()) window.location.reload();
    else void this.initialize();
  }

  choose(building: Building) {
    this.clickVersion++;
    this.candidate.set(null);
    this.selected.set(building);
    this.limit.set(20);
    this.map?.panTo({ lat: building.latitude, lng: building.longitude });
    this.map?.setZoom(18);
  }

  moreFloors(event: Event) {
    const el = event.target as HTMLElement;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 150) this.limit.update(this.addPage);
  }

  private async onMapClick(event: MapClick) {
    if (!event.latLng) return;
    event.stop?.();
    const version = ++this.clickVersion;
    const existing = event.placeId
      ? this.buildings().find((b) => b.place_id === event.placeId)
      : undefined;
    if (existing) {
      this.choose(existing);
      return;
    }
    const lat = event.latLng.lat(),
      lng = event.latLng.lng();
    this.selected.set(null);
    this.candidate.set({ id: event.placeId, name: 'Selected building', address: '', lat, lng });
    if (event.placeId && this.maps) {
      try {
        const { Place } = (await this.maps.importLibrary('places')) as PlacesLibrary;
        const place = new Place({ id: event.placeId });
        await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
        if (version === this.clickVersion && !this.destroyed)
          this.candidate.set({
            id: event.placeId,
            name: place.displayName || 'Selected building',
            address: place.formattedAddress || '',
            lat,
            lng,
          });
      } catch {
        this.note.set('Building selected. You can enter its name when creating the floor.');
      }
    }
  }

  async runSearch(rawQuery: string) {
    const query = rawQuery.trim();
    this.query.set(query);
    this.chrome.exploreQuery.set(query);
    if (!query || this.searching()) return;
    const match = this.buildings().find((b) =>
      (b.name + ' ' + b.address).toLowerCase().includes(query.toLowerCase()),
    );
    if (match) {
      this.choose(match);
      return;
    }
    if (!this.maps) return;
    this.searching.set(true);
    this.note.set('');
    try {
      await this.ui.runBusy(async () => {
        const { Place } = (await this.maps!.importLibrary('places')) as PlacesLibrary;
        const result = await Place.searchByText({
          textQuery: query,
          fields: ['id', 'displayName', 'formattedAddress', 'location'],
        });
        const place = result.places[0];
        if (!place?.location) {
          this.note.set('No matching building found. Try a more specific address.');
          return;
        }
        const lat = place.location.lat(),
          lng = place.location.lng();
        this.selected.set(null);
        this.candidate.set({
          id: place.id,
          name: place.displayName || query,
          address: place.formattedAddress || '',
          lat,
          lng,
        });
        this.map?.panTo({ lat, lng });
        this.map?.setZoom(18);
      }, 'Searching…');
    } catch {
      this.note.set('Place search is unavailable. Select the building directly on the map.');
    } finally {
      this.searching.set(false);
    }
  }

  locate() {
    if (!navigator.geolocation) {
      this.note.set('Location is unavailable in this browser.');
      return;
    }
    this.note.set('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (this.destroyed || !this.maps || !this.map) return;
        const point = { lat: p.coords.latitude, lng: p.coords.longitude };
        this.map.panTo(point);
        this.map.setZoom(17);
        if (this.userMarker) {
          this.userMarker.position = point;
          this.userMarker.setMap?.(this.map ?? null);
        } else {
          this.userMarker = new this.maps.Marker({
            map: this.map,
            position: point,
            title: 'Your approximate location',
            icon: mapPinIcon(this.maps, '#3b82c4'),
            zIndex: 999,
            optimized: false,
          });
        }
        this.note.set('Map centered on your location.');
      },
      (error) =>
        this.note.set(
          error.code === 1
            ? 'Location permission was denied. You can still explore the map.'
            : 'Location permission was unavailable. You can still explore the map.',
        ),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }
}
