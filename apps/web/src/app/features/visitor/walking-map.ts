import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  GoogleMapsService,
  MapHandle,
  MapsRuntime,
  MarkerHandle,
  Coordinates,
} from '../../core/google-maps.service';

@Component({
  selector: 'app-walking-map',
  template: `<div #canvas class="canvas" aria-label="Google map for walking"></div>
    @if (error() || sdk.error()) {
      <div class="fallback" role="status">
        <strong>Map unavailable</strong>
        <p>{{ sdk.error() || error() }}</p>
        <button (click)="load()">Try again</button>
      </div>
    } @else if (loading()) {
      <div class="fallback" role="status">Opening your map…</div>
    }
    @if (!location() && !destination() && !loading() && !error()) {
      <span class="area">Toronto area · location not yet available</span>
    }`,
  styles: [
    `
      :host {
        display: block;
        position: absolute;
        inset: 0;
      }
      .canvas {
        height: 100%;
        width: 100%;
      }
      .fallback {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 32px;
        text-align: center;
        background: #eceee9;
        color: #56635c;
      }
      .fallback p {
        max-width: 270px;
        font-size: 13px;
      }
      .fallback button {
        border: 1px solid #b7c1b8;
        background: white;
        border-radius: 30px;
        padding: 10px 20px;
      }
      .area {
        position: absolute;
        top: 12px;
        left: 12px;
        background: white;
        padding: 7px 12px;
        border-radius: 20px;
        font-size: 11px;
      }
    `,
  ],
})
export class WalkingMap implements AfterViewInit {
  readonly sdk = inject(GoogleMapsService);
  readonly location = input<Coordinates | null>(null);
  readonly destination = input<Coordinates | null>(null);
  readonly canvas = viewChild.required<ElementRef<HTMLElement>>('canvas');
  readonly error = signal('');
  readonly loading = signal(true);
  private map?: MapHandle;
  private maps?: MapsRuntime;
  private user?: MarkerHandle;
  private target?: MarkerHandle;
  private destroyed = false;

  constructor() {
    effect(() => {
      this.location();
      this.destination();
      this.update();
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      if (this.user) this.user.map = null;
      if (this.target) this.target.map = null;
      if (this.map) this.maps?.event.clearInstanceListeners(this.map);
    });
  }
  ngAfterViewInit() {
    void this.load();
  }
  async load() {
    if (this.sdk.error()) {
      window.location.reload();
      return;
    }
    this.loading.set(true);
    this.error.set('');
    try {
      const { maps, mapId } = await this.sdk.load();
      if (this.destroyed) return;
      this.maps = maps;
      this.map ??= new maps.Map(this.canvas().nativeElement, {
        center: this.location() ?? this.destination() ?? { lat: 43.6532, lng: -79.3832 },
        zoom: 17,
        mapId,
        disableDefaultUI: true,
        cameraControl: false,
        zoomControl: false,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: false,
      });
      this.update();
    } catch (error) {
      if (!this.destroyed)
        this.error.set(error instanceof Error ? error.message : 'Please check your connection.');
    } finally {
      if (!this.destroyed) this.loading.set(false);
    }
  }
  private update() {
    if (!this.maps || !this.map) return;
    const location = this.location();
    const destination = this.destination();
    if (location) {
      if (this.user) this.user.position = location;
      else
        this.user = new this.maps.marker.AdvancedMarkerElement({
          map: this.map,
          position: location,
          title: 'Your approximate location',
          content: this.markerPin('#dc3c35'),
        });
    }
    if (this.target) this.target.map = null;
    this.target = destination
      ? new this.maps.marker.AdvancedMarkerElement({
          map: this.map,
          position: destination,
          title: 'Destination building',
          content: this.markerPin('#2563eb'),
        })
      : undefined;
    const center = location ?? destination;
    if (center) {
      this.map.panTo(center);
      this.map.setZoom(17);
    }
  }
  private markerPin(color: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 32 42');
    svg.setAttribute('width', '32');
    svg.setAttribute('height', '42');
    svg.setAttribute('aria-hidden', 'true');
    const pin = document.createElementNS(svg.namespaceURI, 'path');
    pin.setAttribute('d', 'M16 41C13 30 1 25 1 16a15 15 0 0 1 30 0c0 9-12 14-15 25Z');
    pin.setAttribute('fill', color);
    pin.setAttribute('stroke', '#ffffff');
    pin.setAttribute('stroke-width', '1.5');
    const center = document.createElementNS(svg.namespaceURI, 'circle');
    center.setAttribute('cx', '16');
    center.setAttribute('cy', '16');
    center.setAttribute('r', '5');
    center.setAttribute('fill', '#ffffff');
    svg.append(pin, center);
    return svg;
  }
}
