import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-auth-complete',
  imports: [RouterLink],
  template: `<main class="page">
    <h1>{{ error() ? 'Sign-in did not finish' : 'Finishing sign-in…' }}</h1>
    <p role="status">{{ error() || 'Checking your secure session.' }}</p>
    @if (error()) {
      <a class="btn primary" routerLink="/sign-in">Try signing in again</a>
    }
    <a class="btn secondary" routerLink="/map">Explore buildings</a>
  </main>`,
})
export class AuthCompletePage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly error = signal('');
  constructor() {
    void this.complete();
  }
  private async complete() {
    try {
      if (!(await this.auth.refresh()).authenticated) {
        this.error.set('No signed-in session was found. Please try again.');
        return;
      }
      await this.router.navigateByUrl('/welcome', { replaceUrl: true });
    } catch {
      this.error.set(this.auth.error());
    }
  }
}
