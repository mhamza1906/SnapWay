import { Component, provideBrowserGlobalErrorListeners } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, RouterOutlet } from '@angular/router';

@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })
class VisitorApp {}

bootstrapApplication(VisitorApp, {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter([
      {
        path: '',
        loadComponent: () =>
          import('./app/features/navigation/navigation').then((m) => m.Navigation),
      },
      { path: '**', redirectTo: '' },
    ]),
  ],
}).catch((error) => console.error(error));
