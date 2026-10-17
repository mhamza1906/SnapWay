import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `<div class="page">
    <div class="empty panel">
      <span class="subtle-label">404 · A SMALL DETOUR</span>
      <h1>This place isn’t on our map.</h1>
      <p>The link may have changed. Let’s get you back to familiar ground.</p>
      <a routerLink="/overview" class="btn primary">Back to your workspace</a>
    </div>
  </div>`,
})
export class NotFoundPage {}
