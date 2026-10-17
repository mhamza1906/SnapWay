import { Injectable, signal } from '@angular/core';

export type CaptureOutcome = 'accepted' | 'ambiguous' | 'rejected' | 'error';
export interface PreviewObservation {
  outcome: CaptureOutcome;
  context: string;
  capturedAt: string;
}

/** Simulated device boundary: never requests native hardware or calls a recognition provider. */
@Injectable()
export class DevicePreview {
  readonly permission = signal<'prompt' | 'granted' | 'denied' | 'unsupported'>('prompt');
  readonly offline = signal(false);
  readonly background = signal(false);
  readonly processing = signal(false);
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private complete?: (value: PreviewObservation | null) => void;

  capture(context: string, outcome: CaptureOutcome): Promise<PreviewObservation | null> {
    this.cancel();
    if (this.permission() !== 'granted' || this.offline() || this.background()) {
      return Promise.resolve(null);
    }
    const generation = this.generation;
    const capturedAt = new Date().toISOString();
    this.processing.set(true);
    return new Promise((resolve) => {
      this.complete = resolve;
      this.timer = setTimeout(() => {
        this.processing.set(false);
        this.timer = undefined;
        this.complete = undefined;
        resolve(generation === this.generation ? { outcome, context, capturedAt } : null);
      }, 1200);
    });
  }

  cancel(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.complete?.(null);
    this.complete = undefined;
    this.processing.set(false);
  }

  setBackground(background: boolean): void {
    this.cancel();
    this.background.set(background);
  }

  setOffline(offline: boolean): void {
    this.cancel();
    this.offline.set(offline);
  }
}
