import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { App } from './app/app';

bootstrapApplication(App, {
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
