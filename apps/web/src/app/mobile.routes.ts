import type { Routes } from '@angular/router';
import { Capacitor } from '@capacitor/core';

/** One shared installed-app entry for Android and iOS, with no editor bundle. */
export const mobileRoutes: Routes = [
  {
    path: 'ios-pose-lab',
    loadComponent: () => import('./features/movement-lab/ios-pose-lab').then((m) => m.IOSPoseLab),
  },
  {
    path: 'movement-lab',
    loadComponent: () => import('./features/movement-lab/movement-lab').then((m) => m.MovementLab),
  },
  {
    path: '',
    pathMatch: 'full',
    redirectTo: Capacitor.getPlatform() === 'ios' ? 'ios-pose-lab' : 'movement-lab',
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
