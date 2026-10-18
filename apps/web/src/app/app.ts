import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet, NavigationEnd } from '@angular/router';
import { filter, map } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { UiService } from './core/ui.service';
import { WorkspaceChrome } from './core/workspace-chrome.service';
import { Icon } from './shared/icon';
import { AuthService } from './core/auth.service';
import { SnapwayBrand } from './shared/snapway-brand';
import { WorkspaceLayout } from './core/workspace-layout.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, SnapwayBrand],
  templateUrl: './app.html',
  styleUrls: ['./app.scss', './app-account.scss', './app-overlays.scss'],
  host: { '(window:keydown.escape)': 'closeMenus()' },
})
export class App implements OnInit {
  readonly layout = inject(WorkspaceLayout);
  readonly auth = inject(AuthService);
  readonly ui = inject(UiService);
  readonly chrome = inject(WorkspaceChrome);
  private readonly router = inject(Router);
  readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => {
        this.closeMenus();
        return event.urlAfterRedirects.split(/[?#]/)[0];
      }),
    ),
    { initialValue: this.router.url.split(/[?#]/)[0] },
  );
  readonly fullScreen = computed(
    () =>
      !this.auth.isDeveloper() ||
      /^\/(auth|navigate|public|welcome|sign-in|map|app-preview)(\/|$)/.test(this.url()),
  );
  readonly mobileOpen = signal(false);
  readonly profileOpen = signal(false);
  readonly avatarFailed = signal(false);
  readonly title = computed(
    () =>
      ({
        explore: 'Explore',
        'my-maps': 'My maps',
        'graph-editor': 'My maps / Edit snapshot',
        authoring: this.auth.canAdmin() ? 'Initialize new map' : 'Request new map',
        'map-optimize': 'Image 2.5 review',
        'developer-contribution': 'Developer contribution',
        settings: 'Settings',
        help: 'Getting started',
        targets: 'My maps',
      })[this.url().split('/')[1]] ?? 'Workspace',
  );
  readonly links = computed(() => [
    { path: '/explore', label: 'Explore', icon: 'compass' },
    { path: '/my-maps', label: 'My maps', icon: 'grid' },
    {
      path: '/authoring',
      label: this.auth.canAdmin() ? 'Initialize new map' : 'Request new map',
      icon: 'sparkles',
    },
    ...(this.auth.canAdmin()
      ? [{ path: '/developer-contribution', label: 'Developer contribution', icon: 'layers' }]
      : []),
  ]);
  ngOnInit() {
    void this.auth.refresh().catch(() => undefined);
  }
  closeMenus() {
    this.mobileOpen.set(false);
    this.layout.navigationEnd();
    this.profileOpen.set(false);
  }
  skipLink() {
    return this.router.url.split('#')[0] + '#main-content';
  }
  async signOut() {
    if (await this.auth.signOut()) await this.router.navigateByUrl('/sign-in');
  }
  async switchToPublic() {
    if (await this.auth.switchMode('public')) await this.router.navigateByUrl('/public');
  }
}
