import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { PrototypeRepository } from '../../core/prototype.repository';
import { Icon } from '../../shared/icon';
@Component({
  selector: 'app-contributions',
  imports: [RouterLink, DatePipe, Icon],
  template: `
    <div class="page">
      <div class="page-heading">
        <div>
          <span class="subtle-label">YOUR LOCAL KNOWLEDGE, SHARED</span>
          <h1>Contributions</h1>
          <p>Follow every map improvement from first draft to published revision.</p>
        </div>
        <a class="btn primary" routerLink="/targets"
          ><app-icon name="plus" />Start a contribution</a
        >
      </div>
      <div class="filters">
        <label class="search-input"
          ><app-icon name="search" /><input
            placeholder="Search your contributions…"
            aria-label="Search contributions"
            (input)="query.set($any($event.target).value)"
            [value]="query()"
        /></label>
        <div class="tabs">
          @for (tab of tabs; track tab.value) {
            <button [class.active]="status() === tab.value" (click)="status.set(tab.value)">
              {{ tab.label }}<span class="count">{{ count(tab.value) }}</span>
            </button>
          }
        </div>
      </div>
      <section class="panel">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>CONTRIBUTION</th>
                <th>PLACE</th>
                <th>STATUS</th>
                <th>BASE</th>
                <th>UPDATED</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (item of filtered(); track item.id) {
                <tr>
                  <td>
                    <a
                      class="table-link"
                      [routerLink]="[item.status === 'submitted' ? '/review' : '/editor', item.id]"
                      >{{ item.title }}</a
                    ><small>{{ item.author }}</small>
                    @if (item.feedback) {
                      <small class="feedback">Feedback: {{ item.feedback }}</small>
                    }
                  </td>
                  <td>
                    {{ repo.getTarget(item.targetId)?.name
                    }}<small>{{ repo.getTarget(item.targetId)?.floor }}</small>
                  </td>
                  <td>
                    <span [class]="'badge ' + item.status">{{
                      item.status.replace('-', ' ')
                    }}</span>
                  </td>
                  <td>
                    v{{ item.baseRevision }}
                    @if (
                      item.baseRevision !==
                        (repo.getTarget(item.targetId)?.published?.version ?? 0) &&
                      item.status !== 'merged' &&
                      item.status !== 'rejected'
                    ) {
                      <small class="text-danger">New revision available</small>
                    }
                  </td>
                  <td>{{ item.updatedAt | date: 'MMM d, h:mm a' }}</td>
                  <td>
                    <a
                      class="btn ghost icon-only"
                      [routerLink]="[item.status === 'submitted' ? '/review' : '/editor', item.id]"
                      aria-label="Open contribution"
                      ><app-icon name="arrow-right"
                    /></a>
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="6">
                    <div class="empty">
                      <app-icon name="layers" />
                      <h3>No contributions here yet.</h3>
                      <p>Try another filter or pick a mapping target to get started.</p>
                      <a routerLink="/targets" class="btn secondary">Explore targets</a>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
      <p class="hint">
        A draft belongs to its author. Submitted contributions are locked until an administrator
        requests changes.
      </p>
    </div>
  `,
  styles: [
    `
      .tabs {
        gap: 3px;
      }
      .tabs button {
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .count {
        font-size: 9px;
        padding: 2px 5px;
      }
      .feedback {
        max-width: 280px;
        white-space: normal;
        line-height: 1.5;
        color: #a96d3f;
      }
      .hint {
        font-size: 11px;
        color: var(--muted);
        margin-top: 20px;
      }
      .filters {
        flex-wrap: wrap;
      }
      td {
        font-size: 11px;
      }
    `,
  ],
})
export class ContributionsPage {
  readonly repo = inject(PrototypeRepository);
  readonly query = signal('');
  readonly status = signal('all');
  readonly tabs = [
    { value: 'all', label: 'All' },
    { value: 'draft', label: 'Drafts' },
    { value: 'submitted', label: 'In review' },
    { value: 'changes-requested', label: 'Needs changes' },
    { value: 'merged', label: 'Published' },
    { value: 'rejected', label: 'Closed' },
  ];
  readonly own = computed(() =>
    this.repo.contributions().filter((c) => c.author === this.repo.profile().name),
  );
  readonly filtered = computed(() =>
    this.own().filter(
      (c) =>
        (this.status() === 'all' || c.status === this.status()) &&
        (c.title + ' ' + this.repo.getTarget(c.targetId)?.name)
          .toLowerCase()
          .includes(this.query().toLowerCase()),
    ),
  );
  count(status: string) {
    return this.own().filter((c) => status === 'all' || c.status === status).length;
  }
}
