import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NATIVE_API_ORIGIN } from '../../core/native-api.interceptor';
import { Icon } from '../../shared/icon';

/** Native visitor assets stay separate from the website's developer workspace. */
@Component({
  selector: 'app-mobile-entry',
  imports: [RouterLink, Icon],
  template: `
    <main class="mobile-entry">
      <header><app-icon name="route" /><span>snapway.</span></header>
      <h1>How would you like to use SnapWay?</h1>
      <p>Choose your experience.</p>
      <nav aria-label="Choose experience">
        <a routerLink="/public" class="experience visitor">
          <app-icon name="compass" />
          <strong>Find my way</strong>
          <span>Choose a building, follow the map and locate yourself with your camera.</span>
          <b>Open visitor app <app-icon name="arrow-right" /></b>
        </a>
        <a [href]="developerUrl" class="experience developer" rel="external noreferrer">
          <app-icon name="map" />
          <strong>Developer workspace</strong>
          <span>Use your existing maps, photo walks and authoring tools.</span>
          <b>Open in browser <app-icon name="arrow-right" /></b>
        </a>
      </nav>
      <p class="browser-note">Developer sign-in opens in your phone's browser.</p>
    </main>
  `,
  styles: `
    :host {
      display: block;
    }
    .mobile-entry {
      max-width: 640px;
      margin: 0 auto;
      min-height: 100dvh;
      padding: calc(env(safe-area-inset-top) + 24px) calc(env(safe-area-inset-right) + 20px)
        calc(env(safe-area-inset-bottom) + 24px) calc(env(safe-area-inset-left) + 20px);
    }
    header {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 30px;
      font-weight: 750;
      margin-bottom: 38px;
    }
    header app-icon {
      width: 34px;
      height: 34px;
      color: var(--accent);
    }
    h1 {
      font-size: clamp(24px, 6vw, 32px);
    }
    p {
      color: var(--muted);
    }
    nav {
      display: grid;
      gap: 16px;
      margin-top: 28px;
    }
    .experience {
      display: grid;
      gap: 12px;
      padding: 24px;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 18px;
    }
    .experience > app-icon {
      width: 30px;
      height: 30px;
      color: var(--green);
    }
    .experience strong {
      font-size: 21px;
    }
    .experience span {
      line-height: 1.6;
      color: var(--muted);
    }
    .experience b {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 8px;
      font-size: 14px;
      color: var(--green);
    }
    .experience b app-icon {
      width: 20px;
      height: 20px;
    }
    .visitor {
      border-color: var(--green);
    }
    .browser-note {
      margin-top: 24px;
      font-size: 12px;
    }
  `,
})
export class MobileEntry {
  // Capacitor's existing external-navigation policy hands this HTTPS link to
  // the system browser on Android/iOS; OAuth never runs in the app WebView.
  readonly developerUrl = `${NATIVE_API_ORIGIN}/sign-in?returnUrl=%2Fauthoring`;
}
