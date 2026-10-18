import { Component, provideBrowserGlobalErrorListeners } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, RouterOutlet } from '@angular/router';
import { nativeApiInterceptor } from './app/core/native-api.interceptor';
import { mobileRoutes } from './app/mobile.routes';

@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })
class VisitorApp {}

bootstrapApplication(VisitorApp, {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptors([nativeApiInterceptor])),
    provideRouter(mobileRoutes),
  ],
}).catch((error) => console.error(error));
