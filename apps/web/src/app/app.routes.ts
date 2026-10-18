import { Routes } from '@angular/router';
import {
  adminGuard,
  developerGuard,
  publicGuard,
  publicDiscoveryGuard,
  sessionGuard,
} from './core/auth.service';

export const routes: Routes = [
  {
    path: 'movement-lab',
    loadComponent: () => import('./features/movement-lab/movement-lab').then((m) => m.MovementLab),
  },
  {
    path: 'app-preview',
    loadComponent: () => import('./features/visitor/visitor').then((m) => m.VisitorJourney),
  },
  { path: '', pathMatch: 'full', redirectTo: 'sign-in' },
  { path: 'app-review', pathMatch: 'full', redirectTo: 'app-preview' },
  {
    path: 'sign-in',
    loadComponent: () => import('./features/sign-in/sign-in').then((m) => m.SignInPage),
  },
  {
    path: 'public',
    canActivate: [publicGuard],
    loadComponent: () => import('./features/visitor/visitor').then((m) => m.VisitorJourney),
  },
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
    path: 'map-optimize',
    canActivate: [developerGuard],
    loadComponent: () =>
      import('./features/map-optimize/map-optimize').then((m) => m.MapOptimizePage),
  },
  {
    path: 'map',
    canActivate: [publicDiscoveryGuard],
    loadComponent: () => import('./features/map/map').then((m) => m.PublicMapPage),
  },
  {
    path: 'auth/complete',
    loadComponent: () => import('./features/welcome/auth-complete').then((m) => m.AuthCompletePage),
  },
  {
    path: 'overview',
    loadComponent: () => import('./features/overview/overview').then((m) => m.OverviewPage),
  },
  {
    path: 'targets',
    loadComponent: () => import('./features/targets/targets').then((m) => m.TargetsPage),
  },
  {
    path: 'targets/:id',
    loadComponent: () => import('./features/targets/target-detail').then((m) => m.TargetDetailPage),
  },
  {
    path: 'contributions',
    loadComponent: () =>
      import('./features/contributions/contributions').then((m) => m.ContributionsPage),
  },
  {
    path: 'graph-editor',
    loadComponent: () =>
      import('./features/graph-editor/graph-editor-entry').then((m) => m.GraphEditorEntry),
  },
  {
    path: 'editor/:id',
    loadComponent: () => import('./features/editor/editor').then((m) => m.EditorPage),
    canDeactivate: [(component: { canLeave: () => boolean }) => component.canLeave()],
  },
  {
    path: 'authoring',
    loadComponent: () => import('./features/authoring/authoring').then((m) => m.AuthoringPage),
  },
  {
    path: 'review',
    loadComponent: () => import('./features/review/review').then((m) => m.ReviewPage),
  },
  {
    path: 'review/:id',
    loadComponent: () => import('./features/review/review-detail').then((m) => m.ReviewDetailPage),
  },
  {
    path: 'navigate',
    loadComponent: () => import('./features/navigation/navigation').then((m) => m.NavigationPage),
  },
  {
    path: 'capture',
    loadComponent: () => import('./features/capture/capture').then((m) => m.CapturePage),
  },
  {
    path: 'activity',
    loadComponent: () => import('./features/activity/activity').then((m) => m.ActivityPage),
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings').then((m) => m.SettingsPage),
  },
  { path: 'help', loadComponent: () => import('./features/help/help').then((m) => m.HelpPage) },
  {
    path: 'welcome',
    canActivate: [sessionGuard],
    loadComponent: () => import('./features/welcome/welcome').then((m) => m.WelcomePage),
  },
  {
    path: 'connection-check',
    loadComponent: () => import('./features/workspace/workspace').then((m) => m.Workspace),
  },
  {
    path: '**',
    loadComponent: () => import('./features/not-found/not-found').then((m) => m.NotFoundPage),
  },
].map((route) =>
  [
    'overview',
    'targets',
    'targets/:id',
    'contributions',
    'graph-editor',
    'editor/:id',
    'authoring',
    'capture',
    'review',
    'review/:id',
    'activity',
    'settings',
    'connection-check',
  ].includes(route.path ?? '')
    ? { ...route, canActivate: [developerGuard] }
    : route,
) as Routes;
