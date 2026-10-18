import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { OptimizeReview, WorkspaceApi, workspaceError } from '../../core/workspace-api.service';
import { UiService } from '../../core/ui.service';
import { Icon } from '../../shared/icon';

/**
 * Intermediate Image 2.5 review surface: no graph tools.
 * Regenerate (optional prompt, current SoT as template) and demo vectorize.
 */
@Component({
  selector: 'app-map-optimize',
  imports: [Icon, RouterLink],
  templateUrl: './map-optimize.html',
  styleUrl: './map-optimize.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapOptimizePage implements OnInit {
  private readonly api = inject(WorkspaceApi);
  private readonly ui = inject(UiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly targetId = signal('');
  readonly review = signal<OptimizeReview | null>(null);
  readonly prompt = signal('');
  readonly busy = signal(false);
  readonly error = signal('');

  async ngOnInit() {
    const target = this.route.snapshot.queryParamMap.get('target');
    if (!target) {
      await this.router.navigateByUrl('/authoring');
      return;
    }
    this.targetId.set(target);
    await this.reload();
  }

  async reload() {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ui.runBusy(async () => {
        this.review.set(await this.api.optimizeStatus(this.targetId()));
      }, 'Loading optimized image…');
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.busy.set(false);
    }
  }

  async regenerate() {
    if (this.busy() || !this.targetId()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ui.runBusy(async () => {
        this.review.set(await this.api.optimizeRegenerate(this.targetId(), this.prompt().trim()));
      }, 'Running Image 2.5…');
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.busy.set(false);
    }
  }

  async vectorize() {
    if (this.busy() || !this.targetId()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ui.runBusy(async () => {
        this.review.set(await this.api.vectorizeDemo(this.targetId()));
      }, 'Vectorizing…');
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.busy.set(false);
    }
  }

  previewUrl(): string | null {
    const state = this.review();
    if (!state) return null;
    if (state.stage === 'vectorized_demo' && state.vector_url) return state.vector_url;
    return state.optimized_url || state.source_url;
  }

  value(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }
}
