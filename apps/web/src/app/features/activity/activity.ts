import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PrototypeRepository } from '../../core/prototype.repository';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'app-activity',
  imports: [RouterLink, DatePipe, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page activity-page">
      <header class="page-heading">
        <div>
          <p class="eyebrow">WORKSPACE HISTORY</p>
          <h1>Activity</h1>
          <p>The latest changes across your mapping workspace.</p>
        </div>
        <span class="badge">LAST 20 EVENTS</span>
      </header>
      <div class="filters">
        <label class="search-input"
          ><app-icon name="search" /><span class="sr-only">Search activity</span
          ><input
            type="search"
            placeholder="Search activity…"
            [value]="query()"
            (input)="query.set($any($event.target).value)" /></label
        ><label class="target-filter"
          ><span>Target</span
          ><select
            class="input"
            [value]="target()"
            (change)="target.set($any($event.target).value)"
          >
            <option value="">All targets</option>
            <option value="workspace">Workspace events</option>
            @for (item of repository.targets(); track item.id) {
              <option [value]="item.id">{{ item.name }}</option>
            }
          </select></label
        >
      </div>
      <section class="panel" aria-labelledby="activity-list-title">
        <div class="panel-heading">
          <h2 id="activity-list-title">
            Recent updates <span class="count">{{ filtered().length }}</span>
          </h2>
          <span class="subtle-label">Saved in this browser</span>
        </div>
        <div class="panel-body">
          <ul class="timeline">
            @for (item of filtered(); track item.id) {
              <li>
                <span class="dot"
                  ><app-icon
                    [name]="item.title.toLowerCase().includes('publish') ? 'check' : 'activity'"
                /></span>
                <div class="event-content">
                  <strong>{{ item.title }}</strong>
                  <p>{{ item.detail }}</p>
                  <time [attr.datetime]="item.at">{{ item.at | date: 'MMM d, y · h:mm a' }}</time>
                </div>
                @if (item.targetId) {
                  <a
                    class="target-link"
                    [routerLink]="['/targets', item.targetId]"
                    [attr.aria-label]="'Open ' + targetName(item.targetId)"
                    >{{ targetName(item.targetId) }}<app-icon name="arrow-right"
                  /></a>
                }
              </li>
            } @empty {
              <li class="empty-event">
                <app-icon name="activity" />
                <div>
                  <h3>No matching activity</h3>
                  <p>Try another target or clear your search. Changes you save will appear here.</p>
                  <button
                    type="button"
                    class="btn secondary small"
                    (click)="query.set(''); target.set('')"
                  >
                    Clear filters
                  </button>
                </div>
              </li>
            }
          </ul>
        </div>
      </section>
      <p class="history-note">
        This prototype keeps the 20 most recent events. Export your workspace in
        <a routerLink="/settings" class="link">Settings</a> to keep a snapshot for your team.
      </p>
    </main>
  `,
  styles: `
    .activity-page {
      max-width: 1160px;
    }
    .target-filter {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .target-filter select {
      width: 215px;
      font-size: 12px;
      min-height: 39px;
    }
    .event-content {
      flex: 1;
      min-width: 0;
    }
    .event-content p {
      overflow-wrap: anywhere;
    }
    .timeline li {
      padding: 21px 0;
      align-items: flex-start;
    }
    .timeline li:first-child {
      padding-top: 5px;
    }
    .timeline strong {
      font-size: 13px;
    }
    .timeline p {
      font-size: 12px;
      margin: 6px 0 8px;
    }
    .timeline time {
      font-size: 11px;
    }
    .target-link {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      font-size: 11px;
      color: var(--muted);
      margin-top: 3px;
    }
    .target-link:hover {
      color: var(--accent);
    }
    .target-link app-icon {
      width: 13px;
      height: 13px;
    }
    .history-note {
      font-size: 11px;
      color: var(--muted);
      margin: 20px 0;
    }
    .empty-event {
      justify-content: center;
      padding: 38px 10px !important;
    }
    .empty-event > app-icon {
      color: var(--muted);
    }
    .empty-event h3 {
      font-size: 14px;
      margin: 0;
    }
    .empty-event p {
      margin-bottom: 16px;
    }
    @media (max-width: 700px) {
      .target-filter,
      .target-filter select {
        width: 100%;
      }
      .timeline li {
        flex-wrap: wrap;
      }
      .target-link {
        margin-left: 44px;
      }
      .event-content {
        flex-basis: calc(100% - 44px);
      }
      .panel-heading {
        flex-wrap: wrap;
      }
    }
  `,
})
export class ActivityPage {
  readonly repository = inject(PrototypeRepository);
  readonly target = signal('');
  readonly query = signal('');
  readonly filtered = computed(() =>
    this.repository.activity().filter((item) => {
      const matchesTarget =
        !this.target() ||
        (this.target() === 'workspace' ? !item.targetId : item.targetId === this.target());
      const search = this.query().trim().toLowerCase();
      return (
        matchesTarget &&
        (!search ||
          `${item.title} ${item.detail} ${item.targetId ? this.targetName(item.targetId) : ''}`
            .toLowerCase()
            .includes(search))
      );
    }),
  );
  targetName(id: string): string {
    return this.repository.getTarget(id)?.name ?? 'Mapping target';
  }
}
