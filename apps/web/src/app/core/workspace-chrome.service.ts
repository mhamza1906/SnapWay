import { Injectable, signal } from '@angular/core';

/** Lets Explore drive the centered header search without duplicating chrome. */
@Injectable({ providedIn: 'root' })
export class WorkspaceChrome {
  readonly exploreQuery = signal('');
  readonly exploreSearching = signal(false);
  private searchHandler: ((query: string) => void | Promise<void>) | null = null;
  private locateHandler: (() => void) | null = null;

  bindExplore(handlers: { search: (query: string) => void | Promise<void>; locate: () => void }) {
    this.searchHandler = handlers.search;
    this.locateHandler = handlers.locate;
  }

  unbindExplore() {
    this.searchHandler = null;
    this.locateHandler = null;
    this.exploreQuery.set('');
    this.exploreSearching.set(false);
  }

  async submitSearch(event: Event) {
    event.preventDefault();
    if (!this.searchHandler || this.exploreSearching()) return;
    this.exploreSearching.set(true);
    try {
      await this.searchHandler(this.exploreQuery().trim());
    } finally {
      this.exploreSearching.set(false);
    }
  }

  locate() {
    this.locateHandler?.();
  }
}
