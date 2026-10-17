import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { timeout } from 'rxjs';

export interface ApiHealth {
  service: string;
  status: string;
  release: string;
}

@Injectable({ providedIn: 'root' })
export class ApiStatus {
  private readonly http = inject(HttpClient);

  check() {
    return this.http.get<ApiHealth>('/api/health/live/').pipe(timeout(5000));
  }
}
