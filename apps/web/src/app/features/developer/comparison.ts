import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  Comparison,
  MapRevision,
  WorkspaceApi,
  workspaceError,
} from '../../core/workspace-api.service';
import { Icon } from '../../shared/icon';
import { RevisionPreview } from './revision-preview';
@Component({
  selector: 'app-map-comparison',
  imports: [RouterLink, Icon, RevisionPreview],
  styleUrls: ['./workspace.scss', './comparison.scss'],
  template: `<section class="comparison-page">
    <header class="comparison-header">
      <div>
        <a class="back-link" routerLink="/developer-contribution"
          ><app-icon name="arrow-left" />Developer contribution</a
        >
        <h1>{{ data()?.contribution?.title || 'Compare map versions' }}</h1>
        <p>
          {{ data()?.contribution?.author }} · {{ data()?.contribution?.status?.replace('_', ' ') }}
        </p>
      </div>
      <div class="zoom-controls">
        <button class="btn" aria-label="Zoom out" (click)="zoomBy(-0.2)">
          <app-icon name="zoom-out" /></button
        ><button class="btn" (click)="reset()">{{ percent() }}%</button
        ><button class="btn" aria-label="Zoom in" (click)="zoomBy(0.2)">
          <app-icon name="zoom-in" />
        </button>
      </div>
    </header>
    @if (error()) {
      <div class="error-state" role="alert">{{ error() }}</div>
    }
    @if (data(); as result) {
      <div class="comparison-toolbar">
        <span>Pan or zoom either view. Both stay aligned.</span
        ><button class="btn ghost" [disabled]="busy()" (click)="load()">
          Refresh latest version</button
        ><label
          >Viewing
          <select
            aria-label="Version to compare"
            [value]="selectedVersion()"
            (change)="selectVersion($any($event.target).value)"
          >
            <option value="">This submission</option>
            @for (version of result.history; track version.revision_id) {
              <option [value]="version.revision_id">
                Published version {{ version.sequence }}
              </option>
            }
          </select></label
        >
      </div>
      <section class="comparison-grid" aria-label="Version comparison">
        @for (side of sides(); track side.label) {
          <article>
            <header>
              <span>{{ side.label }}</span
              ><small>{{
                side.revision
                  ? side.revision.nodes.length +
                    ' waypoints · ' +
                    side.revision.edges.length +
                    ' connections'
                  : 'No published version yet'
              }}</small>
            </header>
            <div
              class="comparison-canvas"
              (wheel)="wheel($event)"
              (pointerdown)="panStart($event)"
              (pointermove)="panMove($event)"
              (pointerup)="panEnd($event)"
              (pointercancel)="panEnd($event)"
            >
              @if (side.revision; as revision) {
                <div
                  class="image-transform"
                  [style.transform]="
                    'translate(' + panX() + 'px,' + panY() + 'px) scale(' + scale() + ')'
                  "
                >
                  <app-revision-preview [revision]="revision" />
                </div>
              } @else {
                <p class="empty-state">A first edition for this floor.</p>
              }
            </div>
          </article>
        }
      </section>
      <footer class="review-actions">
        <p>
          Approving replaces the current published version, including when this snapshot started
          from an older version.
        </p>
        <div class="review-buttons">
          @if (result.contribution.status === 'submitted' && !selectedVersion()) {
            <textarea
              aria-label="Review feedback"
              placeholder="Feedback (required for requested changes or rejection)"
              [value]="feedback()"
              (input)="feedback.set($any($event.target).value)"
            ></textarea
            ><button
              class="btn secondary"
              [disabled]="busy() || !feedback().trim()"
              (click)="decide('changes_requested')"
            >
              Request changes</button
            ><button
              class="btn danger"
              [disabled]="busy() || !feedback().trim()"
              (click)="decide('rejected')"
            >
              Reject</button
            ><button class="btn primary" [disabled]="busy()" (click)="decide('approved')">
              <app-icon name="check" />Approve & publish
            </button>
          }
          @if (confirmArchive()) {
            <span>Archive and destroy all pending edits and submissions?</span
            ><button class="btn danger" [disabled]="busy()" (click)="archive()">
              Confirm archive</button
            ><button class="btn ghost" (click)="confirmArchive.set(false)">Cancel</button>
          } @else {
            <button class="btn ghost" [disabled]="busy()" (click)="confirmArchive.set(true)">
              <app-icon name="archive" />Archive map
            </button>
          }
        </div>
      </footer>
    } @else if (loading()) {
      <p class="empty-state" role="status">Loading map versions…</p>
    }
  </section>`,
})
export class MapComparisonPage implements OnInit {
  private readonly api = inject(WorkspaceApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly data = signal<Comparison | null>(null);
  readonly error = signal('');
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly feedback = signal('');
  readonly selectedVersion = signal('');
  readonly confirmArchive = signal(false);
  readonly scale = signal(1);
  readonly panX = signal(0);
  readonly panY = signal(0);
  private pointer?: { id: number; x: number; y: number };
  readonly percent = computed(() => Math.round(this.scale() * 100));
  readonly sides = computed(() => [
    { label: 'Latest published version', revision: this.data()?.latest ?? null },
    {
      label: this.selectedVersion() ? 'Selected published version' : 'Submitted version',
      revision: this.data()?.selected ?? null,
    },
  ]);
  ngOnInit() {
    void this.load();
  }
  async load() {
    this.loading.set(true);
    this.error.set('');
    try {
      this.data.set(
        await this.api.comparison(this.route.snapshot.paramMap.get('id')!, this.selectedVersion()),
      );
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.loading.set(false);
    }
  }
  async selectVersion(value: string) {
    this.selectedVersion.set(value);
    await this.load();
    this.reset();
  }
  async decide(decision: string) {
    this.busy.set(true);
    try {
      await this.api.review(this.data()!.contribution.contribution_id!, decision, this.feedback());
      await this.load();
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.busy.set(false);
    }
  }
  async archive() {
    this.busy.set(true);
    try {
      await this.api.archive(this.data()!.contribution.target_id);
      await this.router.navigateByUrl('/developer-contribution');
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.busy.set(false);
    }
  }
  reset() {
    this.scale.set(1);
    this.panX.set(0);
    this.panY.set(0);
  }
  zoomBy(value: number) {
    this.scale.update((s) => Math.max(0.5, Math.min(5, Math.round((s + value) * 100) / 100)));
  }
  wheel(event: WheelEvent) {
    event.preventDefault();
    this.zoomBy(event.deltaY > 0 ? -0.1 : 0.1);
  }
  panStart(event: PointerEvent) {
    if (event.button !== 0) return;
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  panMove(event: PointerEvent) {
    if (!this.pointer || event.pointerId !== this.pointer.id) return;
    this.panX.update((x) => x + event.clientX - this.pointer!.x);
    this.panY.update((y) => y + event.clientY - this.pointer!.y);
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
  }
  panEnd(event: PointerEvent) {
    if (this.pointer?.id === event.pointerId) this.pointer = undefined;
  }
}
