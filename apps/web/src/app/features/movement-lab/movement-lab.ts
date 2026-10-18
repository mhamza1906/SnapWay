import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CameraLab, type CameraCandidate } from './camera-lab';
import {
  ArrivalGate,
  CorridorEstimate,
  gpsDistance,
  type LabPlan,
  type Position,
} from './movement-model';
import {
  NavigationSensors,
  type HeadingReading,
  type LocationReading,
  type StepsReading,
} from './navigation-sensors';

interface VideoReplayFrame {
  timeSeconds: number;
  nodeId: string | null;
  label?: string;
  confidence?: number;
  status: 'candidate' | 'uncertain';
  similarity?: number;
  margin?: number;
  note?: string;
}
interface VideoReplay {
  video: { name: string; durationSeconds: number; src?: string };
  method: string;
  frames: VideoReplayFrame[];
  notes?: string[];
}

/** Isolated experiment. Reference matching is shown separately from sensor estimates. */
@Component({
  selector: 'app-movement-lab',
  imports: [FormsModule, DecimalPipe, CameraLab],
  templateUrl: './movement-lab.html',
  styleUrl: './movement-lab.scss',
})
export class MovementLab implements OnInit, OnDestroy {
  readonly plan = signal<LabPlan | null>(null);
  readonly liveCandidate = signal<CameraCandidate | null>(null);
  readonly livePoint = computed(() => {
    const frame = this.liveCandidate();
    const id = frame?.nodeId ?? frame?.candidateNodeId;
    return id ? (this.plan()?.nodes.find((node) => node.id === id) ?? null) : null;
  });
  readonly replay = signal<VideoReplay | null>(null);
  readonly replayFrame = signal<VideoReplayFrame | null>(null);
  readonly replayMessage = signal('');
  readonly replayBusy = signal(false);
  readonly replayPoint = computed(() => {
    const frame = this.replayFrame();
    return frame?.nodeId
      ? (this.plan()?.nodes.find((node) => node.id === frame.nodeId) ?? null)
      : null;
  });
  readonly selectedPoint = computed(
    () => this.plan()?.nodes.find((node) => node.id === this.selectedNode()) ?? null,
  );
  readonly selectedNode = signal('');
  zoom = 1;
  showReferenceNodes = false;
  replayTime = 0;
  readonly phase = signal<'outdoor' | 'indoor'>('outdoor');
  readonly mode = signal<'idle' | 'gps' | 'motion' | 'simulation'>('idle');
  readonly message = signal('Start GPS outdoors, or try the clearly labelled simulation.');
  readonly fix = signal<LocationReading | null>(null);
  readonly heading = signal<HeadingReading | null>(null);
  readonly position = signal<Position | null>(null);
  readonly trail = signal<Position[]>([]);
  readonly count = signal(0);
  readonly uncertainty = signal(2);
  readonly confirmed = signal(false);
  readonly calibrated = signal(false);
  readonly nearby = signal<{ label: string; distanceM: number | null }[]>([]);
  readonly photoStops = computed(
    () => this.plan()?.nodes.filter((n) => /^Point \d+$/.test(n.label)) ?? [],
  );
  readonly trailPoints = computed(() =>
    this.trail()
      .map((p) => `${p.x},${p.y}`)
      .join(' '),
  );
  readonly distance = computed(() => {
    const fix = this.fix();
    return fix ? gpsDistance(fix, { lat: this.latitude, lng: this.longitude }) : null;
  });
  latitude = 43.78838;
  longitude = -79.19103;
  radius = 70;
  anchorId = '';
  targetId = '';
  measuredMetres: number | null = null;
  stride = 0.72;
  showTrail = true;
  private estimate: CorridorEstimate | null = null;
  private visualReceivedAt = 0;
  private gate = new ArrivalGate();
  private sensors: NavigationSensors | null = null;
  private epoch = 0;
  private baseline: number | null = null;
  private lastStepTime = 0;
  private destroyed = false;
  private demoHeading = 0;
  private readonly abort = new AbortController();
  private readonly visibility = () => {
    if (document.hidden)
      this.pause(
        'Paused while this screen is hidden. Confirm your reference point again before resuming.',
      );
  };
  private readonly orientation = () =>
    this.pause('Phone orientation changed. Reconfirm your reference point and facing calibration.');

  async ngOnInit(): Promise<void> {
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('orientationchange', this.orientation);
    try {
      const response = await fetch('/experiments/entrance-node19.json', {
        signal: this.abort.signal,
      });
      if (!response.ok) throw new Error('Saved experiment map could not be loaded.');
      const plan = (await response.json()) as LabPlan;
      if (this.destroyed) return;
      this.estimate = new CorridorEstimate(plan);
      this.plan.set(plan);
      this.anchorId = plan.entryId;
      this.selectedNode.set(plan.entryId);
      this.latitude = plan.outdoor.lat;
      this.longitude = plan.outdoor.lng;
      this.radius = plan.outdoor.radiusM;
      this.chooseNearestCalibrationTarget();
      this.refreshPosition();
    } catch (error) {
      if (!this.destroyed)
        this.message.set(error instanceof Error ? error.message : 'Map unavailable.');
    }
  }

