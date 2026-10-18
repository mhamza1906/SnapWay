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
  addListener(event: string, callback: () => void): { remove(): void };
}
export interface MapsRuntime {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => MapHandle;
  LatLngBounds: new () => BoundsHandle;
  marker: { AdvancedMarkerElement: new (options: Record<string, unknown>) => MarkerHandle };
  event: { clearInstanceListeners(instance: unknown): void };
  importLibrary(name: string): Promise<unknown>;
}

interface GoogleWindow extends Window {
  google?: { maps: MapsRuntime };
  snapwayMapsReady?: () => void;
  gm_authFailure?: () => void;
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
