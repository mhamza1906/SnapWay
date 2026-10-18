import { routes } from './app.routes';
import { adminGuard, developerGuard, publicGuard } from './core/auth.service';

describe('Integrated experience routes', () => {
  it('starts with the two-experience entry while keeping main visitor views', () => {
    expect(routes.find((route) => route.path === '')?.redirectTo).toBe('sign-in');
    expect(routes.find((route) => route.path === 'public')?.canActivate).toEqual([publicGuard]);
    expect(routes.find((route) => route.path === 'app-preview')?.loadComponent).toBeDefined();
  });

  it('preserves the existing developer workspace and phone collection URLs', () => {
    for (const path of [
      'overview',
      'targets',
      'targets/:id',
      'editor/:id',
      'authoring',
      'graph-editor',
      'capture',
      'review',
      'review/:id',
      'activity',
      'settings',
    ]) {
      const route = routes.find((entry) => entry.path === path);
      expect(route?.loadComponent, path).toBeDefined();
      expect(route?.redirectTo, path).toBeUndefined();
      expect(route?.canActivate, path).toEqual([developerGuard]);
    }
  });

  it('retains main workspace pages without widening the administrator views', () => {
    expect(routes.find((route) => route.path === 'my-maps')?.loadComponent).toBeDefined();
    expect(routes.find((route) => route.path === 'developer-contribution')?.canActivate).toEqual([
      adminGuard,
    ]);
  });
});
