import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { nativeApiInterceptor } from './native-api.interceptor';

describe('Installed visitor API transport', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([nativeApiInterceptor])),
        provideHttpClientTesting(),
      ],
    });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.restoreAllMocks();
  });

  it('loads Maps config and published buildings from HTTPS on the phone', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const http = TestBed.inject(HttpClient);
    const backend = TestBed.inject(HttpTestingController);
    for (const path of ['/api/client-config/', '/api/maps/public/buildings/?floor=5']) {
      http.get(path).subscribe();
      const request = backend.expectOne('https://snapway.work' + path);
      expect(request.request.withCredentials).toBe(false);
      request.flush({});
    }
  });

  it('preserves photo uploads without adding developer session credentials', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const photo = new FormData();
    photo.append('image', new Blob(['test-photo'], { type: 'image/jpeg' }), 'location.jpg');
    TestBed.inject(HttpClient).post('/api/navigation/localize/', photo).subscribe();
    const request = TestBed.inject(HttpTestingController).expectOne(
      'https://snapway.work/api/navigation/localize/',
    );
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBe(photo);
    expect(request.request.withCredentials).toBe(false);
    expect(request.request.headers.has('Authorization')).toBe(false);
    request.flush({});
  });

  it('keeps website API calls on the website origin', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    TestBed.inject(HttpClient).get('/api/client-config/').subscribe();
    TestBed.inject(HttpTestingController).expectOne('/api/client-config/').flush({});
  });

  it('leaves bundled assets and explicitly addressed requests untouched', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    for (const url of ['/assets/photo.jpg', 'https://example.invalid/api/config/']) {
      TestBed.inject(HttpClient).get(url).subscribe();
      TestBed.inject(HttpTestingController).expectOne(url).flush({});
    }
  });
});
