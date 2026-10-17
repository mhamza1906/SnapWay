import { Injectable, signal } from '@angular/core';
@Injectable({ providedIn: 'root' })
export class UiService {
  readonly toast = signal('');
  private timer?: ReturnType<typeof setTimeout>;
  notify(message: string) {
    clearTimeout(this.timer);
    this.toast.set(message);
    this.timer = setTimeout(() => this.toast.set(''), 5000);
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
