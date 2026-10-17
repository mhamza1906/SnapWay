import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  ActivatedRouteSnapshot,
  provideRouter,
  Router,
  RouterStateSnapshot,
} from '@angular/router';
import { AuthService, safeReturnPath, sessionGuard } from './auth.service';

describe('Django session authentication', () => {
  let http: HttpTestingController;
  let auth: AuthService;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });
  afterEach(() => http.verify());

  it('never derives account permissions from the local prototype role', async () => {
    const pending = auth.refresh();
    http
      .expectOne('/api/auth/me/')
      .flush({ authenticated: true, username: 'Mapper', memberships: [], is_staff: false });
    await pending;
    expect(auth.signedIn()).toBe(true);
    expect(auth.role()).toBe('No map membership');
  });

  it('protects contributor URLs and preserves only a safe return path', async () => {
    const guard = TestBed.runInInjectionContext(() =>
      sessionGuard(
        {} as ActivatedRouteSnapshot,
        { url: '/graph-editor?target=abc' } as RouterStateSnapshot,
      ),
    );
    http.expectOne('/api/auth/me/').flush({ authenticated: false });
    const redirect = await guard;
    expect(
      TestBed.inject(Router).serializeUrl(redirect as ReturnType<Router['createUrlTree']>),
    ).toContain('/welcome?returnUrl=');
    for (const unsafe of [
      'https://evil.invalid',
      '//evil.invalid',
      '/\\evil.invalid',
      '/auth/complete',
      '/welcome',
    ])
      expect(safeReturnPath(unsafe)).toBe('/map');
    expect(safeReturnPath('/graph-editor?target=abc')).toBe('/graph-editor?target=abc');
  });

  it('retains identity and reports an error when logout fails', async () => {
    const refreshed = auth.refresh();
    const pending = auth.signOut();
    http.expectOne('/api/auth/me/').flush({ authenticated: true, username: 'Mapper' });
    await refreshed;
    http.expectOne('/api/auth/logout/').flush({}, { status: 403, statusText: 'Forbidden' });
    expect(await pending).toBe(false);
    expect(auth.signedIn()).toBe(true);
    expect(auth.error()).toContain('Could not sign out');
  });

  it('clears the in-memory identity only after server logout succeeds', async () => {
    const refreshed = auth.refresh();
    const pending = auth.signOut();
    http.expectOne('/api/auth/me/').flush({ authenticated: true, username: 'Mapper' });
    await refreshed;
    const logout = http.expectOne('/api/auth/logout/');
    expect(logout.request.method).toBe('POST');
    logout.flush({ authenticated: false });
    expect(await pending).toBe(true);
    expect(auth.signedIn()).toBe(false);
  });
});
