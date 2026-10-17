import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService, ExperienceMode } from '../../core/auth.service';
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
      <small>One account. A different perspective whenever you need it.</small>
    </section>
    <section class="form">
      <a class="back" routerLink="/map"><app-icon name="arrow-left" /> Back to the map</a>
      <p class="eyebrow">WELCOME TO SNAPWAY</p>
      <h2>You're signed in.</h2>
      <p>Signed in as {{ auth.name() }}.</p>
      <p role="status">
        Your current experience: <strong>{{ auth.role() }}</strong
        >.
      </p>
      <a class="btn primary" [routerLink]="destination()">
        {{ auth.isDeveloper() ? 'Continue to workspace' : 'Find your way' }}
        <app-icon name="arrow-right" />
      </a>
      <div class="visitor">
        <strong>A different perspective?</strong>
        <p>Switch experiences with the same Google account.</p>
        <button class="btn secondary" (click)="switchMode()" [disabled]="auth.busy()">
          {{
            auth.busy()
              ? 'Switching…'
              : auth.isDeveloper()
                ? 'Switch to Public User'
                : 'Switch to Developer'
          }}
        </button>
      </div>
      @if (auth.error()) {
        <p class="notice error" role="alert">{{ auth.error() }}</p>
      }
      <p class="footnote">Administrator access is assigned by the SnapWay team.</p>
      <button class="btn ghost" (click)="signOut()" [disabled]="auth.busy()">Sign out</button>
    </section>
  </main>`,
  styleUrl: './welcome.scss',
})
export class WelcomePage {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly destination = computed(() => (this.auth.isDeveloper() ? '/overview' : '/map'));

  async switchMode() {
    const mode: ExperienceMode = this.auth.isDeveloper() ? 'public' : 'developer';
    await this.auth.switchMode(mode);
  }

  async signOut() {
    if (await this.auth.signOut()) await this.router.navigateByUrl('/sign-in');
  }
}
