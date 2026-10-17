import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiStatus } from '../../core/api-status';

@Component({
  selector: 'app-workspace',
  template: `
    <p class="eyebrow">STAGE 1 / MAP PLATFORM</p>
    <h1>A shared foundation<br />for finding your way.</h1>
    <p class="intro">
      SnapWay brings map contributors and reviewers together to build dependable indoor maps. The
      workspace is being prepared; map editing and publication are coming next.
    </p>
    <section class="connection" aria-labelledby="connection-title">
      <div>
        <p class="eyebrow">DEVELOPMENT CHECK</p>
        <h2 id="connection-title">Connect to the API</h2>
        <p aria-live="polite" role="status">{{ message() }}</p>
      </div>
      <button type="button" (click)="checkConnection()" [disabled]="checking()">
        {{ checking() ? 'Checking…' : 'Check connection' }}
      </button>
    </section>
    <div class="principles">
      <article>
        <span>01</span>
        <h2>Contribute</h2>
        <p>Build editable maps from source plans.</p>
      </article>
      <article>
        <span>02</span>
        <h2>Review</h2>
        <p>Validate changes before publication.</p>
      </article>
      <article>
        <span>03</span>
        <h2>Navigate</h2>
        <p>A later visitor app will use reviewed maps.</p>
      </article>
    </div>
  `,
})
export class Workspace {
  private readonly api = inject(ApiStatus);
  private readonly destroyRef = inject(DestroyRef);
  readonly checking = signal(false);
  readonly message = signal('Start the local API, then check its connection.');

  checkConnection() {
    if (this.checking()) return;
    this.checking.set(true);
    this.message.set('Contacting the API…');
    this.api
      .check()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (health) => {
          this.checking.set(false);
          this.message.set(`Connected to ${health.service} (${health.release}).`);
        },
        error: () => {
          this.checking.set(false);
          this.message.set('The API is unavailable. Check that it is running, then try again.');
        },
      });
  }
}
