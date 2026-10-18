import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IndoorPoseSession, type IOSCapturedPoseFrame } from './indoor-pose';
import { IOSPoseModel, type IOSPose, type IOSPoseResult } from './ios-pose-model';
import { IOSVisualMatcher } from './ios-visual-match';
import type { CameraCandidate } from './camera-lab';
import { gap, type LabPlan } from './movement-model';

@Component({
  selector: 'app-ios-pose-lab',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './ios-pose-lab.html',
  styleUrl: './ios-pose-lab.scss',
})
export class IOSPoseLab implements OnInit, OnDestroy {
  readonly plan = signal<LabPlan | null>(null);
  readonly active = signal(false);
  readonly busy = signal(false);
  readonly message = signal('ARKit is off. This test uses the iPhone camera and motion together.');
  readonly pose = signal<IOSPose | null>(null);
  readonly result = signal<IOSPoseResult | null>(null);
  readonly firstSaved = signal(false);
  readonly candidate = signal<CameraCandidate | null>(null);
  readonly framePreview = signal('');
  readonly visualMessage = signal('Visual checks are off. No full video is saved.');
  readonly visualOn = signal(false);
  readonly stops = computed(
    () => this.plan()?.nodes.filter((node) => /^Point \d+$/.test(node.label)) ?? [],
  );
  readonly nearby = computed(() => {
    const position = this.result()?.position;
    if (!position) return [];
    const scale = this.result()?.metresPerUnit;
    return [...(this.plan()?.nearby ?? [])]
      .sort((a, b) => gap(a, position) - gap(b, position))
      .slice(0, 4)
      .map((place) => ({
        label: place.label,
        metres: scale ? gap(place, position) * scale : null,
      }));
  });
  readonly candidateLabel = computed(() => {
    const candidate = this.candidate();
    return (
      this.plan()?.nodes.find((node) => node.id === candidate?.nodeId)?.label ??
      candidate?.label ??
      ''
    );
  });
  firstId = '';
  secondId = '';
  zoom = 1;
  origin = 'https://f63b-138-51-70-213.ngrok-free.app';
  readonly sensors = new IndoorPoseSession({
    pose: (value) => this.receivePose(value),
    status: (value) => {
      if (!this.active()) return;
      if (value.tracking === 'unavailable') {
        void this.stop(
          'ARKit unavailable: ' + value.message + '. Restart and register both points again.',
        );
      } else {
        this.message.set(
          value.message ||
            'Camera tracking is normal. Register known points or continue along the corridor.',
        );
        if (value.tracking === 'limited') {
          this.model?.reset();
          this.result.set(null);
          this.firstSaved.set(false);
          this.stopVisual();
        }
      }
    },
  });
  private model: IOSPoseModel | null = null;
  private matcher: IOSVisualMatcher | null = null;
  private frame: IOSCapturedPoseFrame | null = null;
  private generation = 0;
  private visualGeneration = 0;
  private visualTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private readonly abort = new AbortController();
  private readonly hidden = () => {
    if (document.hidden)
      void this.stop(
        'Paused while the app is hidden. Register two anchors again after restarting.',
      );
  };
  private readonly pagehide = () => {
    void this.stop('ARKit stopped.');
  };

