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
} from '../../core/google-maps.service';
import { AuthService } from '../../core/auth.service';
import { Icon } from '../../shared/icon';
import { PublicBuilding } from '../map/map';

type Building = PublicBuilding & { place_id?: string };
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
    <form class="map-search" (submit)="search($event)">
      <app-icon name="search" /><input
        aria-label="Search buildings or addresses"
        placeholder="Search buildings or addresses"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
      /><button aria-label="Search" [disabled]="searching()">
        <app-icon name="arrow-right" />
      </button>
    </form>
    <button class="locate" aria-label="Use my location" (click)="locate()">
      <app-icon name="location" />
    </button>
    @if (loading()) {
      <div class="map-message" role="status">Opening your map…</div>
    }
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
            <p class="eyebrow">PUBLISHED PLACE</p>
            <h1>{{ building.name }}</h1>
            <p>
              {{ building.floors.length }} available floor{{
                building.floors.length === 1 ? '' : 's'
              }}
            </p>
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
            <div class="floor-number">
              <app-icon name="layers" /><strong>{{ floor.code }}</strong>
            </div>
            <div>
              <h2>{{ floor.name }}</h2>
              <p>Published · Version {{ floor.sequence }}</p>
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
      <span class="yellow-dot"></span>Published floors
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
  private destroyed = false;
  private clickVersion = 0;
  constructor() {
    this.destroy.onDestroy(() => {
      this.destroyed = true;
      this.markers.forEach((m) => {
        this.maps?.event.clearInstanceListeners(m);
        m.map = null;
      });
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
      const [runtime, data] = await Promise.all([
        this.sdk.load(),
        firstValueFrom(this.http.get<{ buildings: Building[] }>('/api/maps/public/buildings/')),
      ]);
      if (this.destroyed) return;
      this.maps = runtime.maps;
      this.buildings.set(data.buildings);
      this.map ??= new runtime.maps.Map(this.canvas().nativeElement, {
        center: { lat: 43.784, lng: -79.187 },
        zoom: 16,
        mapId: runtime.mapId,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: true,
        gestureHandling: 'greedy',
      });
      this.maps.event.clearInstanceListeners(this.map);
      this.map.addListener('click', (event) => void this.onMapClick(event));
      this.markers.forEach((m) => {
        this.maps?.event.clearInstanceListeners(m);
        m.map = null;
      });
      this.markers = data.buildings.map((b) => {
        const pin = document.createElement('div');
        pin.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="35" height="45" viewBox="0 0 35 45"><path d="M17.5 43C14 37 2 25 2 17a15.5 15.5 0 0 1 31 0c0 8-12 20-15.5 26Z" fill="#f4c63d" stroke="#fff" stroke-width="2.5"/><circle cx="17.5" cy="17" r="5" fill="#665117"/></svg>';
        const marker = new runtime.maps.marker.AdvancedMarkerElement({
          map: this.map,
          position: { lat: b.latitude, lng: b.longitude },
          title: `${b.name} · ${b.floors.length} published floors`,
          content: pin,
          gmpClickable: true,
        });
        marker.addListener('click', () => this.choose(b));
        return marker;
      });
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
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Could not load buildings. Please retry.');
    } finally {
      this.loading.set(false);
    }
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
  async search(event: Event) {
    event.preventDefault();
    if (!this.query().trim() || this.searching()) return;
    const match = this.buildings().find((b) =>
      (b.name + ' ' + b.address).toLowerCase().includes(this.query().toLowerCase()),
    );
    if (match) {
      this.choose(match);
      return;
    }
    if (!this.maps) return;
    this.searching.set(true);
    this.note.set('');
    try {
      const { Place } = (await this.maps.importLibrary('places')) as PlacesLibrary;
      const result = await Place.searchByText({
        textQuery: this.query(),
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
        name: place.displayName || this.query(),
        address: place.formattedAddress || '',
        lat,
        lng,
      });
      this.map?.panTo({ lat, lng });
      this.map?.setZoom(18);
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
        if (this.destroyed) return;
        this.map?.panTo({ lat: p.coords.latitude, lng: p.coords.longitude });
        this.map?.setZoom(17);
        this.note.set('Map centered on your location.');
      },
      () => this.note.set('Location permission was unavailable. You can still explore the map.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }
}
