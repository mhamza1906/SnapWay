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
import { DomSanitizer } from '@angular/platform-browser';
import { Capacitor } from '@capacitor/core';
import { NATIVE_API_ORIGIN } from '../../core/native-api.interceptor';
import {
  GoogleMapsService,
  MapHandle,
  MapsRuntime,
  MarkerHandle,
  Coordinates,
} from '../../core/google-maps.service';

@Component({
  selector: 'app-walking-map',
  template: `@if (native) {
      <iframe
        #hostedMap
        class="canvas"
        [src]="hostedUrl()"
        title="Google map for walking"
        referrerpolicy="strict-origin-when-cross-origin"
        (load)="updateHosted()"
      ></iframe>
    } @else {
      <div #canvas class="canvas" aria-label="Google map for walking"></div>
    }
    @if (error() || (!native && sdk.error())) {
      <div class="fallback" role="status">
        <strong>Map unavailable</strong>
        <p>{{ error() || sdk.error() }}</p>
        <button (click)="load()">Try again</button>
      </div>
    } @else if (loading()) {
      <div class="fallback" role="status">Opening your map…</div>
    }
    @if (!location() && !destination() && !loading() && !error()) {
      <span class="area">Tap the re-center button to find your location.</span>
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
        border: 0;
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
  readonly native = Capacitor.isNativePlatform();
  private readonly channel = crypto.randomUUID();
  private readonly sanitizer = inject(DomSanitizer);
  private hostedAttempts = 0;
  readonly hostedUrl = signal(this.hostedMapUrl(0));
  readonly hostedMap = viewChild<ElementRef<HTMLIFrameElement>>('hostedMap');
  readonly sdk = inject(GoogleMapsService);
  readonly location = input<Coordinates | null>(null);
  readonly destination = input<Coordinates | null>(null);
  readonly canvas = viewChild<ElementRef<HTMLElement>>('canvas');
  readonly error = signal('');
  readonly loading = signal(true);
  private map?: MapHandle;
  private maps?: MapsRuntime;
  private user?: MarkerHandle;
  private target?: MarkerHandle;
  private destroyed = false;
  private hostedTimeout?: ReturnType<typeof setTimeout>;
  private readonly onHostedMessage = (event: MessageEvent) => {
    if (
      event.origin !== NATIVE_API_ORIGIN ||
      event.source !== this.hostedMap()?.nativeElement.contentWindow ||
      event.data?.channel !== this.channel
    )
      return;
    if (event.data.type === 'snapway.map.ready') {
      clearTimeout(this.hostedTimeout);
      this.loading.set(false);
      this.error.set('');
    } else if (event.data.type === 'snapway.map.error') {
      clearTimeout(this.hostedTimeout);
      this.loading.set(false);
      this.error.set('Google Maps is unavailable. You can still choose an indoor destination.');
    }
  };

  constructor() {
    effect(() => {
      this.location();
      this.destination();
      this.update();
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      window.removeEventListener('message', this.onHostedMessage);
      clearTimeout(this.hostedTimeout);
      if (this.user) this.user.map = null;
      if (this.target) this.target.map = null;
      if (this.map) this.maps?.event.clearInstanceListeners(this.map);
    });
  }
  ngAfterViewInit() {
    void this.load();
  }
  async load() {
    if (this.native) {
      if (this.hostedAttempts++ > 0) this.hostedUrl.set(this.hostedMapUrl(this.hostedAttempts));
      window.removeEventListener('message', this.onHostedMessage);
      window.addEventListener('message', this.onHostedMessage);
      this.loading.set(true);
      this.error.set('');
      clearTimeout(this.hostedTimeout);
      this.hostedTimeout = setTimeout(() => {
        this.loading.set(false);
        this.error.set('Unable to open the cloud map. Check your connection and retry.');
      }, 25000);
      this.updateHosted();
      return;
    }
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
      this.map ??= new maps.Map(this.canvas()!.nativeElement, {
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
    if (this.native) {
      this.updateHosted();
      return;
    }
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

  updateHosted() {
    this.hostedMap()?.nativeElement.contentWindow?.postMessage(
      {
        type: 'snapway.map.update',
        channel: this.channel,
        location: this.location(),
        destination: this.destination(),
      },
      NATIVE_API_ORIGIN,
    );
  }

  private hostedMapUrl(attempt: number) {
    return this.sanitizer.bypassSecurityTrustResourceUrl(
      `${NATIVE_API_ORIGIN}/api/maps/public/mobile-map/${attempt ? `?retry=${attempt}` : ''}#${this.channel}`,
    );
  }
}
