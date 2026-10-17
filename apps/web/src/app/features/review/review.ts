import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Contribution } from '../../core/prototype.models';
import { PrototypeRepository } from '../../core/prototype.repository';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'app-review',
  imports: [RouterLink, DatePipe, Icon],
  templateUrl: './review.html',
  styleUrl: './review.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewPage {
  readonly repository = inject(PrototypeRepository);
  readonly query = signal('');
  readonly selectedTarget = signal('');
  readonly pending = computed(() =>
    this.repository.contributions().filter((item) => item.status === 'submitted'),
  );
  readonly staleCount = computed(() => this.pending().filter((item) => this.stale(item)).length);
  readonly reviewedCount = computed(
    () =>
      this.repository
        .contributions()
        .filter((item) => ['merged', 'rejected', 'changes-requested'].includes(item.status)).length,
  );
  readonly filtered = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.pending().filter(
      (item) =>
        (!this.selectedTarget() || item.targetId === this.selectedTarget()) &&
        (!query ||
          `${item.title} ${item.author} ${this.targetName(item.targetId)}`
            .toLowerCase()
            .includes(query)),
    );
  });
  targetName(id: string): string {
    return this.repository.getTarget(id)?.name ?? 'Unknown target';
  }
  stale(contribution: Contribution): boolean {
    return (
      contribution.baseRevision !==
      (this.repository.getTarget(contribution.targetId)?.published?.version ?? 0)
    );
  }
  archived(contribution: Contribution): boolean {
    return this.repository.getTarget(contribution.targetId)?.status === 'archived';
  }
}
