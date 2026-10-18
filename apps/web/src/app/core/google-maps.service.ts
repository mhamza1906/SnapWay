import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { ClientConfigService } from './client-config.service';

export interface Coordinates {
  lat: number;
  lng: number;
}
export interface MapHandle {
  addListener(event: string, callback: (event: MapClick) => void): { remove(): void };
  panTo(position: Coordinates): void;
  setZoom(zoom: number): void;
  fitBounds(bounds: BoundsHandle, padding?: number): void;
}
export interface MapClick {
  placeId?: string;
  latLng?: { lat(): number; lng(): number };
  stop?(): void;
}
export interface BoundsHandle {
  extend(position: Coordinates): void;
}
export interface MarkerHandle {
  map: MapHandle | null;
  position: Coordinates;
  setMap?(map: MapHandle | null): void;
  addListener(event: string, callback: () => void): { remove(): void };
}
export interface MapsRuntime {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => MapHandle;
  LatLngBounds: new () => BoundsHandle;
  Size: new (width: number, height: number) => unknown;
  Marker: new (options: Record<string, unknown>) => MarkerHandle;
  marker: { AdvancedMarkerElement: new (options: Record<string, unknown>) => MarkerHandle };
  event: { clearInstanceListeners(instance: unknown): void };
  importLibrary(name: string): Promise<unknown>;
}

interface GoogleWindow extends Window {
  google?: { maps: MapsRuntime };
  snapwayMapsReady?: () => void;
  gm_authFailure?: () => void;
}

/** Reliable pin icons — classic Marker does not require a Cloud mapId. */
export function mapPinIcon(maps: MapsRuntime, fill: string) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="35" height="45" viewBox="0 0 35 45">` +
    `<path d="M17.5 43C14 37 2 25 2 17a15.5 15.5 0 0 1 31 0c0 8-12 20-15.5 26Z" fill="${fill}" stroke="#fff" stroke-width="2.5"/>` +
    `<circle cx="17.5" cy="17" r="5" fill="#fff"/></svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new maps.Size(35, 45),
    anchor: { x: 17, y: 43 },
  };
}

export function detachMarker(maps: MapsRuntime | undefined, marker: MarkerHandle) {
  maps?.event.clearInstanceListeners(marker);
  if (typeof marker.setMap === 'function') marker.setMap(null);
  marker.map = null;
}

@Injectable({ providedIn: 'root' })
export class GoogleMapsService {
  private readonly document = inject(DOCUMENT);
  private readonly config = inject(ClientConfigService);
  private pending?: Promise<{ maps: MapsRuntime; mapId: string }>;
  readonly error = signal('');

  load() {
    return (this.pending ??= this.initialize().catch((error) => {
      this.pending = undefined;
      throw error;
    }));
  }

  private async initialize(): Promise<{ maps: MapsRuntime; mapId: string }> {
    const config = await this.config.load();
    if (!config.maps.browser_key)
      throw new Error('Google Maps is not configured yet. Please try again later.');
    const win = this.document.defaultView as GoogleWindow;
    this.error.set('');
    win.gm_authFailure = () =>
      this.error.set('Google Maps could not authorize this website. Please contact the team.');
    if (!win.google?.maps?.importLibrary) {
      await new Promise<void>((resolve, reject) => {
        const script = this.document.createElement('script');
        const finish = (error?: Error) => {
          clearTimeout(timer);
          delete win.snapwayMapsReady;
          if (error) {
            script.remove();
            reject(error);
          } else resolve();
        };
        const timer = setTimeout(
          () => finish(new Error('Google Maps timed out. Check your connection and retry.')),
          20000,
        );
        win.snapwayMapsReady = () => finish();
        win.gm_authFailure = () => {
          this.error.set('Google Maps could not authorize this website. Please contact the team.');
          finish(new Error(this.error()));
        };
        script.onerror = () =>
          finish(new Error('Google Maps could not load. Check your connection and retry.'));
        script.src =
          'https://maps.googleapis.com/maps/api/js?' +
          new URLSearchParams({
            key: config.maps.browser_key,
            v: 'quarterly',
            loading: 'async',
            callback: 'snapwayMapsReady',
          });
        script.async = true;
        this.document.head.append(script);
      });
    }
    const maps = win.google!.maps;
    await Promise.all([maps.importLibrary('maps'), maps.importLibrary('marker')]);
    return { maps, mapId: config.maps.map_id || 'DEMO_MAP_ID' };
  }
}
