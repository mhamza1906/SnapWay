import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { WorkspaceApi, MapCard, workspaceError } from '../../core/workspace-api.service';
import { Icon } from '../../shared/icon';
@Component({
  selector: 'app-map-exports',
  imports: [RouterLink, Icon],
  styleUrls: ['./workspace.scss', './exports.scss'],
  template: `<section class="page live-page">
    <header class="page-heading page-heading-compact">
      <p>Your maps are saved to the server. Download a copy whenever you need it.</p>
    </header>
    @if (error()) {
      <p class="error-state" role="alert">{{ error() }}</p>
    }
    <section class="export-panel">
      <label
        >Choose a map<select
          aria-label="Map to export"
          [value]="target()"
          (change)="target.set($any($event.target).value)"
        >
          <option value="">Select a building and floor</option>
          @for (map of maps(); track map.id) {
            <option [value]="map.target_id">{{ map.building }} · {{ map.floor }}</option>
          }
        </select></label
      >
      @if (target()) {
        <div class="export-options">
          @for (format of formats; track format.id) {
            <a [href]="api.exportUrl(target(), format.id)"
              ><app-icon [name]="format.icon" /><span
                ><strong>{{ format.name }}</strong
                ><small>{{ format.description }}</small></span
              ><app-icon name="download"
            /></a>
          }
        </div>
      } @else {
        <p class="muted">
          {{
            loading()
              ? 'Loading maps…'
              : 'Select a map above, or create your first floor in My maps.'
          }}
        </p>
        <a class="btn secondary" routerLink="/my-maps">Go to My maps</a>
      }
    </section>
  </section>`,
})
export class MapExportsPage implements OnInit {
  readonly api = inject(WorkspaceApi);
  readonly maps = signal<MapCard[]>([]);
  readonly target = signal('');
  readonly error = signal('');
  readonly loading = signal(true);
  readonly formats = [
    {
      id: 'json',
      name: 'Map JSON',
      description: 'Floor geometry, coordinate frame and navigation graph.',
      icon: 'layers',
    },
    {
      id: 'graph',
      name: 'Navigation graph',
      description: 'Waypoints, directed connections and weights as JSON.',
      icon: 'route',
    },
    {
      id: 'svg',
      name: 'SVG display map',
      description: 'Supplied floor-plan image with the vector navigation graph.',
      icon: 'image',
    },
  ];
  async ngOnInit() {
    try {
      this.maps.set((await this.api.maps()).maps);
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.loading.set(false);
    }
  }
}
