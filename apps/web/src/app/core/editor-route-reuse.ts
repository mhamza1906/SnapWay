import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, DetachedRouteHandle, RouteReuseStrategy } from '@angular/router';

/**
 * Keeps the graph editor component tree alive across navigations (hide/reattach
 * instead of destroy/create) so underlay + canvas state survive hot returns.
 * One cached editor per target id; switching targets creates a fresh instance.
 */
@Injectable()
export class EditorRouteReuseStrategy implements RouteReuseStrategy {
  private readonly stored = new Map<string, DetachedRouteHandle>();

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.isEditor(route);
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    const key = this.key(route);
    if (!handle) {
      this.stored.delete(key);
      return;
    }
    // Bound memory: only the most recent editor target stays cached.
    for (const existing of [...this.stored.keys()]) {
      if (existing !== key) this.stored.delete(existing);
    }
    this.stored.set(key, handle);
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    return this.isEditor(route) && this.stored.has(this.key(route));
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    return this.isEditor(route) ? (this.stored.get(this.key(route)) ?? null) : null;
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    if (future.routeConfig?.path === 'graph-editor' && curr.routeConfig?.path === 'graph-editor') {
      return (
        future.routeConfig === curr.routeConfig &&
        this.key(future) === this.key(curr) &&
        future.queryParamMap.get('mode') === curr.queryParamMap.get('mode')
      );
    }
    return future.routeConfig === curr.routeConfig;
  }

  private isEditor(route: ActivatedRouteSnapshot): boolean {
    // A detached camera view would keep capturing while hidden. Photo walks must
    // be destroyed on navigation so their live camera and requests are stopped.
    return (
      route.routeConfig?.path === 'graph-editor' && route.queryParamMap.get('mode') !== 'photos'
    );
  }

  private key(route: ActivatedRouteSnapshot): string {
    return `graph-editor:${route.queryParamMap.get('target') || ''}`;
  }
}
