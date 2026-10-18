import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { WorkspaceApi, MapCard, workspaceError } from '../../core/workspace-api.service';
import { AuthService } from '../../core/auth.service';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'app-my-maps',
  imports: [DatePipe, RouterLink, Icon],
  template: `<section class="page live-page">
    <header class="page-heading">
      <div>
        <p class="eyebrow">YOUR PLACES, TAKING SHAPE</p>
        <h1>
          My maps<span class="count">{{ maps().length }}</span>
        </h1>
        <p>Pick up where you left off. Every edit starts from your own snapshot.</p>
      </div>
      <a class="btn primary" routerLink="/authoring"
        ><app-icon name="plus" />{{ auth.canAdmin() ? 'Initialize new map' : 'Request new map' }}</a
      >
    </header>
    <div class="filter-bar">
      <label class="search-field"
        ><app-icon name="search" /><input
          type="search"
          aria-label="Find a map"
          placeholder="Find a building or floor"
          [value]="query()"
          (input)="query.set($any($event.target).value)" /></label
      ><span>Last edited, newest first</span
      ><button class="btn ghost" (click)="load()">Refresh</button>
    </div>
    @if (error()) {
      <div class="error-state" role="alert">
        {{ error() }} <button class="btn" (click)="load()">Retry</button>
      </div>
    }
    @if (loading()) {
      <p class="empty-state" role="status">Loading your maps…</p>
    } @else {
      <section class="map-grid" aria-label="Your maps">
        @for (map of filtered(); track map.id) {
          <article class="map-card">
            <a
              class="map-preview"
              [routerLink]="map.status === 'archived' ? '/my-maps' : '/graph-editor'"
              [queryParams]="{ target: map.target_id }"
            >
              @if (map.preview_url) {
                <img [src]="map.preview_url" alt="Floor plan preview" />
              } @else {
                <app-icon name="map" />
              }
              <span
                class="status"
                [class.published]="map.status === 'merged' || map.status === 'published'"
                >{{ label(map.status) }}</span
              >
            </a>
            <div class="map-card-body">
              <p class="eyebrow">{{ map.building }}</p>
              <h2>{{ map.floor }}</h2>
              <p class="map-meta">Edited {{ map.updated_at | date: 'medium' }}</p>
              <div class="card-actions">
                @if (map.status !== 'archived') {
                  <a
                    class="btn secondary"
                    routerLink="/graph-editor"
                    [queryParams]="{ target: map.target_id }"
                    ><app-icon name="edit" />{{
                      map.status === 'draft' ? 'Continue editing' : 'Start new edit'
                    }}</a
                  >
                }
                <a
                  class="export-link"
                  [href]="api.exportUrl(map.target_id, 'json')"
                  aria-label="Export map JSON"
                  ><app-icon name="download"
                /></a>
              </div>
            </div>
          </article>
        } @empty {
          <div class="empty-state">
            <app-icon name="map" />
            <h2>{{ query() ? 'No matching maps' : 'Make room for your first map.' }}</h2>
            <p>Explore a building or request a new floor to start mapping.</p>
            <a routerLink="/explore" class="btn secondary"
              >Explore buildings <app-icon name="arrow-right"
            /></a>
          </div>
        }
      </section>
    }
  </section>`,
  styleUrl: './workspace.scss',
})
export class MyMapsPage implements OnInit {
  readonly api = inject(WorkspaceApi);
  readonly auth = inject(AuthService);
  readonly maps = signal<MapCard[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly query = signal('');
  readonly filtered = computed(() =>
    this.maps().filter((m) =>
      `${m.building} ${m.floor}`.toLowerCase().includes(this.query().toLowerCase()),
    ),
  );
  ngOnInit() {
    void this.load();
  }
  async load() {
    this.loading.set(true);
    this.error.set('');
    try {
      this.maps.set((await this.api.maps()).maps);
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.loading.set(false);
    }
  }
  label(status: string) {
    return (
      {
        merged: 'Published',
        submitted: 'Awaiting review',
        changes_requested: 'Changes requested',
        draft: 'Editing snapshot',
      }[status] || status
    );
  }
}
