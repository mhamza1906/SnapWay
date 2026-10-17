import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { PrototypeRepository } from '../../core/prototype.repository';
import { UiService } from '../../core/ui.service';
import { Icon } from '../../shared/icon';
import { MapCanvas } from '../../shared/map-canvas';
@Component({
  selector: 'app-target-detail',
  imports: [RouterLink, DatePipe, Icon, MapCanvas],
  templateUrl: './target-detail.html',
  styles: [
    `
      .floor-map {
        padding: 20px;
        background: #f5f6f2;
        border-radius: 0 0 10px 10px;
      }
      .floor-map app-map-canvas {
        display: block;
        min-height: 300px;
      }
      .detail-columns {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 300px;
        gap: 24px;
      }
      .brief p {
        font-size: 12px;
        line-height: 1.8;
        color: var(--muted);
      }
      .detail-stats {
        display: flex;
        gap: 28px;
        padding: 20px 0;
      }
      .detail-stats strong {
        display: block;
        font-size: 24px;
        letter-spacing: -1px;
      }
      .detail-stats span {
        font-size: 10px;
        color: var(--muted);
      }
      .contribution-link {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--line);
        padding: 16px 0;
        gap: 10px;
      }
      .contribution-link:last-child {
        border: 0;
      }
      .contribution-link strong {
        font-size: 12px;
      }
      .contribution-link small {
        display: block;
        font-size: 10px;
        color: var(--muted);
        margin-top: 6px;
      }
      .detail-section {
        margin-top: 24px;
      }
      .panel-heading .badge {
        margin-left: auto;
      }
      .back {
        margin-bottom: 20px;
        font-size: 11px;
        display: inline-flex;
        align-items: center;
        gap: 7px;
      }
      .back app-icon {
        width: 14px;
      }
      @media (max-width: 1100px) {
        .detail-columns {
          grid-template-columns: 1fr;
        }
        .floor-map {
          padding: 4px;
        }
      }
    `,
  ],
})
export class TargetDetailPage {
  readonly repo = inject(PrototypeRepository);
  readonly ui = inject(UiService);
  private readonly router = inject(Router);
  readonly params = toSignal(inject(ActivatedRoute).paramMap);
  readonly target = computed(() => this.repo.getTarget(this.params()?.get('id') ?? ''));
  readonly selectedRevision = signal<{ targetId: string; version: number } | null>(null);
  readonly revisions = computed(
    () => this.target()?.revisions ?? (this.target()?.published ? [this.target()!.published!] : []),
  );
  readonly displayedRevision = computed(() => {
    const choice = this.selectedRevision();
    return (
      (choice?.targetId === this.target()?.id
        ? this.revisions().find((r) => r.version === choice?.version)
        : undefined) ?? this.target()?.published
    );
  });
  chooseRevision(version: number) {
    const target = this.target();
    if (target) this.selectedRevision.set({ targetId: target.id, version });
  }
  readonly contributions = computed(() =>
    this.repo.contributions().filter((c) => c.targetId === this.target()?.id),
  );
  start() {
    this.ui.run(() => {
      const t = this.target();
      if (t) void this.router.navigate(['/editor', this.repo.startContribution(t.id).id]);
    });
  }
  archive(dialog: HTMLDialogElement) {
    this.ui.run(() => {
      const t = this.target();
      if (t) this.repo.archiveTarget(t.id, t.status === 'open');
      dialog.close();
    }, 'Target status updated');
  }
}
