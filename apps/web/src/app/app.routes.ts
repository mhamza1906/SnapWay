import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'overview' },
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
];
