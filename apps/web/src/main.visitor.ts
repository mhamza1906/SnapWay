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
        loadComponent: () => import('./app/features/map/map').then((m) => m.PublicMapPage),
      },
      { path: 'map', redirectTo: '', pathMatch: 'full' },
      {
        path: 'navigate',
        loadComponent: () =>
          import('./app/features/navigation/navigation').then((m) => m.NavigationPage),
      },
      { path: '**', redirectTo: '' },
    ]),
  ],
}).catch((error) => console.error(error));
