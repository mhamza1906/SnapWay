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
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import {
  GoogleMapsService,
  MapHandle,
  MapsRuntime,
  MarkerHandle,
} from '../../core/google-maps.service';
import { Icon } from '../../shared/icon';

export interface PublicBuilding {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  floors: {
    target_id: string;
    name: string;
    code: string;
    publication_id: string;
    sequence: number;
  }[];
}

@Component({
  selector: 'app-public-map',
  imports: [RouterLink, Icon],
  templateUrl: './map.html',
  styleUrl: './map.scss',
})
export class PublicMapPage implements AfterViewInit {
  readonly contributorEnabled = inject(ActivatedRoute).snapshot.data['contributor'] !== false;
  readonly auth = inject(AuthService);
  readonly sdk = inject(GoogleMapsService);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  readonly canvas = viewChild.required<ElementRef<HTMLElement>>('canvas');
  readonly buildings = signal<PublicBuilding[]>([]);
  readonly query = signal('');
  readonly selected = signal<PublicBuilding | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly buildingsError = signal('');
  readonly locationMessage = signal('Use your location to find nearby buildings.');
  readonly locating = signal(false);
  readonly location = signal<{ lat: number; lng: number; accuracy: number } | null>(null);
  readonly filtered = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.buildings().filter((b) => (b.name + ' ' + b.address).toLowerCase().includes(query));
  });
  private map?: MapHandle;
  private maps?: MapsRuntime;
  private markers: MarkerHandle[] = [];
  private userMarker?: MarkerHandle;
  private destroyed = false;
  private attempt = 0;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.clearMarkers();
      if (this.userMarker) this.userMarker.map = null;
      if (this.map) this.maps?.event.clearInstanceListeners(this.map);
    });
  }

  ngAfterViewInit() {
    void this.initialize();
  }

  retryMap() {
    // A late Google authorization failure requires a fresh SDK load after fixing
    // the Console restriction; never loop automatically or keep a poisoned cache.
    if (this.sdk.error()) window.location.reload();
    else void this.initialize();
  }

  async initialize() {
    if (this.destroyed) return;
    const attempt = ++this.attempt;
    this.loading.set(true);
    this.error.set('');
    const buildings = this.refreshBuildings();
    try {
      const { maps, mapId } = await this.sdk.load();
      if (this.destroyed || attempt !== this.attempt) return;
      this.maps = maps;
      this.map ??= new maps.Map(this.canvas().nativeElement, {
        center: { lat: 43.6532, lng: -79.3832 },
        zoom: 12,
        mapId,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: false,
      });
      await buildings;
      if (this.destroyed || attempt !== this.attempt) return;
      this.renderMarkers();
      if (this.buildings().length) {
        const bounds = new maps.LatLngBounds();
        this.buildings().forEach((b) => bounds.extend({ lat: b.latitude, lng: b.longitude }));
        if (this.buildings().length === 1) this.choose(this.buildings()[0]);
        else this.map.fitBounds(bounds, 80);
      }
      // Reuse a granted permission; a fresh permission is requested by the button.
      if (navigator.permissions) {
        const permission = await navigator.permissions
          .query({ name: 'geolocation' })
          .catch(() => null);
        if (!this.destroyed && permission?.state === 'granted') this.locate();
      }
    } catch (error) {
      if (!this.destroyed)
        this.error.set(error instanceof Error ? error.message : 'Could not open the map.');
    } finally {
      if (!this.destroyed && attempt === this.attempt) this.loading.set(false);
    }
  }

  private async refreshBuildings() {
    this.buildingsError.set('');
    try {
      const payload = await firstValueFrom(
        this.http.get<{ buildings: PublicBuilding[] }>('/api/maps/public/buildings/'),
      );
      if (!this.destroyed) this.buildings.set(payload.buildings);
    } catch {
      if (!this.destroyed)
        this.buildingsError.set('Available buildings could not be loaded. Please retry.');
    }
  }

  private clearMarkers() {
    for (const marker of this.markers) {
      this.maps?.event.clearInstanceListeners(marker);
      marker.map = null;
    }
    this.markers = [];
  }

  private renderMarkers() {
    this.clearMarkers();
    if (!this.maps || !this.map) return;
    for (const building of this.buildings()) {
      const marker = new this.maps.marker.AdvancedMarkerElement({
        map: this.map,
        position: { lat: building.latitude, lng: building.longitude },
        title: building.name,
        gmpClickable: true,
      });
      marker.addListener('click', () => this.choose(building));
      this.markers.push(marker);
    }
  }

  choose(building: PublicBuilding) {
    this.selected.set(building);
    this.map?.panTo({ lat: building.latitude, lng: building.longitude });
    this.map?.setZoom(17);
  }

  directions(building: PublicBuilding) {
    return (
      'https://www.google.com/maps/dir/?' +
      new URLSearchParams({
        api: '1',
        destination: `${building.latitude},${building.longitude}`,
        travelmode: 'walking',
      })
    );
  }

  locate() {
    if (this.locating() || this.destroyed) return;
    if (!navigator.geolocation) {
      this.locationMessage.set(
        'Location is unavailable in this browser. Search for a building instead.',
      );
      return;
    }
    this.locating.set(true);
    this.locationMessage.set('Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (this.destroyed) return;
        const point = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };
        this.location.set(point);
        this.locationMessage.set(`Location found · accuracy about ${Math.round(point.accuracy)} m`);
        this.map?.panTo(point);
        this.map?.setZoom(17);
        if (this.userMarker) this.userMarker.position = point;
        else if (this.maps && this.map)
          this.userMarker = new this.maps.marker.AdvancedMarkerElement({
            map: this.map,
            position: point,
            title: 'Your approximate location',
          });
        this.locating.set(false);
      },
      (error) => {
        if (this.destroyed) return;
        this.locating.set(false);
        this.locationMessage.set(
          error.code === 1
            ? 'Location permission was denied. You can still search buildings, or allow location in your browser settings.'
            : 'Your location could not be found. Try again or search for a building.',
        );
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  }
}
