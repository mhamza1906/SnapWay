import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { UiService } from '../../core/ui.service';
import { MapCard, WorkspaceApi, workspaceError } from '../../core/workspace-api.service';
import { Icon } from '../../shared/icon';

type SetupMode = 'existing' | 'new';

/** Compact map setup: find or create a building, then open the manual editor. */
@Component({
  selector: 'app-authoring',
  imports: [Icon],
  templateUrl: './authoring.html',
  styleUrl: './authoring.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthoringPage implements OnInit {
  readonly auth = inject(AuthService);
  private readonly workspace = inject(WorkspaceApi);
  private readonly ui = inject(UiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly mode = signal<SetupMode>('new');
  readonly maps = signal<MapCard[]>([]);
  readonly selectedTarget = signal('');
  readonly buildingName = signal(this.route.snapshot.queryParamMap.get('building') || '');
  readonly floorCode = signal('');
  readonly latitude = signal(this.route.snapshot.queryParamMap.get('lat') || '');
  readonly longitude = signal(this.route.snapshot.queryParamMap.get('lng') || '');
  readonly busy = signal(false);
  readonly message = signal('');
  readonly error = signal('');
  readonly offline = signal('');

  readonly library = computed(() => this.maps());
  readonly canOpenEditor = computed(() =>
    this.mode() === 'existing'
      ? !!this.selectedTarget()
      : !!(this.buildingName().trim() && this.floorCode().trim()),
  );
  readonly canUpload = computed(() => this.canOpenEditor());

  async ngOnInit() {
    try {
      this.maps.set((await this.workspace.maps()).maps);
    } catch (e) {
      this.offline.set(workspaceError(e) || 'Could not load existing maps.');
    }
  }

  selectLibrary(targetId: string) {
    this.selectedTarget.set(targetId);
    const map = this.maps().find((m) => m.target_id === targetId);
    if (map) {
      this.buildingName.set(map.building);
      this.floorCode.set(map.floor);
    }
  }

  async openEditor() {
    await this.run(async () => {
      const target = await this.ensureTarget();
      await this.router.navigate(['/graph-editor'], { queryParams: { target } });
    });
  }

  async uploadAndEdit(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!/^(image\/(png|jpeg|webp))$/.test(file.type)) {
      this.error.set(
        'Upload a PNG, JPEG, or WebP floor plan. Image 2.5 optimization runs before the editor.',
      );
      return;
    }
    await this.run(async () => {
      const target = await this.ensureTarget();
      this.say(`${file.name} uploaded. Running Image 2.5 optimization (may take up to a minute)…`);
      await this.workspace.optimizeUpload(target, file);
      this.say('Optimized candidate ready.');
      await this.router.navigate(['/map-optimize'], { queryParams: { target } });
    });
  }

  private async ensureTarget(): Promise<string> {
    if (this.mode() === 'existing') {
      if (!this.selectedTarget()) throw new Error('Choose an existing building first.');
      return this.selectedTarget();
    }
    if (!this.buildingName().trim() || !this.floorCode().trim()) {
      throw new Error('Enter a building name and floor code first.');
    }
    const params = this.route.snapshot.queryParamMap;
    const result = await this.workspace.create({
      building_name: this.buildingName().trim(),
      floor_code: this.floorCode().trim(),
      floor_name: `Floor ${this.floorCode().trim()}`,
      building_id: params.get('buildingId') || undefined,
      place_id: params.get('placeId') || undefined,
      address: params.get('address') || '',
      ...(this.latitude().trim() && this.longitude().trim()
        ? {
            latitude: Number(Number(this.latitude()).toFixed(6)),
            longitude: Number(Number(this.longitude()).toFixed(6)),
          }
        : {}),
    });
    return result.target_id;
  }

  private say(text: string) {
    this.message.set(text);
    this.error.set('');
  }

  private async run(task: () => Promise<void>) {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.ui.runBusy(task, 'Working…');
    } catch (e) {
      this.error.set(workspaceError(e));
    } finally {
      this.busy.set(false);
    }
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }
}
