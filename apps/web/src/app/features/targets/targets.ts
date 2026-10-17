import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { PrototypeRepository } from '../../core/prototype.repository';
import { UiService } from '../../core/ui.service';
import { MapCanvas } from '../../shared/map-canvas';
import { Icon } from '../../shared/icon';
@Component({
  selector: 'app-targets',
  imports: [RouterLink, ReactiveFormsModule, MapCanvas, Icon],
  templateUrl: './targets.html',
  styles: [
    `
      .target-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 22px;
      }
      .target-card {
        transition:
          transform 0.2s,
          box-shadow 0.2s;
      }
      .target-card:hover {
        transform: translateY(-3px);
        box-shadow: 0 5px 20px #21362c0a;
      }
      .target-card h3 {
        font-size: 16px;
        margin: 9px 0;
      }
      .target-card p {
        font-size: 11px;
        color: var(--muted);
        line-height: 1.7;
        min-height: 40px;
      }
      .card-meta {
        display: flex;
        justify-content: space-between;
        margin-top: 20px;
        font-size: 11px;
      }
      .blank-map {
        height: 100%;
        display: grid;
        place-content: center;
        text-align: center;
        gap: 12px;
        color: #9aa78e;
        background-image:
          linear-gradient(#b0bca315 1px, transparent 1px),
          linear-gradient(90deg, #b0bca315 1px, transparent 1px);
        background-size: 24px 24px;
      }
      .blank-map app-icon {
        margin: auto;
        width: 38px;
        height: 38px;
      }
      .blank-map span {
        font-size: 11px;
      }
      .list-mode {
        grid-template-columns: 1fr;
      }
      .list-mode .target-card {
        display: grid;
        grid-template-columns: 260px 1fr;
      }
      .list-mode .map-preview {
        aspect-ratio: auto;
      }
      .list-mode .card-body p {
        min-height: 0;
      }
      .list-mode .card-meta {
        margin-top: 12px;
      }
      @media (max-width: 1200px) {
        .target-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .list-mode {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 650px) {
        .target-grid {
          grid-template-columns: 1fr;
        }
        .list-mode .target-card {
          grid-template-columns: 1fr;
        }
        .list-mode .map-preview {
          aspect-ratio: 1.6;
        }
      }
    `,
  ],
})
export class TargetsPage {
  readonly repo = inject(PrototypeRepository);
  readonly ui = inject(UiService);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  readonly query = signal('');
  readonly status = signal('open');
  readonly list = signal(false);
  readonly error = signal('');
  readonly filtered = computed(() =>
    this.repo
      .targets()
      .filter(
        (t) =>
          (this.status() === 'all' || t.status === this.status()) &&
          (t.name + ' ' + t.building + ' ' + t.floor)
            .toLowerCase()
            .includes(this.query().toLowerCase()),
      ),
  );
  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    building: ['', [Validators.required, Validators.maxLength(80)]],
    floor: ['', [Validators.required, Validators.maxLength(40)]],
    description: ['', [Validators.required, Validators.maxLength(500)]],
  });
  create(dialog: HTMLDialogElement) {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    try {
      const target = this.repo.createTarget(this.form.getRawValue());
      dialog.close();
      this.ui.notify('Mapping target created');
      void this.router.navigate(['/targets', target.id]);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Could not create target');
    }
  }
}