  receiveVisualCandidate(frame: CameraCandidate): void {
    if (
      !Number.isFinite(frame.timeSeconds) ||
      frame.timeSeconds < 0 ||
      (frame.similarity !== undefined &&
        (!Number.isFinite(frame.similarity) || Math.abs(frame.similarity) > 1)) ||
      (frame.margin !== undefined &&
        (!Number.isFinite(frame.margin) || frame.margin < 0 || frame.margin > 2))
    )
      return;
    this.visualReceivedAt = Date.now();
    if (frame.nodeId !== null && !this.plan()?.nodes.some((node) => node.id === frame.nodeId)) {
      this.liveCandidate.set({
        ...frame,
        nodeId: null,
        status: 'uncertain',
        note: 'Matching response used a reference outside this stored map.',
      });
      return;
    }
    this.liveCandidate.set(frame);
  }

  confirmLiveCandidate(): void {
    const point = this.livePoint();
    if (!point || this.liveCandidate()?.status !== 'candidate') return;
    if (Date.now() - this.visualReceivedAt > 10000) {
      this.message.set(
        'The live visual candidate is older than 10 seconds. Wait for a fresh match or select and confirm a known reference manually.',
      );
      return;
    }
    this.pause('Motion sensors stopped while confirming the live visual reference.');
    this.phase.set('indoor');
    this.anchorId = point.id;
    this.selectedNode.set(point.id);
    this.confirmAnchor();
    this.message.set(
      'Live visual reference manually confirmed by you. Calibrate facing and measured distance to resume step estimates.',
    );
  }

  changeZoom(delta: number): void {
    this.zoom = Math.max(1, Math.min(4, Math.round((this.zoom + delta) * 2) / 2));
  }

  selectReference(id: string): void {
    if (this.phase() === 'outdoor') {
      this.pause('Reviewing stored map evidence. Start GPS again for a real arrival test.');
      this.phase.set('indoor');
    }
    this.selectedNode.set(id);
    this.showReferenceNodes = true;
  }

  async loadReplay(): Promise<void> {
    if (this.replayBusy()) return;
    this.replayBusy.set(true);
    this.replayMessage.set('Loading stored video matching evidence…');
    try {
      const response = await fetch('/experiments/old-node-replay.json', {
        signal: this.abort.signal,
      });
      if (!response.ok) throw new Error('Video evidence is not available in this local build yet.');
      const replay = (await response.json()) as VideoReplay;
      if (
        !replay.video ||
        !Number.isFinite(replay.video.durationSeconds) ||
        replay.video.durationSeconds < 0 ||
        !Array.isArray(replay.frames) ||
        !replay.frames.every(
          (frame) =>
            Number.isFinite(frame.timeSeconds) &&
            frame.timeSeconds >= 0 &&
            ['candidate', 'uncertain'].includes(frame.status) &&
            (frame.nodeId === null || this.plan()?.nodes.some((node) => node.id === frame.nodeId)),
        )
      )
        throw new Error('Video evidence does not match the stored node map.');
      if (this.destroyed) return;
      replay.frames.sort((a, b) => a.timeSeconds - b.timeSeconds);
      this.replay.set(replay);
      this.replayTime = 0;
      this.seekReplay(0);
      this.replayMessage.set(
        'Offline evidence only. Candidates do not move the live sensor estimate.',
      );
    } catch (error) {
      if (!this.destroyed) this.replayMessage.set(this.error(error));
    } finally {
      this.replayBusy.set(false);
    }
  }

  seekReplay(time: number): void {
    this.replayTime = Number(time);
    // Only the latest observed frame is eligible: never display a future visual fix.
    const frame =
      this.replay()
        ?.frames.filter((frame) => frame.timeSeconds <= this.replayTime)
        .at(-1) ?? null;
    this.replayFrame.set(frame);
  }

  videoTime(event: Event): void {
    this.seekReplay((event.target as HTMLVideoElement).currentTime);
  }

  confirmVideoCandidate(): void {
    const point = this.replayPoint();
    if (!point || this.replayFrame()?.status === 'uncertain') return;
    this.pause('Sensors stopped while confirming a video reference.');
    this.phase.set('indoor');
    this.anchorId = point.id;
    this.selectedNode.set(point.id);
    this.confirmAnchor();
    this.message.set(
      'Video candidate manually confirmed by you as the current reference. Recalibrate before live motion; offline replay is not a live location.',
    );
  }