  async ngOnInit(): Promise<void> {
    document.addEventListener('visibilitychange', this.hidden);
    window.addEventListener('pagehide', this.pagehide);
    try {
      const response = await fetch('/experiments/entrance-node19.json', {
        signal: this.abort.signal,
      });
      if (!response.ok) throw new Error('The saved Level 1 map could not be loaded.');
      const plan = (await response.json()) as LabPlan;
      if (this.destroyed) return;
      this.plan.set(plan);
      this.model = new IOSPoseModel(plan);
      this.firstId = plan.entryId;
    } catch (error) {
      if (!this.destroyed)
        this.message.set(error instanceof Error ? error.message : 'Map unavailable.');
    }
  }
  async start(): Promise<void> {
    if (this.active() || !this.model) return;
    const generation = ++this.generation;
    this.active.set(true);
    this.busy.set(true);
    this.model.reset();
    this.result.set(null);
    this.pose.set(null);
    this.firstSaved.set(false);
    this.message.set(
      'Requesting camera permission. Slowly move the phone while ARKit finds visual features.',
    );
    try {
      await this.sensors.start();
      if (this.destroyed || generation !== this.generation || !this.active()) return;
      this.watchdog = setInterval(() => {
        const pose = this.pose();
        if (pose && this.active() && this.model?.registered && Date.now() - pose.timestamp > 1000)
          this.updateResult(this.model.project(pose, Date.now()));
      }, 1000);
    } catch (error) {
      if (generation === this.generation)
        await this.stop(error instanceof Error ? error.message : 'ARKit could not start.');
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }
  receivePose(pose: IOSPose): void {
    if (!this.active() || this.destroyed || document.hidden) return;
    const previous = this.pose();
    this.pose.set(pose);
    if (pose.tracking !== 'normal' || (previous && previous.epoch !== pose.epoch)) {
      this.model?.reset();
      this.firstSaved.set(false);
      this.result.set(null);
      this.candidate.set(null);
      this.frame = null;
      this.message.set(
        'Tracking interrupted. Wait for normal tracking, then register both points again.',
      );
    } else if (this.model?.registered) this.updateResult(this.model.project(pose, Date.now()));
  }
  private updateResult(result: IOSPoseResult): void {
    this.result.set(result);
    if (result.status === 'anchor-required') {
      this.firstSaved.set(false);
      this.stopVisual();
    }
  }
  saveFirst(): void {
    this.stopVisual();
    const pose = this.pose();
    if (!pose || !this.active() || !this.model) return;
    const result = this.model.firstAnchor(this.firstId, pose, Date.now());
    this.updateResult(result);
    this.firstSaved.set(result.status === 'unregistered');
    this.message.set(result.reason);
  }
  saveSecond(): void {
    this.stopVisual();
    const pose = this.pose();
    if (!pose || !this.active() || !this.model) return;
    const result = this.model.secondAnchor(this.secondId, pose, Date.now());
    this.updateResult(result);
    this.message.set(result.reason);
  }
  changeZoom(amount: number): void {
    this.zoom = Math.min(4, Math.max(1, this.zoom + amount));
  }
  resetRegistration(): void {
    this.stopVisual();
    this.model?.reset();
    this.result.set(null);
    this.firstSaved.set(false);
    this.message.set(
      'Starting point changed. Confirm the first point and register a second known point again.',
    );
  }
  async toggleVisual(): Promise<void> {
    if (this.visualOn()) {
      this.stopVisual();
      return;
    }
    if (!this.active() || !this.model?.registered) {
      this.visualMessage.set('Register two known points before requesting visual corrections.');
      return;
    }
    const generation = ++this.visualGeneration;
    this.visualOn.set(true);
    this.visualMessage.set('Connecting to the reference matching service…');
    try {
      const matcher = new IOSVisualMatcher(this.origin);
      this.matcher = matcher;
      await matcher.start();
      if (generation !== this.visualGeneration || !this.visualOn()) return;
      await this.matchFrame(generation);
    } catch (error) {
      if (generation === this.visualGeneration) {
        this.stopVisual();
        this.visualMessage.set(
          error instanceof Error ? error.message : 'Visual matching unavailable.',
        );
      }
    }
  }
  private async matchFrame(generation: number): Promise<void> {
    if (!this.visualOn() || generation !== this.visualGeneration || !this.active() || !this.matcher)
      return;
    try {
      const frame = await this.sensors.captureFrame();
      if (generation !== this.visualGeneration || !this.active()) return;
      this.framePreview.set(`data:image/jpeg;base64,${frame.jpegBase64}`);
      const candidate = await this.matcher.match(frame);
      if (generation !== this.visualGeneration || !this.active()) return;
      const latest = this.pose();
      if (!latest || latest.epoch !== frame.epoch || Date.now() - frame.timestamp > 3000) {
        this.candidate.set(null);
        this.frame = null;
        this.visualMessage.set(
          'This match arrived too late or the AR session changed. Position held.',
        );
      } else {
        this.candidate.set(candidate);
        this.frame = frame;
        this.visualMessage.set(
          candidate.status === 'candidate'
            ? 'Candidate only: confirm immediately if the photo matches this known point. It expires after 3 seconds.'
            : 'Ambiguous frame. Position held.',
        );
      }
    } catch (error) {
      if (generation !== this.visualGeneration) return;
      this.visualMessage.set(error instanceof Error ? error.message : 'Frame matching failed.');
    }
    if (generation === this.visualGeneration && this.visualOn())
      this.visualTimer = setTimeout(() => void this.matchFrame(generation), 2500);
  }
  confirmVisual(): void {
    const candidate = this.candidate(),
      frame = this.frame,
      latest = this.pose(),
      now = Date.now();
    if (
      !candidate ||
      candidate.status !== 'candidate' ||
      !candidate.nodeId ||
      !frame ||
      !latest ||
      !this.model?.registered ||
      latest.tracking !== 'normal' ||
      latest.epoch !== frame.epoch ||
      now - frame.timestamp > 3000 ||
      now - frame.timestamp < 0 ||
      now - latest.timestamp > 1500
    ) {
      this.visualMessage.set('Candidate expired or tracking is unavailable. Position held.');
      return;
    }
    const pairedPose: IOSPose = {
      ...frame.pose,
      timestamp: frame.timestamp,
      monotonicSeconds: frame.monotonicSeconds,
      epoch: frame.epoch,
      tracking: 'normal',
    };
    const correction = this.model.confirm(candidate.nodeId, pairedPose, frame.timestamp);
    this.updateResult(correction);
    if (correction.status === 'registered' || correction.status === 'tracking') {
      this.updateResult(this.model.project(latest, now));
      this.visualMessage.set(
        'Visual reference confirmed. Showing the latest AR pose relative to that captured frame.',
      );
    } else this.visualMessage.set(correction.reason);
    this.candidate.set(null);
    this.frame = null;
  }
  stopVisual(): void {
    this.visualGeneration++;
    this.visualOn.set(false);
    if (this.visualTimer !== null) clearTimeout(this.visualTimer);
    this.visualTimer = null;
    this.matcher?.dispose();
    this.matcher = null;
    this.candidate.set(null);
    this.frame = null;
    this.framePreview.set('');
    this.visualMessage.set('Visual checks stopped. No full video was saved.');
  }
  async stop(
    message = 'ARKit stopped. Register two known points again after restarting.',
  ): Promise<void> {
    this.generation++;
    this.active.set(false);
    this.busy.set(false);
    this.stopVisual();
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    this.model?.reset();
    this.result.set(null);
    this.pose.set(null);
    this.firstSaved.set(false);
    this.message.set(message);
    await this.sensors.stop();
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    this.abort.abort();
    void this.stop();
    void this.sensors.dispose();
    document.removeEventListener('visibilitychange', this.hidden);
    window.removeEventListener('pagehide', this.pagehide);
  }
}
