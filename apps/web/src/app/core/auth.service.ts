import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

export interface SessionIdentity {
  authenticated: boolean;
  username?: string;
  email?: string;
  is_staff?: boolean;
  is_superuser?: boolean;
  memberships?: { target_id: string; role: 'admin' | 'volunteer' }[];
  mode?: ExperienceMode;
  available_modes?: ExperienceMode[];
  can_admin?: boolean;
}

export type ExperienceMode = 'developer' | 'public';

export function safeReturnPath(value: string | null): string {
  return value &&
    /^\/(map|public|overview|graph-editor|targets|contributions|authoring|review|activity|settings|help)([/?#]|$)/.test(
      value,
    ) &&
    !/[\\\r\n]/.test(value)
    ? value
    : '/map';
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private pending?: Promise<SessionIdentity>;
  readonly session = signal<SessionIdentity | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly signedIn = computed(() => this.session()?.authenticated === true);
  readonly mode = computed<ExperienceMode>(() => this.session()?.mode ?? 'public');
  readonly isDeveloper = computed(() => this.signedIn() && this.mode() === 'developer');
  readonly landingPath = computed(() => (this.isDeveloper() ? '/overview' : '/public'));
  readonly canAdmin = computed(() => this.isDeveloper() && this.session()?.can_admin === true);
  readonly name = computed(() => this.session()?.username || 'Guest');
  readonly initials = computed(() => this.name().slice(0, 2).toUpperCase());
  readonly role = computed(() => {
    const user = this.session();
    if (!user?.authenticated) return 'Guest';
    if (!this.isDeveloper()) return 'Public User';
    return 'Developer';
  });

  refresh(): Promise<SessionIdentity> {
    return (this.pending ??= firstValueFrom(this.http.get<SessionIdentity>('/api/auth/me/'))
      .then((session) => {
        this.session.set(session);
        this.error.set('');
        return session;
      })
      .catch(() => {
        this.session.set(null);
        this.error.set('Could not check your session. Check your connection and try again.');
        throw new Error(this.error());
      })
      .finally(() => {
        this.pending = undefined;
      }));
  }

  async signIn(mode: ExperienceMode): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      // Refresh also obtains Django's CSRF cookie for the same-origin form POST.
      await this.refresh();
      const token = this.document.cookie
        .split('; ')
        .find((v) => v.startsWith('XSRF-TOKEN='))
        ?.split('=')
        .slice(1)
        .join('=');
      if (!token) throw new Error('Sign-in needs cookies enabled. Reload this page and try again.');
      const form = this.document.createElement('form');
      form.method = 'POST';
      form.action = '/api/auth/google/start/';
      for (const [name, value] of Object.entries({
        csrfmiddlewaretoken: decodeURIComponent(token),
        mode,
      })) {
        const input = this.document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.append(input);
      }
      this.document.body.append(form);
      form.submit();
      form.remove();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not start Google sign-in.');
      this.busy.set(false);
    }
  }

  async switchMode(mode: ExperienceMode): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    try {
      await this.refresh();
      const session = await firstValueFrom(
        this.http.post<SessionIdentity>('/api/auth/mode/', { mode }),
      );
      this.session.set(session);
      this.error.set('');
      return true;
    } catch {
      this.error.set('Could not switch your experience. Please try again.');
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async signOut(): Promise<boolean> {
    this.busy.set(true);
    try {
      await this.refresh();
      const session = await firstValueFrom(
        this.http.post<SessionIdentity>('/api/auth/logout/', {}),
      );
      this.session.set(session);
      this.error.set('');
      return true;
    } catch {
      this.error.set('Could not sign out. Please try again.');
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}

export const sessionGuard = (async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  try {
    if ((await auth.refresh()).authenticated) return true;
  } catch {
    /* The sign-in page displays the service failure with a retry. */
  }
  return router.createUrlTree(['/sign-in'], {
    queryParams: { returnUrl: safeReturnPath(state.url) },
  });
}) satisfies CanActivateFn;

export const developerGuard = (async (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const result = await sessionGuard(route, state);
  if (result !== true) return result;
  return auth.isDeveloper() ? true : router.createUrlTree(['/public']);
}) satisfies CanActivateFn;

export const publicGuard = (async (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const result = await sessionGuard(route, state);
  if (result !== true) return result;
  return auth.isDeveloper() ? router.createUrlTree(['/overview']) : true;
}) satisfies CanActivateFn;

export const adminGuard = (async (route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const result = await developerGuard(route, state);
  if (result !== true) return result;
  return auth.canAdmin() ? true : router.createUrlTree(['/overview']);
}) satisfies CanActivateFn;
