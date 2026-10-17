import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  ActivatedRouteSnapshot,
  provideRouter,
  Router,
  RouterStateSnapshot,
} from '@angular/router';
import {
  AuthService,
  safeReturnPath,
  sessionGuard,
  developerGuard,
  adminGuard,
  publicGuard,
} from './auth.service';

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
    expect(auth.role()).toBe('Public User');
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
    ).toContain('/sign-in?returnUrl=');
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

  it('blocks public sessions from developer routes and normal developers from admin routes', async () => {
    const developer = TestBed.runInInjectionContext(() =>
      developerGuard({} as ActivatedRouteSnapshot, { url: '/graph-editor' } as RouterStateSnapshot),
    );
    http.expectOne('/api/auth/me/').flush({ authenticated: true, mode: 'public', can_admin: true });
    expect(
      TestBed.inject(Router).serializeUrl((await developer) as ReturnType<Router['createUrlTree']>),
    ).toBe('/public');
    expect(auth.canAdmin()).toBe(false);
    const admin = TestBed.runInInjectionContext(() =>
      adminGuard({} as ActivatedRouteSnapshot, { url: '/review' } as RouterStateSnapshot),
    );
    http
      .expectOne('/api/auth/me/')
      .flush({ authenticated: true, mode: 'developer', can_admin: false });
    expect(
      TestBed.inject(Router).serializeUrl((await admin) as ReturnType<Router['createUrlTree']>),
    ).toBe('/overview');
  });

  it('switches mode using a server POST without replacing the account', async () => {
    const pending = auth.switchMode('developer');
    http
      .expectOne('/api/auth/me/')
      .flush({ authenticated: true, username: 'Same account', mode: 'public' });
    const modeRequest = await vi.waitFor(() => http.expectOne('/api/auth/mode/'));
    expect(modeRequest.request.method).toBe('POST');
    expect(modeRequest.request.body).toEqual({ mode: 'developer' });
    modeRequest.flush({
      authenticated: true,
      username: 'Same account',
      mode: 'developer',
      can_admin: false,
    });
    expect(await pending).toBe(true);
    expect(auth.name()).toBe('Same account');
    expect(auth.isDeveloper()).toBe(true);
    expect(auth.canAdmin()).toBe(false);
  });

  it('separates experiences while retaining server privileges behind the Developer identity', async () => {
    const publicPage = TestBed.runInInjectionContext(() =>
      publicGuard({} as ActivatedRouteSnapshot, { url: '/public' } as RouterStateSnapshot),
    );
    http.expectOne('/api/auth/me/').flush({ authenticated: true, mode: 'public' });
    expect(await publicPage).toBe(true);
    expect(auth.landingPath()).toBe('/public');

    const developerPage = TestBed.runInInjectionContext(() =>
      publicGuard({} as ActivatedRouteSnapshot, { url: '/public' } as RouterStateSnapshot),
    );
    http
      .expectOne('/api/auth/me/')
      .flush({ authenticated: true, mode: 'developer', can_admin: true });
    expect(
      TestBed.inject(Router).serializeUrl(
        (await developerPage) as ReturnType<Router['createUrlTree']>,
      ),
    ).toBe('/overview');
    expect(auth.role()).toBe('Developer');
    expect(auth.canAdmin()).toBe(true);
  });

  it('requires a server session for the public placeholder', async () => {
    const pending = TestBed.runInInjectionContext(() =>
      publicGuard({} as ActivatedRouteSnapshot, { url: '/public' } as RouterStateSnapshot),
    );
    http.expectOne('/api/auth/me/').flush({ authenticated: false });
    expect(
      TestBed.inject(Router).serializeUrl((await pending) as ReturnType<Router['createUrlTree']>),
    ).toBe('/sign-in?returnUrl=%2Fpublic');
  });

  it('submits the selected mode with a CSRF token in the native Google start form', async () => {
    document.cookie = 'XSRF-TOKEN=synthetic-csrf';
    let submitted: HTMLFormElement | undefined;
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (
      this: HTMLFormElement,
    ) {
      submitted = this;
    });
    try {
      const pending = auth.signIn('public');
      http.expectOne('/api/auth/me/').flush({ authenticated: false });
      await pending;
      expect(submitted?.getAttribute('action')).toBe('/api/auth/google/start/');
      expect(submitted?.method).toBe('post');
      expect(new FormData(submitted).get('mode')).toBe('public');
      expect(new FormData(submitted).get('csrfmiddlewaretoken')).toBe('synthetic-csrf');
      expect(new FormData(submitted).has('next')).toBe(false);
    } finally {
      submit.mockRestore();
      document.cookie = 'XSRF-TOKEN=; Max-Age=0';
    }
  });
});
