import { Injectable, signal } from '@angular/core';

/** Transient layout only; never stores map or account data in the browser. */
@Injectable({ providedIn: 'root' })
export class WorkspaceLayout {
  readonly sidebarOpen = signal(typeof window === 'undefined' || window.innerWidth > 760);
  readonly aiOpen = signal(false);
  sidebarWidth(width: number) {
    return width <= 760 ? 268 : width <= 1000 ? 236 : 278;
  }
  aiWidth(width: number) {
    return Math.min(360, Math.max(260, width - 32));
  }
  openAI(width = window.innerWidth) {
    if (this.sidebarOpen() && this.sidebarWidth(width) + this.aiWidth(width) >= width * 0.45) {
      this.sidebarOpen.set(false);
    }
    this.aiOpen.set(true);
  }
  toggleSidebar() {
    this.sidebarOpen.update((open) => !open);
  }
  navigationEnd() {
    if (typeof window !== 'undefined' && window.innerWidth <= 760) this.sidebarOpen.set(false);
  }
}
