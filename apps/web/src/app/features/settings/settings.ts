import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { MAX_PROTOTYPE_IMPORT_BYTES, PrototypeRepository } from '../../core/prototype.repository';
import { validatePrototypeState } from '../../core/prototype.validation';
import { UiService } from '../../core/ui.service';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'app-settings',
  imports: [RouterLink, Icon],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  readonly auth = inject(AuthService);
  readonly repository = inject(PrototypeRepository);
  readonly ui = inject(UiService);
  private readonly destroyRef = inject(DestroyRef);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly pendingImport = signal<{
    name: string;
    json: string;
    targets: number;
    contributions: number;
  } | null>(null);
  readonly publications = computed(
    () => this.repository.targets().filter((target) => target.published).length,
  );
  readonly dataSize = computed(() => {
    const bytes = new Blob([this.repository.exportData()]).size;
    return bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  });

  exportData(): void {
    this.ui.run(() => {
      const blob = new Blob([this.repository.exportData()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `snapway-prototype-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'Prototype export downloaded. Keep this file to restore your work.');
  }

  async prepareImport(event: Event, dialog: HTMLDialogElement): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error.set('');
    if (file.size > MAX_PROTOTYPE_IMPORT_BYTES) {
      this.error.set('Choose a JSON export smaller than 8 MB.');
      return;
    }
    this.loading.set(true);
    try {
      const json = await file.text();
      if (this.destroyRef.destroyed) return;
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch {
        throw new Error('This file is not valid JSON. Choose a SnapWay prototype export.');
      }
      const validated = validatePrototypeState(value);
      this.pendingImport.set({
        name: file.name,
        json,
        targets: validated.targets.length,
        contributions: validated.contributions.length,
      });
      dialog.showModal();
    } catch (error) {
      this.error.set(
        error instanceof Error
          ? error.message
          : 'This file could not be read. Try a different export.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  confirmImport(dialog: HTMLDialogElement): void {
    const pending = this.pendingImport();
    if (!pending) return;
    try {
      this.repository.importData(pending.json);
      this.pendingImport.set(null);
      this.error.set('');
      dialog.close();
      this.ui.notify('Prototype data imported. Your workspace now uses the restored data.');
    } catch (error) {
      this.error.set(
        error instanceof Error
          ? error.message
          : 'Import failed. Your previous data has been preserved.',
      );
      dialog.close();
    }
  }

  resetDemo(dialog: HTMLDialogElement): void {
    try {
      this.repository.resetDemo();
      this.error.set('');
      dialog.close();
      this.ui.notify('Demo reset. The original targets, draft and review are ready to explore.');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'The demo could not be reset.');
      dialog.close();
    }
  }
}
