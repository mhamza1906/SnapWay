import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AuthCompletePage } from './auth-complete';

describe('Google callback landing', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
  });
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    sessionStorage.removeItem('snapway.auth.return');
  });

  it.each([
    ['developer', '/overview'],
    ['public', '/public'],
  ])('opens the %s experience directly from the verified server session', async (mode, path) => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(AuthCompletePage);
    TestBed.inject(HttpTestingController)
      .expectOne('/api/auth/me/')
      .flush({ authenticated: true, mode });
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(path, { replaceUrl: true });
  });

  it('does not enter either experience when the provider did not establish a session', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(AuthCompletePage);
    TestBed.inject(HttpTestingController)
      .expectOne('/api/auth/me/')
      .flush({ authenticated: false });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(navigate).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('No signed-in session was found');
  });
  it('restores the selected saved photo walk after developer sign-in', async () => {
    sessionStorage.setItem('snapway.auth.return', '/graph-editor?target=saved-walk&mode=photos');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(AuthCompletePage);
    TestBed.inject(HttpTestingController)
      .expectOne('/api/auth/me/')
      .flush({ authenticated: true, mode: 'developer' });
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      '/graph-editor?target=saved-walk&mode=photos',
      { replaceUrl: true },
    );
    expect(sessionStorage.getItem('snapway.auth.return')).toBeNull();
  });
});
