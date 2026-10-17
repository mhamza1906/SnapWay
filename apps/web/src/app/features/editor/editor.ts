import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  HostListener,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MapDocument, Room, SceneReference } from '../../core/prototype.models';
import { PrototypeRepository } from '../../core/prototype.repository';
import { Icon } from '../../shared/icon';
import { MapCanvas } from '../../shared/map-canvas';

type EditorTool = 'select' | 'room' | 'label' | 'pin' | 'waypoint' | 'connect';
type AiState = 'idle' | 'running' | 'proposal' | 'error' | 'clarification' | 'cancelled';
const emptyDocument = (): MapDocument => ({
  rooms: [],
  nodes: [],
  edges: [],
  annotations: [],
  references: [],
});

@Component({
  selector: 'app-editor-page',
  imports: [RouterLink, ReactiveFormsModule, Icon, MapCanvas],
  templateUrl: './editor.html',
  styleUrls: [
    './editor.scss',
    './editor-layers.scss',
    './editor-canvas.scss',
    './editor-inspector.scss',
    './editor-references.scss',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorPage {
  readonly repository = inject(PrototypeRepository);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly forms = inject(FormBuilder);
  private readonly params = toSignal(this.route.paramMap, {
    initialValue: this.route.snapshot.paramMap,
  });
  readonly id = computed(() => this.params().get('id') ?? '');
  readonly contribution = computed(() => this.repository.getContribution(this.id()));
  readonly target = computed(() => {
    const item = this.contribution();
    return item ? this.repository.getTarget(item.targetId) : undefined;
  });
  readonly document = signal<MapDocument>(emptyDocument());
  readonly selected = signal('');
  readonly selectedRoom = computed(() =>
    this.document().rooms.find((room) => room.id === this.selected()),
  );
  readonly selectedNode = computed(() =>
    this.document().nodes.find((node) => node.id === this.selected()),
  );
  readonly selectedEdge = computed(() =>
    this.document().edges.find((edge) => edge.id === this.selected()),
  );
  readonly selectedAnnotation = computed(() =>
    this.document().annotations.find((annotation) => annotation.id === this.selected()),
  );
  readonly selectedKind = computed(() =>
    this.selectedRoom()
      ? 'Room'
      : this.selectedNode()
        ? 'Waypoint'
        : this.selectedEdge()
          ? 'Connection'
          : this.selectedAnnotation()
            ? 'Annotation'
            : '',
  );
  readonly readonly = computed(() => {
    const item = this.contribution();
    return (
      !item ||
      !['draft', 'changes-requested'].includes(item.status) ||
      this.target()?.status === 'archived' ||
      item.author !== this.repository.profile().name
    );
  });
  readonly dirty = signal(false);
  readonly version = signal(0);
  readonly editSequence = signal(0);
  readonly history = signal<MapDocument[]>([]);
  readonly future = signal<MapDocument[]>([]);
  readonly tool = signal<EditorTool>('select');
  readonly tab = signal<'map' | 'references'>('map');
  readonly layer = signal<'vector' | 'source' | 'standardized'>('vector');
  readonly zoom = signal(100);
  readonly opacity = signal(45);
  readonly rotation = signal(0);
  readonly showSource = signal(false);
  readonly connectionStart = signal('');
  readonly message = signal('');
  readonly error = signal('');
  readonly sidePanel = signal<'properties' | 'assistant'>('properties');
  readonly submitOpen = signal(false);
  readonly uploading = signal(false);
  readonly tools: { id: EditorTool; icon: string; label: string }[] = [
    { id: 'select', icon: 'eye', label: 'Select object' },
    { id: 'room', icon: 'map', label: 'Add room' },
    { id: 'label', icon: 'edit', label: 'Add text' },
    { id: 'pin', icon: 'pin', label: 'Add marker' },
    { id: 'waypoint', icon: 'plus', label: 'Add waypoint' },
    { id: 'connect', icon: 'route', label: 'Connect waypoints' },
  ];
  readonly properties = this.forms.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    kind: ['classroom'],
    x: [0],
    y: [0],
    width: [180],
    height: [160],
    accessible: [true],
    blocked: [false],
    roomId: [''],
    from: [''],
    to: [''],
  });
  readonly summary = this.forms.nonNullable.control('', [
    Validators.required,
    Validators.minLength(8),
    Validators.maxLength(500),
  ]);
  readonly prompt = this.forms.nonNullable.control('', [
    Validators.required,
    Validators.maxLength(500),
  ]);
  readonly aiState = signal<AiState>('idle');
  readonly aiStep = signal(0);
  readonly aiDescription = signal('');
  readonly aiProposal = signal<MapDocument | null>(null);
  readonly aiFailure = signal(false);
  private aiSequence = 0;
  private aiBaseSequence = 0;
  private aiBaseVersion = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  readonly referenceImage = signal('');
  readonly referenceId = signal('');
  readonly referenceBusy = signal(false);
  readonly referenceAnalysis = signal('');
  private referenceSequence = 0;
  readonly referenceForm = this.forms.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    nodeId: ['', Validators.required],
    direction: ['Unknown'],
    description: ['', [Validators.required, Validators.maxLength(600)]],
    reviewed: [false],
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.load(id));
    });
    effect(() => {
      const room = this.selectedRoom();
      const node = this.selectedNode();
      const edge = this.selectedEdge();
      const annotation = this.selectedAnnotation();
      this.properties.reset({
        name: room?.name ?? node?.label ?? annotation?.text ?? 'Connection',
        kind: room?.kind ?? 'classroom',
        x: room?.x ?? node?.x ?? annotation?.x ?? 0,
        y: room?.y ?? node?.y ?? annotation?.y ?? 0,
        width: room?.width ?? 180,
        height: room?.height ?? 160,
        accessible: room?.accessible ?? edge?.accessible ?? true,
        blocked: edge?.blocked ?? false,
        roomId: node?.roomId ?? '',
        from: edge?.from ?? '',
        to: edge?.to ?? '',
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.aiSequence++;
      this.referenceSequence++;
      this.timers.forEach(clearTimeout);
    });
  }

  @HostListener('window:beforeunload', ['$event'])
  beforeUnload(event: BeforeUnloadEvent): void {
    if (this.dirty()) event.preventDefault();
  }

  canLeave(): boolean {
    return !this.dirty() || window.confirm('Leave without saving your map changes?');
  }

  private load(id: string): void {
    const item = this.repository.getContribution(id);
    this.aiSequence++;
    this.referenceSequence++;
    this.document.set(item ? structuredClone(item.document) : emptyDocument());
    this.version.set(item?.version ?? 0);
    this.selected.set('');
    this.history.set([]);
    this.future.set([]);
    this.dirty.set(false);
    this.editSequence.set(0);
    this.aiState.set('idle');
    this.aiProposal.set(null);
    this.error.set('');
    this.message.set('');
    this.resetReference();
  }

  setTool(tool: EditorTool): void {
    if (this.readonly() && tool !== 'select') return;
    this.tool.set(tool);
    this.connectionStart.set('');
    if (tool !== 'select')
      this.message.set(
        tool === 'connect'
          ? 'Select two waypoints to connect them.'
          : 'Click the floor plan to place your new object.',
      );
  }

  select(id: string): void {
    if (this.tool() === 'connect' && !this.readonly()) {
      if (!this.document().nodes.some((node) => node.id === id)) {
        this.message.set('Select a waypoint, shown as a small circle.');
        return;
      }
      if (!this.connectionStart()) {
        this.connectionStart.set(id);
        this.selected.set(id);
        this.message.set('Now select the second waypoint.');
        return;
      }
      const from = this.connectionStart();
      if (from === id) return;
      if (
        this.document().edges.some(
          (edge) =>
            (edge.from === from && edge.to === id) || (edge.from === id && edge.to === from),
        )
      ) {
        this.error.set('These waypoints are already connected.');
        return;
      }
      const edgeId = this.newId('edge');
      this.change((doc) =>
        doc.edges.push({ id: edgeId, from, to: id, accessible: true, blocked: false }),
      );
      this.setTool('select');
      this.selected.set(edgeId);
      this.message.set('Walking connection added. Check accessibility in the inspector.');
      return;
    }
    if (this.tool() === 'select') {
      this.selected.set(id);
      this.sidePanel.set('properties');
    }
  }

  place(point: { x: number; y: number }): void {
    if (this.readonly() || ['select', 'connect'].includes(this.tool())) return;
    const type = this.tool();
    const id = this.newId(type);
    this.change((doc) => {
      if (type === 'room')
        doc.rooms.push({
          id,
          name: 'New room',
          kind: 'classroom',
          x: Math.min(point.x, 800),
          y: Math.min(point.y, 480),
          width: 180,
          height: 140,
          accessible: true,
        });
      else if (type === 'waypoint') doc.nodes.push({ id, label: 'New waypoint', ...point });
      else
        doc.annotations.push({
          id,
          text: type === 'pin' ? 'New landmark' : 'New label',
          type: type === 'pin' ? 'pin' : 'label',
          ...point,
        });
    });
    this.setTool('select');
    this.selected.set(id);
    this.sidePanel.set('properties');
    this.message.set('Object added. Update its details in the inspector.');
  }

  private newId(prefix: string): string {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private change(mutate: (document: MapDocument) => void): void {
    if (this.readonly()) {
      this.error.set('This contribution is read only. Create or reopen a draft before editing.');
      return;
    }
    const current = this.document();
    const next = structuredClone(current);
    mutate(next);
    this.history.update((items) => [...items.slice(-29), structuredClone(current)]);
    this.future.set([]);
    this.document.set(next);
    this.dirty.set(true);
    this.editSequence.update((value) => value + 1);
    this.error.set('');
  }

  undo(): void {
    if (this.readonly() || !this.history().length) return;
    const history = this.history();
    this.future.update((items) => [...items, this.document()]);
    this.document.set(history[history.length - 1]);
    this.history.set(history.slice(0, -1));
    this.dirty.set(true);
    this.editSequence.update((value) => value + 1);
    this.message.set('Last change undone.');
  }

  redo(): void {
    if (this.readonly() || !this.future().length) return;
    const future = this.future();
    this.history.update((items) => [...items, this.document()]);
    this.document.set(future[future.length - 1]);
    this.future.set(future.slice(0, -1));
    this.dirty.set(true);
    this.editSequence.update((value) => value + 1);
    this.message.set('Change restored.');
  }

  applyProperties(): void {
    if (this.properties.invalid || this.readonly()) {
      this.properties.markAllAsTouched();
      return;
    }
    const value = this.properties.getRawValue();
    if (!this.selectedEdge() && !value.name.trim()) {
      this.error.set('Enter a name or label containing visible text.');
      return;
    }
    if (
      ![value.x, value.y, value.width, value.height].every(Number.isFinite) ||
      value.x < 0 ||
      value.x > 1000 ||
      value.y < 0 ||
      value.y > 640 ||
      value.width < 24 ||
      value.height < 24 ||
      (this.selectedRoom() && (value.x + value.width > 1000 || value.y + value.height > 640))
    ) {
      this.error.set(
        'Keep the object inside the 1000 × 640 map, with room dimensions of at least 24.',
      );
      return;
    }
    if (
      this.selectedEdge() &&
      (value.from === value.to ||
        !this.document().nodes.some((node) => node.id === value.from) ||
        !this.document().nodes.some((node) => node.id === value.to))
    ) {
      this.error.set('Choose two different existing waypoints.');
      return;
    }
    if (
      this.selectedEdge() &&
      this.document().edges.some(
        (edge) =>
          edge.id !== this.selected() &&
          ((edge.from === value.from && edge.to === value.to) ||
            (edge.from === value.to && edge.to === value.from)),
      )
    ) {
      this.error.set('This connection already exists.');
      return;
    }
    this.change((doc) => {
      const room = doc.rooms.find((item) => item.id === this.selected());
      const node = doc.nodes.find((item) => item.id === this.selected());
      const edge = doc.edges.find((item) => item.id === this.selected());
      const annotation = doc.annotations.find((item) => item.id === this.selected());
      if (room) {
        for (const waypoint of doc.nodes) {
          if (waypoint.roomId === room.id && waypoint.label === room.name)
            waypoint.label = value.name.trim();
        }
        Object.assign(room, {
          name: value.name.trim(),
          kind: value.kind as Room['kind'],
          x: value.x,
          y: value.y,
          width: value.width,
          height: value.height,
          accessible: value.accessible,
        });
      }
      if (node)
        Object.assign(node, {
          label: value.name.trim(),
          x: value.x,
          y: value.y,
          roomId: value.roomId || undefined,
        });
      if (edge)
        Object.assign(edge, {
          from: value.from,
          to: value.to,
          accessible: value.accessible,
          blocked: value.blocked,
        });
      if (annotation)
        Object.assign(annotation, { text: value.name.trim(), x: value.x, y: value.y });
    });
    this.message.set('Object properties updated.');
  }

  removeSelected(): void {
    const id = this.selected();
    if (!id || this.readonly()) return;
    if (this.document().references.some((reference) => reference.nodeId === id)) {
      this.error.set(
        'Reassign or remove the reference photos associated with this waypoint first.',
      );
      return;
    }
    this.change((doc) => {
      doc.rooms = doc.rooms.filter((room) => room.id !== id);
      doc.nodes = doc.nodes
        .filter((node) => node.id !== id)
        .map((node) => (node.roomId === id ? { ...node, roomId: undefined } : node));
      doc.edges = doc.edges.filter((edge) => edge.id !== id && edge.from !== id && edge.to !== id);
      doc.annotations = doc.annotations.filter((annotation) => annotation.id !== id);
    });
    this.selected.set('');
    this.message.set('Object removed. Undo is available.');
  }

  save(): boolean {
    if (this.readonly()) return false;
    try {
      const item = this.repository.saveDraft(this.id(), this.document(), this.version());
      this.version.set(item.version);
      this.dirty.set(false);
      this.error.set('');
      this.message.set('Draft saved on this device.');
      return true;
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not save this draft.');
      return false;
    }
  }

  reloadSaved(): void {
    if (this.dirty() && !window.confirm('Discard your unsaved changes and reload the saved draft?'))
      return;
    this.load(this.id());
    this.message.set('Latest saved version loaded.');
  }

  async downloadSample(): Promise<void> {
    try {
      const sample = new Image();
      sample.src = '/demo/floor-plan.svg';
      await sample.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 640;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image download is unavailable in this browser.');
      context.drawImage(sample, 0, 0, 1000, 640);
      const link = document.createElement('a');
      link.download = 'snapway-sample-floor-plan.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
      this.message.set(
        'Sample PNG downloaded. You can upload it as a source plan or test reference.',
      );
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not download the sample.');
    }
  }

  openSubmit(): void {
    this.error.set('');
    this.submitOpen.set(true);
    this.timers.push(
      setTimeout(
        () => document.querySelector<HTMLTextAreaElement>('.submit-dialog textarea')?.focus(),
        0,
      ),
    );
  }

  closeSubmit(): void {
    this.submitOpen.set(false);
    document.getElementById('submit-open')?.focus();
  }

  trapSubmitFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLElement;
    const elements = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), textarea, input, select, a[href]',
      ),
    ];
    const first = elements[0],
      last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  submit(): void {
    if (this.summary.invalid) {
      this.summary.markAsTouched();
      return;
    }
    if (this.dirty() && !this.save()) return;
    try {
      this.repository.submit(this.id(), this.summary.value.trim());
      this.submitOpen.set(false);
      this.message.set('Contribution submitted. It is now read only while it is reviewed.');
      void this.router.navigate(['/review', this.id()]);
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'Could not submit this contribution.',
      );
    }
  }

  async upload(event: Event, purpose: 'source' | 'reference'): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.readonly()) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      this.error.set('Choose a PNG, JPEG or WebP image. SVG uploads are not supported.');
      return;
    }
    if (file.size > 1024 * 1024) {
      this.error.set('Choose an image smaller than 1 MB for this local prototype.');
      return;
    }
    this.uploading.set(true);
    const contributionId = this.id();
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('The image could not be read. Try another file.'));
        reader.readAsDataURL(file);
      });
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('This file is not a readable image.'));
        image.src = data;
      });
      if (contributionId !== this.id() || this.readonly()) return;
      if (purpose === 'source') {
        this.change((doc) => {
          doc.sourceImage = data;
          delete doc.standardizedImage;
        });
        this.layer.set('source');
        this.message.set(
          'Source image attached. Use the assistant for a simulated standardization or trace.',
        );
      } else {
        this.referenceImage.set(data);
        this.referenceForm.patchValue({ name: file.name.replace(/\.[^.]+$/, '') });
      }
      this.error.set('');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Image upload failed.');
    } finally {
      this.uploading.set(false);
    }
  }

  useSample(purpose: 'source' | 'reference' = 'source'): void {
    if (this.readonly()) return;
    if (purpose === 'source') {
      this.change((doc) => {
        doc.sourceImage = '/demo/floor-plan.svg';
        delete doc.standardizedImage;
      });
      this.layer.set('source');
      this.message.set('Sample plan attached. It is synthetic evidence for interaction testing.');
    } else {
      this.referenceImage.set('/demo/floor-plan.svg');
      this.referenceForm.patchValue({
        name: 'Synthetic reference example',
        description:
          'Sample plan used to exercise reference association; replace with a real scene photograph.',
      });
    }
  }

  changeZoom(amount: number): void {
    this.zoom.update((value) => Math.max(60, Math.min(180, value + amount)));
  }

  suggest(command: string): void {
    this.prompt.setValue(command);
    this.sidePanel.set('assistant');
  }

  runAssistant(retry = false): void {
    if (this.readonly() || this.aiState() === 'running') return;
    if (this.prompt.invalid) {
      this.prompt.markAsTouched();
      return;
    }
    if (retry) this.aiFailure.set(false);
    const command = this.prompt.value.trim();
    const source = structuredClone(this.document());
    const selected = this.selected();
    const token = ++this.aiSequence;
    this.aiBaseSequence = this.editSequence();
    this.aiBaseVersion = this.version();
    this.aiProposal.set(null);
    this.aiState.set('running');
    this.aiStep.set(0);
    this.aiDescription.set('Reading the draft and the requested change…');
    this.timers.push(
      setTimeout(() => {
        if (token === this.aiSequence) {
          this.aiStep.set(1);
          this.aiDescription.set('Preparing a reviewable proposal…');
        }
      }, 650),
    );
    this.timers.push(
      setTimeout(() => {
        if (token !== this.aiSequence) return;
        if (this.aiFailure()) {
          this.aiState.set('error');
          this.aiDescription.set(
            'Simulated provider timeout. Your draft is unchanged. Retry to continue.',
          );
          return;
        }
        if (
          this.readonly() ||
          this.aiBaseSequence !== this.editSequence() ||
          this.aiBaseVersion !== this.version() ||
          this.contribution()?.version !== this.version()
        ) {
          this.aiState.set('error');
          this.aiDescription.set(
            'The draft changed during processing. Run the request again against the latest draft.',
          );
          return;
        }
        const result = this.propose(command, source, selected);
        this.aiDescription.set(result.description);
        if (result.document) {
          this.aiProposal.set(result.document);
          this.aiState.set('proposal');
          this.aiStep.set(2);
        } else this.aiState.set('clarification');
      }, 1500),
    );
  }

  private propose(
    command: string,
    doc: MapDocument,
    selected: string,
  ): { description: string; document?: MapDocument } {
    if (/standardiz|clean.*(?:plan|image)/i.test(command)) {
      if (!doc.sourceImage)
        return { description: 'Attach a source image or use the sample plan first.' };
      doc.standardizedImage = doc.sourceImage;
      return {
        document: doc,
        description:
          'Create a high contrast preview from the attached source. This simulation preserves source pixels; it performs no AI correction or extraction.',
      };
    }
    if (/vector|trac/i.test(command)) {
      if (!doc.sourceImage)
        return { description: 'Attach a source image before requesting a simulated trace.' };
      if (doc.rooms.length)
        return {
          document: doc,
          description:
            'Retain the existing editable geometry as the simulated trace result. No image recognition occurred; inspect room outlines against the source before submitting.',
        };
      doc.rooms = [
        {
          id: 'sample-room-a',
          name: 'Studio 101',
          kind: 'classroom',
          x: 90,
          y: 115,
          width: 245,
          height: 165,
          accessible: true,
        },
        {
          id: 'sample-room-b',
          name: 'Meeting 102',
          kind: 'meeting',
          x: 365,
          y: 115,
          width: 245,
          height: 165,
          accessible: true,
        },
        {
          id: 'sample-room-c',
          name: 'Lab 103',
          kind: 'lab',
          x: 640,
          y: 115,
          width: 270,
          height: 165,
          accessible: true,
        },
      ];
      doc.nodes = [
        { id: 'sample-entry', label: 'Entrance', x: 90, y: 325 },
        { id: 'sample-a', label: 'Studio entrance', x: 212, y: 325, roomId: 'sample-room-a' },
        { id: 'sample-b', label: 'Meeting entrance', x: 487, y: 325, roomId: 'sample-room-b' },
        { id: 'sample-c', label: 'Lab entrance', x: 775, y: 325, roomId: 'sample-room-c' },
      ];
      doc.edges = doc.nodes.slice(1).map((node, index) => ({
        id: `sample-edge-${index}`,
        from: doc.nodes[index].id,
        to: node.id,
        accessible: true,
        blocked: false,
      }));
      return {
        document: doc,
        description:
          'Add the synthetic three-room sample layout and its walking graph. This deterministic example does not trace the uploaded image; replace or adjust every room against real evidence.',
      };
    }
    const rename = command.match(/rename\b.+?\bto\s+["“]?(.+?)["”]?$/i);
    if (rename) {
      const room = doc.rooms.find((item) => item.id === selected);
      if (!room)
        return {
          description: 'Select a room on the map, then request “Rename selected room to …”.',
        };
      const name = rename[1].replace(/["”]$/, '').trim().slice(0, 80);
      const previous = room.name;
      room.name = name;
      for (const waypoint of doc.nodes) {
        if (waypoint.roomId === room.id && waypoint.label === previous) waypoint.label = name;
      }
      return {
        document: doc,
        description: `Rename “${previous}” to “${name}”. Geometry and walking connections stay the same.`,
      };
    }
    if (/add.*waypoint/i.test(command)) {
      doc.nodes.push({ id: this.newId('ai-node'), label: 'New corridor waypoint', x: 500, y: 325 });
      return {
        document: doc,
        description:
          'Add one waypoint at the center of the corridor (500, 325). Connect it to the walking graph before publication.',
      };
    }
    const label = command.match(/(?:add\s+(?:a\s+)?(?:text\s+)?label|annotate)\s*[: ]\s*(.+)/i);
    if (label) {
      doc.annotations.push({
        id: this.newId('ai-label'),
        x: 430,
        y: 410,
        text: label[1].slice(0, 80),
        type: 'label',
      });
      return {
        document: doc,
        description: `Add the label “${label[1].slice(0, 80)}” at (430, 410). You can adjust its position in the inspector.`,
      };
    }
    return {
      description:
        'This demo understands standardize source, create vector map, rename selected room to a name, add waypoint, and add label followed by text. Choose a suggested command or be more specific.',
    };
  }

  cancelAssistant(): void {
    this.aiSequence++;
    this.aiState.set('cancelled');
    this.aiProposal.set(null);
    this.aiDescription.set('Request cancelled. Your draft is unchanged.');
  }

  applyProposal(): void {
    const proposal = this.aiProposal();
    if (!proposal) return;
    if (
      this.readonly() ||
      this.aiBaseSequence !== this.editSequence() ||
      this.aiBaseVersion !== this.version() ||
      this.contribution()?.version !== this.version()
    ) {
      this.aiState.set('error');
      this.aiProposal.set(null);
      this.aiDescription.set(
        'This proposal is stale. Run the request again against the latest draft.',
      );
      return;
    }
    this.change((doc) => Object.assign(doc, structuredClone(proposal)));
    if (/standardiz/i.test(this.prompt.value)) this.layer.set('standardized');
    else this.layer.set('vector');
    this.aiState.set('idle');
    this.aiProposal.set(null);
    this.aiDescription.set('Proposal applied to your draft. Undo is available; save when ready.');
    this.message.set('AI proposal applied as one undoable change.');
  }

  resetReference(): void {
    this.referenceSequence++;
    this.referenceBusy.set(false);
    this.referenceId.set('');
    this.referenceImage.set('');
    this.referenceAnalysis.set('');
    this.referenceForm.reset({
      name: '',
      nodeId: this.document().nodes[0]?.id ?? '',
      direction: 'Unknown',
      description: '',
      reviewed: false,
    });
  }

  editReference(reference: SceneReference): void {
    this.referenceSequence++;
    this.referenceBusy.set(false);
    this.referenceId.set(reference.id);
    this.referenceImage.set(reference.image);
    this.referenceAnalysis.set('');
    this.referenceForm.reset({
      name: reference.name,
      nodeId: reference.nodeId,
      direction: reference.direction,
      description: reference.description,
      reviewed: reference.reviewed,
    });
  }

  analyzeReference(): void {
    if (!this.referenceImage() || this.referenceBusy() || this.readonly()) return;
    const token = ++this.referenceSequence;
    const original = this.referenceForm.getRawValue();
    this.referenceBusy.set(true);
    this.referenceAnalysis.set('Simulating scene analysis…');
    this.timers.push(
      setTimeout(() => {
        if (token !== this.referenceSequence) return;
        this.referenceBusy.set(false);
        if (this.readonly()) {
          this.referenceAnalysis.set('This draft is now read only; the result was discarded.');
          return;
        }
        if (JSON.stringify(original) !== JSON.stringify(this.referenceForm.getRawValue())) {
          this.referenceAnalysis.set(
            'Your reference details changed during analysis. Run again to avoid replacing newer edits.',
          );
          return;
        }
        const node = this.document().nodes.find((item) => item.id === original.nodeId);
        const description = `Simulated scene record near ${node?.label ?? 'an unassigned waypoint'}: corridor junction with room signage and a doorway. Verify every detail against the photograph before marking it reviewed.`;
        this.referenceForm.patchValue({ description, reviewed: false });
        this.referenceAnalysis.set(
          'Demo analysis complete. Review and correct the suggested description below; no real image recognition was performed.',
        );
      }, 1100),
    );
  }

  saveReference(): void {
    if (this.readonly()) return;
    if (!this.referenceImage()) {
      this.error.set('Attach a reference image first.');
      return;
    }
    if (this.referenceForm.invalid) {
      this.referenceForm.markAllAsTouched();
      return;
    }
    const value = this.referenceForm.getRawValue();
    if (!this.document().nodes.some((node) => node.id === value.nodeId)) {
      this.error.set('Choose an existing waypoint for this reference.');
      return;
    }
    const reference: SceneReference = {
      ...value,
      name: value.name.trim(),
      description: value.description.trim(),
      id: this.referenceId() || this.newId('reference'),
      image: this.referenceImage(),
      createdAt:
        this.document().references.find((item) => item.id === this.referenceId())?.createdAt ??
        new Date().toISOString(),
    };
    this.change((doc) => {
      const index = doc.references.findIndex((item) => item.id === reference.id);
      if (index >= 0) doc.references[index] = reference;
      else doc.references.push(reference);
    });
    this.resetReference();
    this.message.set('Reference added to the draft. Save the draft to keep it on this device.');
  }

  removeReference(id: string): void {
    this.change((doc) => {
      doc.references = doc.references.filter((item) => item.id !== id);
    });
    if (this.referenceId() === id) this.resetReference();
  }

  download(): void {
    const payload = {
      prototype: true,
      target: this.target()?.name,
      contribution: this.contribution()?.title,
      document: this.document(),
    };
    const link = document.createElement('a');
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    );
    link.href = url;
    link.download = `snapway-${this.id()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.message.set(
      'Map document exported as JSON. This is a prototype format, not the future API contract.',
    );
  }
}
