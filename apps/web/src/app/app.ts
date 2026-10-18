import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet, NavigationEnd } from '@angular/router';
import { filter, map } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { PrototypeRepository } from './core/prototype.repository';
import { UiService } from './core/ui.service';
import { Icon } from './shared/icon';
import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon],
  templateUrl: './app.html',
  styleUrls: ['./app.scss', './app-overlays.scss'],
  host: { '(window:keydown.escape)': 'mobileOpen.set(false)' },
})
export class App implements OnInit {
  readonly auth = inject(AuthService);
  readonly repo = inject(PrototypeRepository);
  readonly ui = inject(UiService);
  private readonly router = inject(Router);
  readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects.split(/[?#]/)[0]),
    ),
    { initialValue: this.router.url.split(/[?#]/)[0] },
  );
  readonly fullScreen = computed(() =>
    /^\/(map|auth|navigate|public|welcome|sign-in|capture|graph-editor|app-preview)(\/|\?|$)/.test(
      this.url(),
    ),
  );
  readonly mobileOpen = signal(false);
  readonly query = signal('');
  readonly searchResults = computed(() =>
    this.repo
      .targets()
      .filter((t) =>
        (t.name + ' ' + t.building + ' ' + t.floor)
          .toLowerCase()
          .includes(this.query().toLowerCase()),
      ),
  );
  readonly pending = computed(
    () => this.repo.contributions().filter((c) => c.status === 'submitted').length,
  );
  readonly title = computed(
    () =>
      ({
        overview: 'Overview',
        targets: 'Mapping targets',
        'graph-editor': 'Graph editor',
        editor: 'Map editor',
        contributions: 'Contributions',
        authoring: 'Map authoring',
        review: 'Review queue',
        activity: 'Activity',
        settings: 'Settings',
        help: 'Getting started',
      })[this.url().split('/')[1]] ?? 'Workspace',
  );
  readonly links = [
    { path: '/map', label: 'Explore buildings', icon: 'compass' },
    { path: '/overview', label: 'Overview', icon: 'grid' },
    { path: '/targets', label: 'Mapping targets', icon: 'map' },
    { path: '/graph-editor', label: 'Graph editor', icon: 'edit' },
    { path: '/contributions', label: 'Contributions', icon: 'layers' },
    { path: '/authoring', label: 'Map authoring (AI)', icon: 'map' },
    { path: '/capture', label: 'Photo capture', icon: 'camera' },
    { path: '/review', label: 'Review queue', icon: 'review' },
    { path: '/activity', label: 'Activity', icon: 'activity' },
  ];
  ngOnInit() {
    void this.auth.refresh().catch(() => undefined);
  }

  async switchToPublic() {
    if (await this.auth.switchMode('public')) await this.router.navigateByUrl('/public');
  }

  skipLink() {
    return this.router.url.split('#')[0] + '#main-content';
  }

  async signOut() {
    if (await this.auth.signOut()) await this.router.navigateByUrl('/sign-in');
  }
}
