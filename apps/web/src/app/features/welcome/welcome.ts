import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthService, safeReturnPath } from '../../core/auth.service';
import { ClientConfigService } from '../../core/client-config.service';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'app-welcome',
  imports: [RouterLink, Icon],
  template: `<main class="sign-in">
    <section class="story">
      <a class="brand" routerLink="/map"><app-icon name="route" />snapway.</a>
      <div>
        <p class="eyebrow">A CLEARER WAY THROUGH</p>
        <h1>Local knowledge.<br />Shared direction.</h1>
        <p>Help make the places you know easier for everyone to navigate.</p>
        <div class="route-art" aria-hidden="true"><span></span><i></i><b></b></div>
      </div>
      <small>Explore freely. Contribute with a Google account.</small>
    </section>
    <section class="form">
      <a class="back" routerLink="/map"><app-icon name="arrow-left" /> Back to the map</a>
      <p class="eyebrow">WELCOME TO SNAPWAY</p>
      <h2>{{ auth.signedIn() ? 'You’re signed in.' : 'Your next contribution starts here.' }}</h2>
      @if (auth.signedIn()) {
        <p>Signed in as {{ auth.name() }}.</p>
        <a class="btn primary" [routerLink]="returnPath"
          >Continue to SnapWay <app-icon name="arrow-right"
        /></a>
      } @else {
        <p>Sign in to create and improve maps. Your access is managed by the map’s team.</p>
        <button
          class="google-button"
          (click)="auth.signIn(returnPath)"
          [disabled]="loading() || !enabled() || auth.busy()"
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 48 48">
            <path
              fill="#4285f4"
              d="M43.6 24.5c0-1.4-.1-2.8-.4-4.2H24v8h11c-.5 2.6-1.9 4.8-4.1 6.3v5.2h6.6c3.9-3.6 6.1-8.9 6.1-15.3Z"
            />
            <path
              fill="#34a853"
              d="M24 44c5.5 0 10.2-1.8 13.6-5l-6.6-5.2c-1.8 1.2-4.1 1.9-7 1.9-5.3 0-9.7-3.5-11.3-8.2H6v5.4C9.4 39.5 16.2 44 24 44Z"
            />
            <path fill="#fbbc05" d="M12.7 27.5a12 12 0 0 1 0-7.1V15H6a20 20 0 0 0 0 18l6.7-5.5Z" />
            <path
              fill="#ea4335"
              d="M24 12.3c3 0 5.6 1 7.7 3l5.8-5.8A19.3 19.3 0 0 0 24 4C16.2 4 9.4 8.5 6 15l6.7 5.4c1.6-4.7 6-8.1 11.3-8.1Z"
            />
          </svg>
          {{ auth.busy() ? 'Connecting to Google…' : 'Continue with Google' }}
        </button>
        @if (loading()) {
          <p role="status">Checking sign-in availability…</p>
        }
        @if (configError() || auth.error()) {
          <div class="notice error" role="alert">
            {{ auth.error() || configError()
            }}<button class="btn ghost small" (click)="loadConfig()">Retry</button>
          </div>
        }
        @if (!loading() && !enabled() && !configError()) {
          <p role="status">
            Google sign-in is not available yet. You can still explore public buildings.
          </p>
        }
      }
      <div class="visitor">
        <strong>Just finding your way?</strong>
        <p>No account needed to explore published buildings.</p>
        <a routerLink="/map" class="link">Continue as a visitor <app-icon name="arrow-right" /></a>
      </div>
      <p class="footnote">
        Signing in confirms your identity. A team member assigns access to each map.
      </p>
    </section>
  </main>`,
  styleUrl: './welcome.scss',
})
export class WelcomePage {
  readonly auth = inject(AuthService);
  private readonly config = inject(ClientConfigService);
  private readonly route = inject(ActivatedRoute);
  readonly returnPath = safeReturnPath(this.route.snapshot.queryParamMap.get('returnUrl'));
  readonly enabled = signal(false);
  readonly loading = signal(true);
  readonly configError = signal('');
  constructor() {
    void this.loadConfig();
  }
  async loadConfig() {
    this.loading.set(true);
    this.configError.set('');
    try {
      this.enabled.set((await this.config.load()).auth.google_enabled);
    } catch {
      this.configError.set('Could not check sign-in availability. Please try again.');
    } finally {
      this.loading.set(false);
    }
  }
}
