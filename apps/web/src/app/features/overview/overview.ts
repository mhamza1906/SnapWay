import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { PrototypeRepository } from '../../core/prototype.repository';
import { Icon } from '../../shared/icon';
import { MapCanvas } from '../../shared/map-canvas';
@Component({
  selector: 'app-overview',
  imports: [RouterLink, DatePipe, Icon, MapCanvas],
  templateUrl: './overview.html',
  styleUrls: ['./overview.scss', './overview-activity.scss'],
})
export class OverviewPage {
  readonly repo = inject(PrototypeRepository);
  readonly published = computed(() => this.repo.targets().filter((t) => t.published));
  readonly openTargets = computed(() => this.repo.targets().filter((t) => t.status === 'open'));
  readonly drafts = computed(() =>
    this.repo
      .contributions()
      .filter(
        (c) =>
          c.author === this.repo.profile().name &&
          this.repo.getTarget(c.targetId)?.status === 'open' &&
          (c.status === 'draft' || c.status === 'changes-requested'),
      ),
  );
  readonly review = computed(() =>
    this.repo.contributions().filter((c) => c.status === 'submitted'),
  );
  readonly rooms = computed(() =>
    this.published().reduce((n, t) => n + (t.published?.document.rooms.length ?? 0), 0),
  );
}
