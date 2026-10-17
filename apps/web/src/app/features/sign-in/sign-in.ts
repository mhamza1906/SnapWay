import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService, ExperienceMode } from '../../core/auth.service';
import { ClientConfigService } from '../../core/client-config.service';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'app-sign-in',
  imports: [RouterLink, Icon],
  templateUrl: './sign-in.html',
  styleUrls: ['./sign-in.scss', './sign-in-motion.scss'],
  host: { '(window:pageshow)': 'resume($event)' },
})
export class SignInPage {
  readonly auth = inject(AuthService);
  private readonly config = inject(ClientConfigService);
  readonly loading = signal(true);
  readonly enabled = signal(false);
  readonly error = signal('');
  readonly selected = signal<ExperienceMode | null>(null);

  constructor() {
    void this.load();
  }

  resume(event: PageTransitionEvent) {
    if (event.persisted) {
      this.auth.busy.set(false);
      this.selected.set(null);
    }
  }

  async load() {
    this.loading.set(true);
    this.error.set('');
    try {
      this.enabled.set((await this.config.load()).auth.google_enabled);
    } catch {
      this.error.set('We could not connect. Please try again.');
    } finally {
      this.loading.set(false);
    }
  }

  async choose(mode: ExperienceMode) {
    if (this.auth.busy() || this.loading() || !this.enabled()) return;
    this.selected.set(mode);
    await this.auth.signIn(mode);
    if (!this.auth.busy()) this.selected.set(null);
  }
}
