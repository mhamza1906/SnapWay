import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { GoogleMapsService } from '../../core/google-maps.service';
import { NATIVE_API_ORIGIN } from '../../core/native-api.interceptor';
import { WalkingMap } from './walking-map';

describe('Native hosted walking map', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the HTTPS hosted map and accepts messages only from its own frame/channel', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const load = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: GoogleMapsService, useValue: { error: signal(''), load } }],
    });
    const fixture = TestBed.createComponent(WalkingMap);
    fixture.componentRef.setInput('location', { lat: 43.78, lng: -79.19 });
    fixture.detectChanges();
    const frame = fixture.nativeElement.querySelector('iframe') as HTMLIFrameElement;
    const url = new URL(frame.src);
    expect(url.origin).toBe(NATIVE_API_ORIGIN);
    expect(url.pathname).toBe('/api/maps/public/mobile-map/');
    expect(load).not.toHaveBeenCalled();
    const send = (origin: string, source: Window | null, channel: string) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          origin,
          source,
          data: { type: 'snapway.map.ready', channel },
        }),
      );
    send('https://untrusted.example', frame.contentWindow, url.hash.slice(1));
    expect(fixture.componentInstance.loading()).toBe(true);
    send(NATIVE_API_ORIGIN, window, url.hash.slice(1));
    expect(fixture.componentInstance.loading()).toBe(true);
    send(NATIVE_API_ORIGIN, frame.contentWindow, 'wrong-channel');
    expect(fixture.componentInstance.loading()).toBe(true);
    send(NATIVE_API_ORIGIN, frame.contentWindow, url.hash.slice(1));
    expect(fixture.componentInstance.loading()).toBe(false);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fixture.componentInstance.updateHosted();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'snapway.map.update',
        location: { lat: 43.78, lng: -79.19 },
      }),
      NATIVE_API_ORIGIN,
    );
    void fixture.componentInstance.load();
    fixture.detectChanges();
    expect(frame.src).not.toBe(url.href);
    expect(new URL(frame.src).hash).toBe(url.hash);
    expect(new URL(frame.src).searchParams.has('retry')).toBe(true);
    fixture.destroy();
  });
});
