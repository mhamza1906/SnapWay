import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MapDocument } from '../../core/prototype.models';
import { PrototypeRepository } from '../../core/prototype.repository';
import { validatePublication } from '../../core/prototype.validation';
import { UiService } from '../../core/ui.service';
import { Icon } from '../../shared/icon';
import { MapCanvas } from '../../shared/map-canvas';

const EMPTY_MAP: MapDocument = { rooms: [], nodes: [], edges: [], annotations: [], references: [] };

function compareItems(
  before: { id: string }[],
  after: { id: string }[],
): { added: number; removed: number; modified: number } {
  const original = new Map(before.map((item) => [item.id, item]));
  const next = new Map(after.map((item) => [item.id, item]));
  return {
    added: after.filter((item) => !original.has(item.id)).length,
    removed: before.filter((item) => !next.has(item.id)).length,
    modified: after.filter(
      (item) =>
        original.has(item.id) && JSON.stringify(original.get(item.id)) !== JSON.stringify(item),
    ).length,
  };
}

@Component({
  selector: 'app-review-detail',
  imports: [RouterLink, ReactiveFormsModule, DatePipe, Icon, MapCanvas],
  templateUrl: './review-detail.html',
  styleUrls: ['./review-detail.scss', './review-evidence.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewDetailPage {
  readonly repository = inject(PrototypeRepository);
  readonly ui = inject(UiService);
  private readonly route = inject(ActivatedRoute);
  readonly params = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });
  readonly contribution = computed(() =>
    this.repository.getContribution(this.params().get('id') ?? ''),
  );
  readonly target = computed(() => this.repository.getTarget(this.contribution()?.targetId ?? ''));
  readonly comparisonMode = signal<'latest' | 'base'>('latest');
  readonly basePublication = computed(() =>
    this.target()?.revisions?.find(
      (revision) => revision.version === this.contribution()?.baseRevision,
    ),
  );
  readonly baseAvailable = computed(
    () => this.contribution()?.baseRevision === 0 || !!this.basePublication(),
  );
  readonly comparisonPublication = computed(() =>
    this.comparisonMode() === 'base' ? this.basePublication() : this.target()?.published,
  );
  readonly publishedMap = computed(() => this.comparisonPublication()?.document ?? EMPTY_MAP);
  readonly currentRevision = computed(() => this.target()?.published?.version ?? 0);
  readonly stale = computed(
    () => !!this.contribution() && this.contribution()!.baseRevision !== this.currentRevision(),
  );
  readonly isOwner = computed(() => this.contribution()?.author === this.repository.profile().name);
  readonly editable = computed(
    () =>
      this.isOwner() &&
      this.target()?.status === 'open' &&
      ['draft', 'changes-requested'].includes(this.contribution()?.status ?? ''),
  );
  readonly reviewable = computed(
    () =>
      this.repository.profile().role === 'admin' &&
      this.target()?.status === 'open' &&
      this.contribution()?.status === 'submitted',
  );
  readonly publicationProblem = computed(() => {
    const contribution = this.contribution();
    if (!contribution) return '';
    try {
      validatePublication(contribution.document);
      return '';
    } catch (error) {
      return error instanceof Error
        ? error.message
        : 'This map needs another edit before publication.';
    }
  });
  readonly canPublish = computed(
    () => this.reviewable() && !this.stale() && !this.publicationProblem(),
  );
  readonly feedback = new FormControl('', { nonNullable: true });
  readonly error = signal('');
  readonly acknowledged = signal(false);
  readonly preparedVersion = signal(0);
  readonly preparedRevision = signal(0);
  readonly evidencePreview = signal<{ image: string; title: string } | null>(null);
  readonly differences = computed(() => {
    const before = this.publishedMap();
    const after = this.contribution()?.document ?? EMPTY_MAP;
    return [
      { label: 'Rooms', ...compareItems(before.rooms, after.rooms) },
      { label: 'Waypoints', ...compareItems(before.nodes, after.nodes) },
      { label: 'Route connections', ...compareItems(before.edges, after.edges) },
      { label: 'Labels & pins', ...compareItems(before.annotations, after.annotations) },
      { label: 'Scene references', ...compareItems(before.references, after.references) },
    ];
  });
  readonly renamedRooms = computed(() =>
    (this.contribution()?.document.rooms ?? []).flatMap((room) => {
      const original = this.publishedMap().rooms.find((item) => item.id === room.id);
      return original && original.name !== room.name
        ? [{ id: room.id, before: original.name, after: room.name }]
        : [];
    }),
  );
  readonly imagesChanged = computed(
    () =>
      this.publishedMap().sourceImage !== this.contribution()?.document.sourceImage ||
      this.publishedMap().standardizedImage !== this.contribution()?.document.standardizedImage,
  );

  constructor() {
    effect(() => {
      this.params();
      this.feedback.setValue('');
      this.comparisonMode.set('latest');
      this.acknowledged.set(false);
      this.error.set('');
    });
    effect(() => {
      this.contribution()?.version;
      this.currentRevision();
      this.comparisonMode();
      this.acknowledged.set(false);
    });
  }

  preparePublish(dialog: HTMLDialogElement): void {
    if (!this.canPublish()) return;
    this.error.set('');
    this.preparedVersion.set(this.contribution()!.version);
    this.preparedRevision.set(this.currentRevision());
    dialog.showModal();
  }

  publish(dialog: HTMLDialogElement): void {
    if (
      this.contribution()?.version !== this.preparedVersion() ||
      this.currentRevision() !== this.preparedRevision()
    ) {
      this.error.set(
        'The map changed while this confirmation was open. Compare the updated maps before publishing.',
      );
      dialog.close();
      return;
    }
    this.decide('publish');
    dialog.close();
  }

  decide(decision: 'publish' | 'changes-requested' | 'rejected'): void {
    const contribution = this.contribution();
    if (!contribution) return;
    this.error.set('');
    if (decision !== 'publish' && !this.feedback.value.trim()) {
      this.error.set(
        'Add specific feedback before requesting changes or rejecting this contribution.',
      );
      return;
    }
    try {
      this.repository.review(contribution.id, decision, this.feedback.value);
      this.acknowledged.set(false);
      this.ui.notify(
        decision === 'publish'
          ? `Revision ${this.currentRevision()} published. The visitor map is ready.`
          : decision === 'changes-requested'
            ? 'Changes requested. The contributor can edit this draft again.'
            : 'Contribution rejected. The published map is unchanged.',
      );
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'This review decision could not be saved.',
      );
    }
  }

  reconcile(): void {
    const contribution = this.contribution();
    if (
      !contribution ||
      !this.acknowledged() ||
      !this.editable() ||
      !this.stale() ||
      this.comparisonMode() !== 'latest'
    )
      return;
    try {
      this.repository.rebase(contribution.id);
      this.error.set('');
      this.acknowledged.set(false);
      this.ui.notify(
        'Reconciliation recorded. Your draft is preserved; edit and submit it for a new review.',
      );
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'The reconciliation could not be saved.',
      );
    }
  }

  referenceNode(id: string): string {
    return this.contribution()?.document.nodes.find((node) => node.id === id)?.label ?? id;
  }

  openEvidence(image: string, title: string, dialog: HTMLDialogElement): void {
    this.evidencePreview.set({ image, title });
    dialog.showModal();
  }
}
