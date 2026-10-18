import { ActivatedRouteSnapshot, convertToParamMap } from '@angular/router';
import { EditorRouteReuseStrategy } from './editor-route-reuse';

describe('Editor lifecycle and camera cleanup boundary', () => {
  const config = { path: 'graph-editor' };
  const snapshot = (target: string, mode = '') =>
    ({
      routeConfig: config,
      queryParamMap: convertToParamMap({ target, mode }),
    }) as unknown as ActivatedRouteSnapshot;

  it('destroys photo-walk routes instead of retaining an off-screen camera', () => {
    const strategy = new EditorRouteReuseStrategy();
    expect(strategy.shouldDetach(snapshot('floor1', 'photos'))).toBe(false);
    expect(strategy.shouldAttach(snapshot('floor1', 'photos'))).toBe(false);
    expect(strategy.shouldDetach(snapshot('floor1'))).toBe(true);
  });

  it('creates a fresh editor when the target or capture mode changes', () => {
    const strategy = new EditorRouteReuseStrategy();
    expect(
      strategy.shouldReuseRoute(snapshot('floor2', 'photos'), snapshot('floor1', 'photos')),
    ).toBe(false);
    expect(strategy.shouldReuseRoute(snapshot('floor1', 'photos'), snapshot('floor1'))).toBe(false);
    expect(strategy.shouldReuseRoute(snapshot('floor1'), snapshot('floor1'))).toBe(true);
  });
});
