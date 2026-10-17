import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DevicePreview, type CaptureOutcome } from '../../core/device-preview';
import type { Waypoint } from '../../core/prototype.models';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'app-capture-panel',
  imports: [Icon],
  templateUrl: './capture-panel.html',
  styleUrl: './capture-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CapturePanel {
  readonly device = inject(DevicePreview);
  readonly context = input.required<string>();
  readonly candidates = input<Waypoint[]>([]);
  readonly outcome = model<CaptureOutcome>('accepted');
  readonly closed = output<void>();
  readonly checkpoint = output<string>();
  readonly result = signal<CaptureOutcome | null>(null);
  readonly previewImage = signal('');
  readonly imageName = signal('');
  readonly imageError = signal('');
  readonly observationTime = signal('');
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly destroyRef = inject(DestroyRef);
  private alive = true;

  constructor() {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    afterRenderEffect(() => {
      this.device.permission();
      this.device.processing();
      this.result();
      const dialog = this.dialog()?.nativeElement;
      if (dialog && !dialog.contains(document.activeElement))
        dialog.querySelector<HTMLButtonElement>('button')?.focus();
    });
    this.destroyRef.onDestroy(() => {
      this.alive = false;
      this.device.cancel();
      previousFocus?.focus();
    });
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const elements = this.dialog()?.nativeElement.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
    );
    if (!elements?.length) return;
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  setPermission(value: string): void {
    this.device.cancel();
    this.result.set(null);
    if (value === 'prompt' || value === 'granted' || value === 'denied' || value === 'unsupported')
      this.device.permission.set(value);
  }

  async capture(): Promise<void> {
    const context = this.context();
    this.result.set(null);
    const observation = await this.device.capture(context, this.outcome());
    if (!this.alive || !observation || observation.context !== this.context()) return;
    this.result.set(observation.outcome);
    this.observationTime.set(new Date(observation.capturedAt).toLocaleTimeString());
  }

  uploadPhoto(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.device.cancel();
    this.result.set(null);
    this.imageError.set('');
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size > 4 * 1024 * 1024
    ) {
      this.imageError.set('Choose a JPEG, PNG or WebP image up to 4 MB.');
      return;
    }
    const context = this.context();
    const reader = new FileReader();
    reader.onerror = () =>
      this.imageError.set('The image could not be read. Choose another image.');
    reader.onload = () => {
      if (!this.alive || context !== this.context()) return;
      this.previewImage.set(String(reader.result));
      this.imageName.set(file.name);
    };
    reader.readAsDataURL(file);
  }
}
