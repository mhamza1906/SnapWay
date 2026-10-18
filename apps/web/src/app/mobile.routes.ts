import type { Routes } from '@angular/router';

/** One shared installed-app entry for Android and iOS, with no editor bundle. */
export const mobileRoutes: Routes = [
  {
    path: 'movement-lab',
    loadComponent: () => import('./features/movement-lab/movement-lab').then((m) => m.MovementLab),
  },
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'movement-lab',
  },
  {
    path: 'app-home',
    loadComponent: () => import('./features/mobile-entry/mobile-entry').then((m) => m.MobileEntry),
  },
  {
    path: 'public',
    data: { contributor: false },
    loadComponent: () => import('./features/visitor/visitor').then((m) => m.VisitorJourney),
  },
  { path: 'map', redirectTo: 'public', pathMatch: 'full' },
  { path: 'navigate', redirectTo: 'public', pathMatch: 'full' },
  { path: 'app-preview', redirectTo: 'public', pathMatch: 'full' },
  { path: '**', redirectTo: '' },
];
