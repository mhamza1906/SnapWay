import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IOSVisualMatcher } from './ios-visual-match';
import {
  checkpointRoute,
  checkpointRouteCost,
  type ConnectionPreference,
} from './photo-checkpoint-route';
import { stepInstruction } from '../../core/navigation-engine';
import { gap, type LabNode, type LabPlan } from './movement-model';
import type { CameraCandidate } from './camera-lab';
import type { IOSCapturedPoseFrame } from './indoor-pose';
interface PlaceDestination {
  id: string;
  label: string;
  floorId: string;
  floorLabel: string;
  kind: string;
  x: number;
  y: number;
  terminalNodeId: string;
  terminalNodeIds: string[];
  available: boolean;
  doorId: string;
  accessNote: string;
}
interface FloorView {
  id: string;
  label: string;
  width: number;
  height: number;
  underlay: string;
}
interface BuildingPhotoPlan extends LabPlan {
  floors: FloorView[];
  destinations: PlaceDestination[];
  photoReferenceFloorIds: string[];
}
@Component({
  selector: 'app-ios-pose-lab',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './ios-pose-lab.html',
  styleUrl: './ios-pose-lab.scss',
})
export class IOSPoseLab implements OnInit, OnDestroy {
  readonly plan = signal<BuildingPhotoPlan | null>(null);
  readonly busy = signal(false);
  readonly message = signal(
    'Take a photo to identify a Level 1 point, or select a known landing manually.',
  );
  readonly currentNode = signal<LabNode | null>(null);
  readonly currentFloorId = computed(() => this.currentNode()?.floorId ?? 'L1');
  readonly currentFloor = computed(() =>
    this.currentNode() ? this.floorLabel(this.currentFloorId()) : null,
  );
  readonly startId = signal('');
  readonly startSource = signal<'photo' | 'manual' | null>(null);
  readonly candidate = signal<CameraCandidate | null>(null);
  readonly preview = signal('');
  readonly route = signal<LabNode[]>([]);
  readonly destinationId = signal('');
  readonly destinationFloorId = signal('all');
  readonly preference = signal<ConnectionPreference>('any');
  readonly visibleFloorId = signal('L1');
  readonly arrived = signal(false);
  readonly checkpointMessage = signal('');
  readonly arrivalPhotoNodes = signal<LabNode[]>([]);
  readonly floors = computed(() => this.plan()?.floors ?? []);
  readonly destinations = computed(() => this.plan()?.destinations ?? []);
  readonly filteredDestinations = computed(() =>
    this.destinations().filter(
      (place) => this.destinationFloorId() === 'all' || place.floorId === this.destinationFloorId(),
    ),
  );
  readonly stops = computed(() =>
    (this.plan()?.nodes ?? [])
      .filter((node) => /^Point \d+$/.test(node.label))
      .sort(
        (a, b) => Number(a.label.replace('Point ', '')) - Number(b.label.replace('Point ', '')),
      ),
  );
  readonly startOptions = computed(() => [
    ...this.stops(),
    ...(this.plan()?.nodes.filter((node) => !!node.connectorId) ?? []),
  ]);
  readonly destination = computed(
    () => this.destinations().find((place) => place.id === this.destinationId()) ?? null,
  );
  readonly routePhotoNodes = computed(() =>
    this.route().filter((node) => /^Point \d+$/.test(node.label)),
  );
  readonly routeProgress = computed(() =>
    this.routePhotoNodes().findIndex((node) => node.id === this.currentNode()?.id),
  );
  readonly nextCheckpoint = computed(
    () => this.routePhotoNodes()[this.routeProgress() + 1] ?? null,
  );
  readonly viewedFloor = computed(
    () => this.floors().find((floor) => floor.id === this.visibleFloorId()) ?? null,
  );
  readonly visibleSegments = computed(() => {
    const result: string[] = [];
    let segment: LabNode[] = [];
    const flush = () => {
      if (segment.length > 1) result.push(segment.map((node) => `${node.x},${node.y}`).join(' '));
      segment = [];
    };
    for (const node of this.route()) {
      if (node.floorId === this.visibleFloorId()) segment.push(node);
      else flush();
    }
    flush();
    return result;
  });
  readonly transitions = computed(() =>
    this.route()
      .slice(1)
      .flatMap((node, index) => {
        const from = this.route()[index];
        if (from.floorId === node.floorId) return [];
        const edge = this.plan()?.edges.find(
          (value) =>
            (value.from === from.id && value.to === node.id) ||
            (!value.directed && value.from === node.id && value.to === from.id),
        );
        return [
          {
            id: node.id,
            index,
            from,
            to: node,
            label: edge?.connectorLabel ?? (edge?.traversal === 'elevator' ? 'Elevator' : 'Stairs'),
          },
        ];
      }),
  );
  readonly nextTransition = computed(() => {
    const position = this.route().findIndex((node) => node.id === this.currentNode()?.id);
    return this.transitions().find((step) => step.index >= Math.max(0, position)) ?? null;
  });
  readonly routeDirections = computed(() =>
    this.route()
      .slice(0, -1)
      .flatMap((node, index) => {
        const next = this.route()[index + 1];
        if (node.floorId !== next.floorId) {
          const transition = this.transitions().find((value) => value.index === index)!;
          return [
            `Take ${transition.label} from ${this.floorLabel(node.floorId)} to ${this.floorLabel(next.floorId)}.`,
          ];
        }
        const text =
          index > 0 && this.route()[index - 1].floorId !== node.floorId
            ? `Head toward ${next.label}.`
            : stepInstruction(this.route(), index);
        return text.startsWith('Continue') ? [] : [`${this.floorLabel(node.floorId)}: ${text}`];
      }),
  );
  readonly nearby = computed(() => {
    const node = this.currentNode();
    return node
      ? this.destinations()
          .filter((place) => place.floorId === node.floorId)
          .sort((a, b) => gap(a, node) - gap(b, node))
          .slice(0, 3)
      : [];
  });
  readonly canMatchPhoto = computed(() => !this.currentNode() || this.currentFloorId() === 'L1');
  origin = 'https://ef62-2606-fa00-8a0-705-19b-b32d-9b8d-a456.ngrok-free.app';
  zoom = 1;
  private matcher: IOSVisualMatcher | null = null;
  private generation = 0;
  private destroyed = false;
  private readonly abort = new AbortController();
  floorLabel(id: string | undefined): string {
    return this.floors().find((floor) => floor.id === id)?.label ?? id ?? 'Unknown floor';
  }
  async ngOnInit(): Promise<void> {
    try {
      const response = await fetch('/experiments/photo-building-navigation.json', {
        signal: this.abort.signal,
      });
      if (!response.ok) throw new Error('The saved building routes could not be loaded.');
      const plan = (await response.json()) as BuildingPhotoPlan;
      if (!this.destroyed) this.plan.set(plan);
    } catch (error) {
      if (!this.destroyed)
        this.message.set(error instanceof Error ? error.message : 'Map unavailable.');
    }
  }
  private clearRoute(): void {
    this.route.set([]);
    this.arrived.set(false);
    this.arrivalPhotoNodes.set([]);
  }
  chooseStart(id: string): void {
    const node = this.startOptions().find((value) => value.id === id) ?? null;
    this.currentNode.set(node);
    this.startId.set(node?.id ?? '');
    this.startSource.set(node ? 'manual' : null);
    if (node?.floorId) this.visibleFloorId.set(node.floorId);
    this.clearRoute();
    this.checkpointMessage.set(
      node
        ? `Manually selected ${this.floorLabel(node.floorId)} · ${node.label}. Choose a named destination.`
        : 'Take a starting photo or choose your known landing.',
    );
  }
  chooseDestination(id: string): void {
    this.destinationId.set(id);
    const place = this.destinations().find((value) => value.id === id);
    if (place) this.visibleFloorId.set(place.floorId);
    this.clearRoute();
    this.checkpointMessage.set('Show route to your selected destination.');
  }
  setPreference(value: string): void {
    if (value === 'any' || value === 'stairs' || value === 'elevator') {
      this.preference.set(value);
      this.clearRoute();
    }
  }
  browseFloor(id: string): void {
    if (!this.floors().some((floor) => floor.id === id)) return;
    this.visibleFloorId.set(id);
    this.destinationFloorId.set(id);
  }
  filterFloor(id: string): void {
    if (id === 'all') this.destinationFloorId.set('all');
    else this.browseFloor(id);
  }
  showRoute(): void {
    const plan = this.plan(),
      start = this.currentNode(),
      destination = this.destination();
    if (!plan || !start || !destination || !destination.available || this.busy()) return;
    const routes = destination.terminalNodeIds
      .map((id) => checkpointRoute(plan, start.id, id, this.preference()))
      .filter((route): route is LabNode[] => !!route);
    routes.sort(
      (a, b) =>
        checkpointRouteCost(plan, a, this.preference()) -
        checkpointRouteCost(plan, b, this.preference()),
    );
    const route = routes[0] ?? null;
    this.route.set(route ?? []);
    this.arrived.set(false);
    this.arrivalPhotoNodes.set([]);
    this.visibleFloorId.set(start.floorId ?? 'L1');
    if (!route) {
      this.checkpointMessage.set(
        'No connected route for this destination and stairs/elevator preference. Try another option.',
      );
      return;
    }
    if (destination.floorId === 'L1') {
      const local = {
        ...plan,
        nodes: plan.nodes.filter((node) => node.floorId === 'L1'),
        edges: plan.edges.filter(
          (edge) => edge.floorId === 'L1' && !['stairs', 'elevator'].includes(edge.traversal ?? ''),
        ),
      };
      const nearest = this.stops()
        .map((node) => {
          const path = checkpointRoute(local, node.id, route.at(-1)!.id);
          return { node, distance: path ? checkpointRouteCost(local, path) : Infinity };
        })
        .filter((value) => Number.isFinite(value.distance))
        .sort((a, b) => a.distance - b.distance);
      this.arrivalPhotoNodes.set(nearest.slice(0, 1).map((value) => value.node));
    }
    this.checkpointMessage.set(
      `Route ready: ${this.floorLabel(start.floorId)} · ${start.label} → ${destination.floorLabel} · ${destination.label}. ${destination.floorId === 'L1' ? 'Take a photo near the destination checkpoint.' : 'Follow the floor transitions and confirm each landing manually; destination-floor reference photos are not indexed yet.'}`,
    );
  }
  confirmTransition(id: string): void {
    const next = this.nextTransition();
    if (!next || next.id !== id || next.from.floorId !== this.currentFloorId()) return;
    this.currentNode.set(next.to);
    this.startId.set(next.to.id);
    this.startSource.set('manual');
    this.visibleFloorId.set(next.to.floorId ?? 'L1');
    this.arrived.set(false);
    this.checkpointMessage.set(
      `You manually confirmed ${this.floorLabel(next.to.floorId)} at ${next.label}. Follow this floor's route. This is not a photo-recognised location.`,
    );
  }
  async takePhoto(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    input.value = '';
    if (!file || this.busy() || !this.plan()) return;
    if (!this.canMatchPhoto()) {
      this.message.set(
        'Only Level 1 reference photos are indexed. Confirm your landing manually on this floor.',
      );
      return;
    }
    const generation = ++this.generation;
    this.busy.set(true);
    this.candidate.set(null);
    this.arrived.set(false);
    this.checkpointMessage.set('');
    this.message.set('Matching this photo to Level 1 reference nodes…');
    try {
      const frame = await this.photoFrame(file);
      if (!this.current(generation)) return;
      this.preview.set(`data:image/jpeg;base64,${frame.jpegBase64}`);
      this.matcher?.dispose();
      const matcher = new IOSVisualMatcher(this.origin);
      this.matcher = matcher;
      await matcher.start();
      if (!this.current(generation)) return;
      const result = await matcher.match(frame);
      if (!this.current(generation)) return;
      this.candidate.set(result);
      const node = this.stops().find((value) => value.id === result.nodeId);
      if (result.status !== 'candidate' || !node) {
        this.message.set(
          `Location uncertain. ${result.note || 'Similar-looking points.'} Take another photo of a distinctive landmark.`,
        );
        this.checkpointMessage.set('No progress or arrival confirmed; your route is preserved.');
        return;
      }
      this.currentNode.set(node);
      this.startId.set(node.id);
      this.startSource.set('photo');
      this.visibleFloorId.set('L1');
      this.message.set(`Photo matched Level 1 · ${node.label}.`);
      if (this.route().length) {
        if (
          this.destination()?.floorId === 'L1' &&
          this.arrivalPhotoNodes().some((value) => value.id === node.id)
        ) {
          this.arrived.set(true);
          this.checkpointMessage.set(
            `Near ${this.destination()?.label} on Level 1. The nearest photo checkpoint matches; confirm the room sign at the saved entrance.`,
          );
        } else if (this.route().some((value) => value.id === node.id))
          this.checkpointMessage.set(
            `On route at Level 1 · ${node.label}. Continue toward the next checkpoint or floor connection.`,
          );
        else
          this.checkpointMessage.set(
            'This photo point is outside the planned route. Replan from here.',
          );
      }
    } catch (error) {
      if (this.current(generation)) {
        this.message.set(error instanceof Error ? error.message : 'Photo matching failed.');
        this.checkpointMessage.set('Route preserved; no new location or arrival confirmed.');
      }
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
  changeZoom(amount: number): void {
    this.zoom = Math.min(4, Math.max(1, this.zoom + amount));
  }
  private current(generation: number): boolean {
    return !this.destroyed && generation === this.generation;
  }
  private async photoFrame(file: File): Promise<IOSCapturedPoseFrame> {
    if (file.size > 25_000_000) throw new Error('Choose a photo smaller than 25 MB.');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Cannot decode this photo. Take a new JPEG photo.'));
        image.src = url;
      });
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('Empty photo.');
      const scale = Math.min(1, 960 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Photo processing is unavailable.');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return {
        jpegBase64: canvas.toDataURL('image/jpeg', 0.8).split(',')[1],
        timestamp: Date.now(),
        monotonicSeconds: performance.now() / 1000,
        epoch: 'photo-checkpoint',
        pose: { x: 0, y: 0, z: 0 },
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    this.generation++;
    this.abort.abort();
    this.matcher?.dispose();
  }
}
