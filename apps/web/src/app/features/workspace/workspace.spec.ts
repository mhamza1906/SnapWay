import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Workspace } from './workspace';

describe('Workspace API connection', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('recovers from an unavailable API and accepts a successful retry', () => {
    TestBed.configureTestingModule({
      imports: [Workspace],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(Workspace);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');

    button.click();
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
    http.expectOne('/api/health/live/').flush({}, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('API is unavailable');

    button.click();
    http.expectOne('/api/health/live/').flush({
      service: 'snapway-api',
      status: 'ok',
      release: 'test-build',
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Connected to snapway-api (test-build).');
  });
});
