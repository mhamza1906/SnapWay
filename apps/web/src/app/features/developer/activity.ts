import { DatePipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { WorkspaceApi, workspaceError } from '../../core/workspace-api.service';
@Component({
  selector: 'app-developer-activity',
  imports: [DatePipe, RouterLink],
  styleUrls: ['./workspace.scss', './exports.scss'],
  template: `<section class="page live-page">
    <header class="page-heading">
      <div>
        <p class="eyebrow">DEVELOPER CONTRIBUTION</p>
        <h1>Activity</h1>
        <p>Server-recorded submissions, publication decisions and map archival.</p>
      </div>
      <a class="btn secondary" routerLink="/developer-contribution">Back to contributions</a>
    </header>
    @if (error()) {
      <p class="error-state" role="alert">{{ error() }}</p>
    }
    <ol class="activity-list">
      @for (event of events(); track event.id) {
        <li>
          <div>
            <strong
              >{{ event.action.replace('map.', '').replace('_', ' ') }} · {{ event.target }}</strong
            ><small>{{ event.actor }}</small>
          </div>
          <time>{{ event.at | date: 'medium' }}</time>
        </li>
      } @empty {
        <p class="empty-state">
          {{ loading() ? 'Loading activity…' : 'No activity recorded yet.' }}
        </p>
      }
    </ol>
  </section>`,
})
export class DeveloperActivityPage implements OnInit {
  private readonly api = inject(WorkspaceApi);
  readonly events = signal<
    { id: string; action: string; target: string; actor: string; at: string }[]
  >([]);
  readonly error = signal('');
  readonly loading = signal(true);
  async ngOnInit() {
    try {
      this.events.set((await this.api.activity()).events);
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.loading.set(false);
    }
  }
}
