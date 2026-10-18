import { Routes } from '@angular/router';
import { adminGuard, developerGuard, publicGuard, sessionGuard } from './core/auth.service';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'sign-in' },
  {
    path: 'explore',
    canActivate: [developerGuard],
    loadComponent: () => import('./features/developer/explore').then((m) => m.ExplorePage),
  },
  {
    path: 'my-maps',
    canActivate: [developerGuard],
    loadComponent: () => import('./features/developer/my-maps').then((m) => m.MyMapsPage),
  },
  {
    path: 'developer-contribution',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./features/developer/contributions').then((m) => m.DeveloperContributionsPage),
  },
  {
    path: 'developer-contribution/activity',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./features/developer/activity').then((m) => m.DeveloperActivityPage),
  },
  {
    path: 'developer-contribution/:id',
    canActivate: [adminGuard],
    loadComponent: () => import('./features/developer/comparison').then((m) => m.MapComparisonPage),
  },
  {
    path: 'graph-editor',
    canActivate: [developerGuard],
    loadComponent: () =>
      import('./features/graph-editor/graph-editor').then((m) => m.GraphEditorPage),
  },
  {
    path: 'authoring',
    canActivate: [developerGuard],
    loadComponent: () => import('./features/authoring/authoring').then((m) => m.AuthoringPage),
  },
  {
    path: 'settings',
    canActivate: [developerGuard],
    loadComponent: () => import('./features/developer/exports').then((m) => m.MapExportsPage),
  },
  {
    path: 'help',
    canActivate: [developerGuard],
    loadComponent: () => import('./features/developer/help').then((m) => m.DeveloperHelpPage),
  },
  { path: 'map', pathMatch: 'full', redirectTo: 'explore' },
  { path: 'overview', pathMatch: 'full', redirectTo: 'my-maps' },
  { path: 'targets', pathMatch: 'full', redirectTo: 'my-maps' },
  { path: 'targets/:id', redirectTo: 'my-maps' },
  { path: 'editor/:id', redirectTo: 'my-maps' },
  { path: 'contributions', pathMatch: 'full', redirectTo: 'developer-contribution' },
  { path: 'review', pathMatch: 'full', redirectTo: 'developer-contribution' },
  { path: 'review/:id', redirectTo: 'developer-contribution/:id' },
  { path: 'activity', pathMatch: 'full', redirectTo: 'developer-contribution/activity' },
  {
    path: 'public',
    canActivate: [publicGuard],
    loadComponent: () =>
      import('./features/public-placeholder/public-placeholder').then(
        (m) => m.PublicPlaceholderPage,
      ),
  },
  {
    path: 'sign-in',
    loadComponent: () => import('./features/sign-in/sign-in').then((m) => m.SignInPage),
  },
  {
    path: 'auth/complete',
    loadComponent: () => import('./features/welcome/auth-complete').then((m) => m.AuthCompletePage),
  },
  {
    path: 'welcome',
    canActivate: [sessionGuard],
    loadComponent: () => import('./features/welcome/welcome').then((m) => m.WelcomePage),
  },
  { path: 'navigate', pathMatch: 'full', redirectTo: 'public' },
  {
    path: 'connection-check',
    canActivate: [developerGuard],
    loadComponent: () => import('./features/workspace/workspace').then((m) => m.Workspace),
  },
  {
    path: '**',
    loadComponent: () => import('./features/not-found/not-found').then((m) => m.NotFoundPage),
  },
];
