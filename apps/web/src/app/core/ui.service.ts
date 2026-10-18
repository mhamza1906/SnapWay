import { Injectable, computed, signal } from '@angular/core';

/** Shared chrome helpers: toast + one global busy overlay for every long wait. */
@Injectable({ providedIn: 'root' })
export class UiService {
  readonly toast = signal('');
  private readonly busyDepth = signal(0);
  readonly busyMessage = signal('Working…');
  readonly busy = computed(() => this.busyDepth() > 0);
  private timer?: ReturnType<typeof setTimeout>;

  notify(message: string) {
    clearTimeout(this.timer);
    this.toast.set(message);
    this.timer = setTimeout(() => this.toast.set(''), 5000);
  }

  beginBusy(message = 'Working…') {
    this.busyMessage.set(message);
    this.busyDepth.update((n) => n + 1);
  }

  endBusy() {
    this.busyDepth.update((n) => Math.max(0, n - 1));
  }

  async runBusy<T>(task: () => Promise<T>, message = 'Working…'): Promise<T> {
    this.beginBusy(message);
    try {
      return await task();
    } finally {
      this.endBusy();
    }
  }

  run(action: () => void, message?: string) {
    try {
      action();
      if (message) this.notify(message);
    } catch (error) {
      this.notify(error instanceof Error ? error.message : 'The action could not be completed.');
    }
  }
}
