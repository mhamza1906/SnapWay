import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet, NavigationEnd } from '@angular/router';
import { filter, map } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { PrototypeRepository } from './core/prototype.repository';
import { UiService } from './core/ui.service';
import { Icon } from './shared/icon';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon],
  templateUrl: './app.html',
  styleUrls: ['./app.scss', './app-overlays.scss'],
  host: { '(window:keydown.escape)': 'mobileOpen.set(false)' },
})
export class App {
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
  readonly fullScreen = computed(() => /^\/(navigate|welcome)(\/|\?|$)/.test(this.url()));
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
        editor: 'Map editor',
        contributions: 'Contributions',
        review: 'Review queue',
        activity: 'Activity',
        settings: 'Settings',
        help: 'Getting started',
      })[this.url().split('/')[1]] ?? 'Workspace',
  );
  readonly links = [
    { path: '/overview', label: 'Overview', icon: 'grid' },
    { path: '/targets', label: 'Mapping targets', icon: 'map' },
    { path: '/contributions', label: 'Contributions', icon: 'layers' },
    { path: '/review', label: 'Review queue', icon: 'review' },
    { path: '/activity', label: 'Activity', icon: 'activity' },
  ];
  changeRole(event: Event) {
    const role = (event.target as HTMLSelectElement).value;
    this.ui.run(
      () => this.repo.setRole(role === 'admin' ? 'admin' : 'volunteer'),
      'Demo role updated',
    );
  }
}
