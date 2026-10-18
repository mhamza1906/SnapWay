import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { WorkspaceApi, MapCard, workspaceError } from '../../core/workspace-api.service';
import { Icon } from '../../shared/icon';
@Component({
  selector: 'app-developer-contributions',
  imports: [DatePipe, RouterLink, Icon],
  styleUrl: './workspace.scss',
  template: `<section class="page live-page">
    <header class="page-heading page-heading-compact">
      <p>Review new floors and map updates, or manage archived places.</p>
      <a class="btn secondary" routerLink="/developer-contribution/activity"
        ><app-icon name="activity" />Activity</a
      >
    </header>
    <nav class="tabs" aria-label="Contribution filters">
      @for (tab of tabs; track tab.value) {
        <button [class.active]="filter() === tab.value" (click)="filter.set(tab.value)">
          {{ tab.label }} <span>({{ count(tab.value) }})</span>
        </button>
      }
      <button (click)="load()">Refresh</button>
    </nav>
    @if (error()) {
      <div class="error-state" role="alert">{{ error() }}</div>
    }
    @if (loading()) {
      <p role="status">Loading contributions…</p>
    } @else {
      <section class="map-grid" aria-label="Developer contributions">
        @for (map of filtered(); track map.id) {
          <article class="map-card">
            @if (map.status === 'archived') {
              <div class="map-preview">
                @if (map.preview_url) {
                  <img [src]="map.preview_url" alt="Archived map" />
                } @else {
                  <app-icon name="archive" />
                }
                <span class="status">Archived</span>
              </div>
            } @else {
              <a
                class="map-preview"
                [routerLink]="['/developer-contribution', map.contribution_id]"
              >
                @if (map.preview_url) {
                  <img [src]="map.preview_url" alt="Submitted floor plan" />
                } @else {
                  <app-icon name="map" />
                }
                <span class="status" [class.published]="map.status === 'merged'">{{
                  map.status === 'merged' ? 'Published' : map.status.replace('_', ' ')
                }}</span></a
              >
            }
            <div class="map-card-body">
              <p class="eyebrow">
                {{ map.building }} · {{ map.kind === 'update' ? 'MAP UPDATE' : 'NEW FLOOR' }}
              </p>
              <h2>{{ map.floor }}</h2>
              <p class="map-meta">
                {{ map.author || 'Archived map' }} · {{ map.updated_at | date: 'medium' }}
              </p>
              @if (map.status !== 'archived') {
                <a
                  class="btn secondary"
                  [routerLink]="['/developer-contribution', map.contribution_id]"
                  >Compare versions <app-icon name="arrow-right"
                /></a>
              } @else {
                @if (confirmDelete() === map.target_id) {
                  <p class="map-meta">Permanently delete this map and all its stored versions?</p>
                  <div class="card-actions">
                    <button class="btn danger" [disabled]="busy()" (click)="remove(map)">
                      Delete permanently</button
                    ><button class="btn ghost" (click)="confirmDelete.set('')">Cancel</button>
                  </div>
                } @else {
                  <button class="btn danger" (click)="confirmDelete.set(map.target_id)">
                    <app-icon name="trash" />Delete archived map
                  </button>
                }
              }
            </div>
          </article>
        } @empty {
          <div class="empty-state">
            <app-icon name="review" />
            <h2>All clear here.</h2>
            <p>No contributions in this view.</p>
          </div>
        }
      </section>
    }
  </section>`,
})
export class DeveloperContributionsPage implements OnInit {
  readonly api = inject(WorkspaceApi);
  readonly rows = signal<MapCard[]>([]);
  readonly filter = signal('submitted');
  readonly loading = signal(true);
  readonly error = signal('');
  readonly confirmDelete = signal('');
  readonly busy = signal(false);
  readonly tabs = [
    { value: 'submitted', label: 'Awaiting review' },
    { value: 'history', label: 'Reviewed' },
    { value: 'archived', label: 'Archived' },
  ];
  readonly filtered = computed(() => this.rows().filter((m) => this.matches(m, this.filter())));
  matches(m: MapCard, f: string) {
    return f === 'history'
      ? ['merged', 'rejected', 'changes_requested'].includes(m.status)
      : m.status === f;
  }
  count(f: string) {
    return this.rows().filter((m) => this.matches(m, f)).length;
  }
  ngOnInit() {
    void this.load();
  }
  async load() {
    this.loading.set(true);
    this.error.set('');
    try {
      this.rows.set((await this.api.contributions()).contributions);
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.loading.set(false);
    }
  }
  async remove(map: MapCard) {
    this.busy.set(true);
    try {
      await this.api.delete(map.target_id);
      this.confirmDelete.set('');
      await this.load();
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.busy.set(false);
    }
  }
}
