import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface ClientConfig {
  maps: { browser_key: string; map_id: string };
  auth: { google_enabled: boolean };
}

@Injectable({ providedIn: 'root' })
export class ClientConfigService {
  private readonly http = inject(HttpClient);
  private pending?: Promise<ClientConfig>;

  load(): Promise<ClientConfig> {
    return (this.pending ??= firstValueFrom(
      this.http.get<ClientConfig>('/api/client-config/'),
    ).catch(() => {
      this.pending = undefined;
      throw new Error('Unable to reach SnapWay. Please try again.');
    }));
  }
}