  private session(mode: 'gps' | 'motion'): NavigationSensors {
    const epoch = ++this.epoch;
    this.mode.set(mode);
    const valid = () => !this.destroyed && epoch === this.epoch && !document.hidden;
    this.sensors = new NavigationSensors({
      location: (value) => {
        if (valid() && this.mode() === 'gps') this.receiveLocation(value);
      },
      heading: (value) => {
        if (
          valid() &&
          this.mode() === 'motion' &&
          Number.isFinite(value.degrees) &&
          Number.isFinite(value.timestamp) &&
          Date.now() - value.timestamp <= 2000 &&
          value.timestamp - Date.now() <= 1000
        )
          this.heading.set(value);
      },
      steps: (value) => {
        if (valid() && this.mode() === 'motion') this.receiveSteps(value);
      },
      state: (value) => {
        if (valid()) this.message.set(value.message);
      },
    });
    return this.sensors;
  }

  async startGps(): Promise<void> {
    if (!this.plan() || this.mode() !== 'idle' || !this.validDestination()) return;
    this.gate.reset();
    const sensors = this.session('gps');
    const epoch = this.epoch;
    this.message.set('Waiting for two fresh, accurate GPS fixes inside the arrival area…');
    try {
      await sensors.startLocation();
    } catch (error) {
      if (epoch === this.epoch) this.pause(this.error(error));
    }
  }

  private validDestination(): boolean {
    if (
      ![this.latitude, this.longitude, this.radius].every(Number.isFinite) ||
      Math.abs(this.latitude) > 90 ||
      Math.abs(this.longitude) > 180 ||
      this.radius < 25 ||
      this.radius > 200
    ) {
      this.message.set(
        'Enter valid latitude/longitude and an arrival radius from 25 to 200 metres.',
      );
      return false;
    }
    return true;
  }

  receiveLocation(value: LocationReading, now = Date.now()): void {
    this.fix.set(value);
    const plan = this.plan();
    if (!plan) return;
    if (
      this.gate.update(
        value,
        { ...plan.outdoor, lat: this.latitude, lng: this.longitude, radiusM: this.radius },
        now,
      )
    )
      this.enterIndoor();
  }

  private enterIndoor(): void {
    const simulation = this.mode() === 'simulation';
    this.stopSensors();
    this.mode.set(simulation ? 'simulation' : 'idle');
    this.phase.set('indoor');
    this.confirmed.set(false);
    this.calibrated.set(false);
    this.anchorId = this.plan()!.entryId;
    this.estimate!.anchor(this.anchorId);
    this.trail.set([]);
    this.refreshPosition();
    this.message.set(
      simulation
        ? 'SIMULATION: arrival triggered the Level 1 map. No real location was detected.'
        : 'GPS proximity estimate: showing Level 1 at Point 19. Confirm the actual entrance before estimating indoor movement.',
    );
  }

  confirmAnchor(): void {
    if (!this.estimate) return;
    this.estimate.anchor(this.anchorId);
    this.chooseNearestCalibrationTarget();
    this.confirmed.set(true);
    this.calibrated.set(false);
    this.baseline = this.mode() === 'motion' ? this.baseline : null;
    this.trail.set([]);
    this.refreshPosition();
    this.message.set(
      'Reference point confirmed by you. Start motion, face the first corridor toward your chosen point, then calibrate using a measured distance.',
    );
  }

  private chooseNearestCalibrationTarget(): void {
    this.targetId =
      this.photoStops()
        .map((point) => ({
          id: point.id,
          distance: this.estimate?.pathTo(point.id)?.distance ?? Infinity,
        }))
        .filter((point) => Number.isFinite(point.distance))
        .sort((a, b) => a.distance - b.distance)[0]?.id ?? '';
  }

  async startMotion(): Promise<void> {
    if (!this.confirmed() || this.mode() !== 'idle') return;
    this.heading.set(null);
    this.baseline = 0;
    this.lastStepTime = 0;
    const sensors = this.session('motion');
    const epoch = this.epoch;
    this.message.set(
      'Requesting foreground motion permission. Keep the phone facing along the corridor.',
    );
    try {
      await sensors.startMotion();
    } catch (error) {
      if (epoch === this.epoch) this.pause(this.error(error));
    }
  }

  calibrate(): void {
    const heading = this.heading();
    if (
      this.mode() !== 'motion' ||
      !this.confirmed() ||
      !heading ||
      !Number.isFinite(heading.degrees) ||
      !Number.isFinite(heading.timestamp) ||
      Date.now() - heading.timestamp > 2000 ||
      heading.timestamp - Date.now() > 1000
    ) {
      this.message.set('Start motion and wait for a fresh heading before calibration.');
      return;
    }
    try {
      this.estimate!.calibrate(this.targetId, Number(this.measuredMetres), heading.degrees);
      this.calibrated.set(true);
      this.message.set(
        'Calibrated from your measured distance and current facing direction. Movement is approximate; re-anchor regularly.',
      );
      this.refreshPosition();
    } catch (error) {
      this.message.set(this.error(error));
    }
  }

