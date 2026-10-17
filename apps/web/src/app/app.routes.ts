import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/workspace/workspace').then((m) => m.Workspace),
  },
  { path: '**', redirectTo: '' },
];
