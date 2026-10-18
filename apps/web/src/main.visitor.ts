import { Component, provideBrowserGlobalErrorListeners } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, RouterOutlet } from '@angular/router';

@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })
class VisitorApp {}

bootstrapApplication(VisitorApp, {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideRouter([
      {
        path: '',
        data: { contributor: false },
        loadComponent: () => import('./app/features/visitor/visitor').then((m) => m.VisitorJourney),
      },
      { path: 'map', redirectTo: '', pathMatch: 'full' },
      { path: 'navigate', redirectTo: '', pathMatch: 'full' },
      { path: '**', redirectTo: '' },
    ]),
  ],
}).catch((error) => console.error(error));
