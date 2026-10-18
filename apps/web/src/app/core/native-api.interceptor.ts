import type { HttpInterceptorFn } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';

/** Bundled assets have a local origin; Django stays on the public HTTPS server. */
export const NATIVE_API_ORIGIN = 'https://snapway.work';

export const nativeApiInterceptor: HttpInterceptorFn = (request, next) => {
  if (!Capacitor.isNativePlatform() || !request.url.startsWith('/api/')) return next(request);

  return next(
    request.clone({
      url: NATIVE_API_ORIGIN + request.url,
      // Visitor APIs must not depend on cross-site developer session cookies.
      withCredentials: false,
    }),
  );
};