  receiveSteps(value: StepsReading): void {
    if (
      !Number.isInteger(value.total) ||
      !Number.isFinite(value.timestamp) ||
      value.total < 0 ||
      value.timestamp <= this.lastStepTime ||
      Date.now() - value.timestamp > 3000 ||
      value.timestamp - Date.now() > 1000
    )
      return;
    this.lastStepTime = value.timestamp;
    const previous = this.baseline;
    this.baseline = value.total;
    if (previous === null || value.total < previous) return;
    const delta = value.total - previous;
    const heading = this.heading();
    if (
      !this.calibrated() ||
      !heading ||
      !Number.isFinite(heading.degrees) ||
      !Number.isFinite(heading.timestamp) ||
      Date.now() - heading.timestamp > 2000 ||
      heading.timestamp - Date.now() > 1000
    ) {
      if (delta > 0)
        this.message.set('Step ignored: a fresh heading and measured calibration are required.');
      return;
    }
    if (!Number.isInteger(delta) || delta > 10) {
      this.message.set('Large sensor jump ignored. Re-anchor if you moved while paused.');
      return;
    }
    for (let i = 0; i < delta; i++) this.advance(heading.degrees);
  }

  private advance(degrees: number): void {
    const result = this.estimate!.step(degrees, this.stride);
    this.message.set(`${this.mode() === 'simulation' ? 'SIMULATION: ' : ''}${result.reason}`);
    this.refreshPosition();
    if (result.advanced)
      this.trail.update((trail) => [...trail.slice(-199), { ...result.position }]);
  }

  private refreshPosition(): void {
    if (!this.estimate) return;
    this.position.set({ ...this.estimate.position });
    this.count.set(this.estimate.steps);
    this.uncertainty.set(this.estimate.uncertaintyM);
    this.nearby.set(this.estimate.nearbyPlaces());
  }

  simulateArrival(): void {
    if (!this.plan() || !this.validDestination()) return;
    this.pause('Starting simulation.');
    this.mode.set('simulation');
    this.phase.set('outdoor');
    this.gate.reset();
    const now = Date.now();
    this.receiveLocation(
      { lat: this.latitude + 0.01, lng: this.longitude, accuracy: 5, timestamp: now - 5000 },
      now - 5000,
    );
    this.receiveLocation(
      { lat: this.latitude, lng: this.longitude, accuracy: 5, timestamp: now - 2001 },
      now - 2001,
    );
    this.receiveLocation(
      { lat: this.latitude, lng: this.longitude, accuracy: 5, timestamp: now },
      now,
    );
  }

  calibrateDemo(): void {
    if (this.mode() !== 'simulation' || !this.estimate) return;
    this.confirmAnchor();
    const path = this.estimate.pathTo(this.targetId);
    if (!path) {
      this.message.set('Select a connected point for the simulation.');
      return;
    }
    this.estimate.calibrate(this.targetId, path.distance * 0.1, 0);
    this.demoHeading = 0;
    this.calibrated.set(true);
    this.refreshPosition();
    this.message.set(
      'SIMULATION: synthetic scale 0.1 m per SVG unit and synthetic heading 0°. These are not surveyed values.',
    );
  }

  demoStep(): void {
    if (this.mode() === 'simulation' && this.calibrated()) this.advance(this.demoHeading);
  }
  demoTurn(): void {
    if (this.mode() === 'simulation') {
      this.demoHeading = (this.demoHeading + 90) % 360;
      this.message.set(
        `SIMULATION: synthetic heading ${this.demoHeading}°. The graph may hold position when no corridor matches.`,
      );
    }
  }

  pause(message = 'Stopped. Confirm your reference point and recalibrate before resuming.'): void {
    this.stopSensors();
    this.mode.set('idle');
    this.confirmed.set(false);
    this.calibrated.set(false);
    this.heading.set(null);
    this.baseline = null;
    this.message.set(message);
  }

  resetOutdoor(): void {
    this.pause();
    this.phase.set('outdoor');
    this.fix.set(null);
    this.gate.reset();
  }
  private stopSensors(): void {
    this.epoch++;
    const sensors = this.sensors;
    this.sensors = null;
    if (sensors) void sensors.dispose().catch(() => undefined);
  }
  private error(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'Sensor access failed. Check device permissions.';
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    this.abort.abort();
    this.stopSensors();
    document.removeEventListener('visibilitychange', this.visibility);
    window.removeEventListener('orientationchange', this.orientation);
  }
}
