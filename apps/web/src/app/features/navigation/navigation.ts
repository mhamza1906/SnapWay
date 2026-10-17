import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { PrototypeRepository } from '../../core/prototype.repository';
import { DevicePreview, type CaptureOutcome } from '../../core/device-preview';
import { findRoute, stepInstruction } from '../../core/navigation-engine';
import type { MapDocument, MappingTarget } from '../../core/prototype.models';
import { NavigationMap } from './navigation-map';
import { Icon } from '../../shared/icon';
import { CapturePanel } from './capture-panel';

const EMPTY_MAP: MapDocument = { rooms: [], nodes: [], edges: [], annotations: [], references: [] };

@Component({
  selector: 'app-navigation',
  imports: [NavigationMap, Icon, CapturePanel],
  providers: [DevicePreview],
  templateUrl: './navigation.html',
  styleUrl: './navigation.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NavigationPage {
  readonly repository = inject(PrototypeRepository);
  readonly device = inject(DevicePreview);
  private readonly destroyRef = inject(DestroyRef);
  readonly targets = computed(() =>
    this.repository.targets().filter((target) => !!target.published),
  );
  readonly buildings = computed(() => [
    ...new Set(this.targets().map((target) => target.building)),
  ]);
  readonly session = signal<MappingTarget | null>(null);
  readonly floors = computed(() =>
    this.targets().filter((target) => target.building === this.session()?.building),
  );
  readonly map = computed(() => this.session()?.published?.document ?? EMPTY_MAP);
  readonly publicationChanged = computed(() => {
    const target = this.targets().find((target) => target.id === this.session()?.id);
    return (
      !!target && JSON.stringify(target.published) !== JSON.stringify(this.session()?.published)
    );
  });
  readonly publicationUnavailable = computed(
    () => !!this.session() && !this.targets().some((target) => target.id === this.session()?.id),
  );
  readonly query = signal('');
  readonly destination = signal('');
  readonly start = signal('');
  readonly accessible = signal(false);
  readonly phase = signal<'planning' | 'guiding' | 'arrived'>('planning');
  readonly step = signal(0);
  readonly headingConfirmed = signal(false);
  readonly message = signal('');
  readonly suggestedBuilding = signal('');
  readonly cameraOpen = signal(false);
  readonly outcome = signal<CaptureOutcome>('accepted');
  readonly destinations = computed(() => {
    const roomNodes = this.map().nodes.filter((node) => node.roomId);
    const candidates = roomNodes.length ? roomNodes : this.map().nodes;
    return candidates.filter((node) =>
      node.label.toLowerCase().includes(this.query().trim().toLowerCase()),
    );
  });
  readonly destinationNode = computed(() =>
    this.map().nodes.find((node) => node.id === this.destination()),
  );
  readonly startNode = computed(() => this.map().nodes.find((node) => node.id === this.start()));
  readonly route = computed(() =>
    findRoute(this.map(), this.start(), this.destination(), this.accessible()),
  );
  readonly routeIds = computed(() => this.route()?.nodes.map((node) => node.id) ?? []);
  readonly position = computed(() =>
    this.phase() === 'planning' ? this.start() : (this.routeIds()[this.step()] ?? this.start()),
  );
  readonly instruction = computed(() => stepInstruction(this.route()?.nodes ?? [], this.step()));
  readonly guideAngle = computed(() => {
    const instruction = this.instruction();
    return instruction.startsWith('Turn right')
      ? 0
      : instruction.startsWith('Turn left')
        ? 180
        : instruction.startsWith('Turn around')
          ? 90
          : -90;
  });
  readonly nextNode = computed(() => this.route()?.nodes[this.step() + 1]);
  readonly candidateNodes = computed(() => {
    const checkpoints = this.map().nodes.filter((node) => !node.roomId);
    return (checkpoints.length ? checkpoints : this.map().nodes).slice(0, 2);
  });

  constructor() {
    const requestedTarget = inject(ActivatedRoute, { optional: true })?.snapshot.queryParamMap.get(
      'target',
    );
    const first =
      this.targets().find((target) => target.id === requestedTarget) ?? this.targets()[0];
    if (first) this.selectTarget(first.id);
    this.destroyRef.onDestroy(() => this.device.cancel());
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  selectBuilding(building: string): void {
    const target = this.targets().find((item) => item.building === building);
    if (target) this.selectTarget(target.id);
    this.suggestedBuilding.set('');
  }

  selectTarget(id: string): void {
    const target = this.targets().find((item) => item.id === id);
    if (!target?.published) return;
    this.cancelCapture();
    this.session.set(structuredClone(target));
    this.destination.set('');
    this.start.set('');
    this.query.set('');
    this.resetGuidance();
    this.message.set('Choose a destination, then confirm a starting checkpoint.');
  }

  refreshPublication(): void {
    const id = this.session()?.id;
    if (id) this.selectTarget(id);
  }

  leaveUnavailableSession(): void {
    const next = this.targets()[0];
    if (next) this.selectTarget(next.id);
    else {
      this.cancelCapture();
      this.resetGuidance();
      this.session.set(null);
    }
  }

  chooseDestination(id: string): void {
    if (!this.map().nodes.some((node) => node.id === id)) return;
    this.cancelCapture();
    this.destination.set(id);
    this.resetGuidance();
    this.message.set('Destination selected. Confirm where you want the preview to begin.');
  }

  selectObject(id: string): void {
    const node = this.map().nodes.find((item) => item.roomId === id || item.id === id);
    if (node) this.chooseDestination(node.id);
  }

  chooseStart(id: string): void {
    this.cancelCapture();
    this.start.set(id);
    this.resetGuidance();
    this.message.set(
      id
        ? 'Manual starting checkpoint selected. This does not establish your physical location.'
        : 'Choose a starting checkpoint.',
    );
  }

  toggleAccessible(checked: boolean): void {
    this.cancelCapture();
    this.accessible.set(checked);
    this.resetGuidance();
  }

  resetGuidance(): void {
    this.phase.set('planning');
    this.step.set(0);
    this.headingConfirmed.set(false);
  }

  startGuidance(): void {
    if (!this.route() || !this.headingConfirmed() || this.device.background()) return;
    this.phase.set(this.routeIds().length === 1 ? 'arrived' : 'guiding');
    this.step.set(0);
    this.message.set('Preview started. Advance manually to simulate each checkpoint.');
  }

  nextStep(): void {
    if (this.phase() !== 'guiding' || this.device.background()) return;
    this.cancelCapture();
    const next = this.step() + 1;
    this.step.set(next);
    if (next >= this.routeIds().length - 1) {
      this.phase.set('arrived');
      this.message.set('Preview complete. Arrival is simulated, not physically verified.');
    }
  }

  openCamera(): void {
    this.cameraOpen.set(true);
  }

  cancelCapture(): void {
    this.device.cancel();
    this.cameraOpen.set(false);
  }

  setPermission(value: string): void {
    this.device.cancel();
    if (
      value === 'prompt' ||
      value === 'granted' ||
      value === 'denied' ||
      value === 'unsupported'
    ) {
      this.device.permission.set(value);
    }
  }

  captureContext(): string {
    return `${this.session()?.id}:${this.session()?.published?.version}:${this.destination()}:${this.position()}:${this.step()}`;
  }

  acceptCheckpoint(id: string): void {
    this.chooseStart(id);
    this.message.set(
      'Demo checkpoint confirmed. Align with the next landmark before starting guidance.',
    );
  }

  setOffline(offline: boolean): void {
    this.cancelCapture();
    this.device.setOffline(offline);
    this.message.set(
      offline
        ? 'Offline preview: cached publication and manual checkpoints only.'
        : 'Online simulation restored. Capture again for a new demo observation.',
    );
  }

  toggleBackground(): void {
    const background = !this.device.background();
    this.cancelCapture();
    this.device.setBackground(background);
    this.resetGuidance();
    this.message.set(
      background
        ? 'App backgrounded in simulation. Pending capture and guidance were stopped.'
        : 'App resumed. Retake a photo or reconfirm your manual starting checkpoint and heading.',
    );
    if (!background) this.start.set('');
  }

  suggestBuilding(): void {
    this.suggestedBuilding.set(this.targets()[0]?.building ?? '');
  }
}

export { NavigationPage as Navigation };
