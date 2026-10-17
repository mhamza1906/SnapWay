import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-public-placeholder',
  imports: [RouterLink],
  template: `<div class="placeholder">
    <header>
      <a routerLink="/sign-in" aria-label="Snapway · Choose your experience">snapway.</a>
    </header>
    <main aria-labelledby="public-title">
      <p class="eyebrow">PUBLIC USER</p>
      <h1 id="public-title">A new way forward.<br />Coming soon.</h1>
      <p>You're signed in as {{ auth.name() }}.</p>
      <p>
        This experience is being updated. Your public navigation page will be available here soon.
      </p>
      <div class="actions">
        <button class="btn primary" (click)="switchToDeveloper()" [disabled]="auth.busy()">
          Switch to Developer
        </button>
        <button class="btn secondary" (click)="signOut()" [disabled]="auth.busy()">Sign out</button>
      </div>
      @if (auth.error()) {
        <p class="notice error" role="alert">{{ auth.error() }}</p>
      }
    </main>
  </div>`,
  styles: `
    :host {
      display: block;
    }
    .placeholder {
      min-height: 100dvh;
      background: #faf9f6;
      color: #293e31;
    }
    header {
      padding: 28px clamp(24px, 5vw, 72px);
    }
    header a {
      color: inherit;
      font-size: 26px;
      font-weight: 800;
      text-decoration: none;
    }
    main {
      width: min(620px, 100%);
      margin: 7vh auto 0;
      padding: 0 24px 48px;
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 2px;
      font-weight: 700;
      color: #677c5a;
    }
    h1 {
      margin: 22px 0;
      font:
        italic 500 clamp(38px, 7vw, 64px) / 1.08 Georgia,
        serif;
      letter-spacing: -1.5px;
    }
    main > p:not(.eyebrow) {
      line-height: 1.8;
      color: #65715f;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 28px;
    }
  `,
})
export class PublicPlaceholderPage {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  async switchToDeveloper() {
    if (await this.auth.switchMode('developer'))
      await this.router.navigateByUrl(this.auth.landingPath());
  }

  async signOut() {
    if (await this.auth.signOut()) await this.router.navigateByUrl('/sign-in');
  }
}
