import { TestBed } from '@angular/core/testing';
import { GraphCanvas, boundedMove } from './graph-canvas';

describe('Graph canvas geometry and gestures', () => {
  it('clamps a dragged group together without distorting its spacing', () => {
    const moved = boundedMove(
      [
        { id: 'a', x: 20, y: 30 },
        { id: 'b', x: 80, y: 50 },
      ],
      -50,
      100,
      100,
      100,
    );
    expect(moved).toEqual([
      { id: 'a', x: 0, y: 80 },
      { id: 'b', x: 60, y: 100 },
    ]);
  });
  it('keeps zoom anchored at the cursor and resets to the whole plan', () => {
    const c = TestBed.runInInjectionContext(() => new GraphCanvas());
    c.zoomBy(2, { x: 200, y: 100 });
    expect(c.view()).toEqual({ x: 100, y: 50, w: 500, h: 320 });
    c.fit();
    expect(c.zoom()).toBe(100);
  });
  it('previews a group drag, commits once on release, and cancels without committing', async () => {
    await TestBed.configureTestingModule({ imports: [GraphCanvas] }).compileComponents();
    const f = TestBed.createComponent(GraphCanvas),
      c = f.componentInstance;
    f.componentRef.setInput('nodes', [
      { id: 'a', x: 20, y: 30, label: 'A', kind: 'checkpoint' },
      { id: 'b', x: 80, y: 50, label: 'B', kind: 'checkpoint' },
    ]);
    f.componentRef.setInput('selectedIds', ['a', 'b']);
    f.detectChanges();
    const svg = f.nativeElement.querySelector('svg'),
      node = f.nativeElement.querySelector('[data-node="a"] circle');
    // Identity screen-to-plan transform isolates pointer lifecycle from JSDOM's missing SVG implementation.
    const original = globalThis.DOMPoint;
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
      matrixTransform() {
        return this;
      }
    }
    Object.defineProperty(globalThis, 'DOMPoint', { value: Point, configurable: true });
    svg.getScreenCTM = () => ({ inverse: () => ({}) });
    svg.setPointerCapture = () => {};
    svg.hasPointerCapture = () => false;
    const events: unknown[] = [];
    c.moved.subscribe((move) => events.push(move));
    const event = (x: number, y: number) =>
      ({
        pointerId: 1,
        button: 0,
        currentTarget: svg,
        target: node,
        clientX: x,
        clientY: y,
        shiftKey: false,
        preventDefault: () => {},
      }) as unknown as PointerEvent;
    try {
      c.down(event(20, 30));
      c.move(event(30, 40));
      c.move(event(40, 50));
      expect(events.length).toBe(0);
      expect(c.displayed()[1].x).toBe(100);
      c.up(event(40, 50));
      expect(events).toEqual([
        [
          { id: 'a', x: 40, y: 50 },
          { id: 'b', x: 100, y: 70 },
        ],
      ]);
      c.down(event(20, 30));
      c.move(event(70, 70));
      c.cancel();
      expect(events.length).toBe(1);
      expect(c.preview()).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, 'DOMPoint', { value: original, configurable: true });
    }
  });
  it.each(['mouse', 'touch'])(
    'selects the nearest photo stop for %s without dragging points',
    async (pointerType) => {
      await TestBed.configureTestingModule({ imports: [GraphCanvas] }).compileComponents();
      const fixture = TestBed.createComponent(GraphCanvas),
        canvas = fixture.componentInstance;
      fixture.componentRef.setInput('selectionOnly', true);
      fixture.componentRef.setInput('nodes', [
        { id: 'first', x: 20, y: 20, label: 'Point 1', kind: 'checkpoint' },
        { id: 'second', x: 35, y: 20, label: 'Point 2', kind: 'checkpoint' },
      ]);
      fixture.detectChanges();
      const svg = fixture.nativeElement.querySelector('svg');
      const original = globalThis.DOMPoint;
      class Point {
        constructor(
          public x: number,
          public y: number,
        ) {}
        matrixTransform() {
          return this;
        }
      }
      Object.defineProperty(globalThis, 'DOMPoint', { value: Point, configurable: true });
      svg.getScreenCTM = () => ({ inverse: () => ({}) });
      const selections: string[][] = [],
        moves: unknown[] = [];
      canvas.selectionChanged.subscribe((ids) => selections.push(ids));
      canvas.moved.subscribe((ids) => moves.push(ids));
      const event = {
        pointerId: 1,
        pointerType,
        button: 0,
        currentTarget: svg,
        // Simulate the overlapping hit area of the later SVG marker.
        target: fixture.nativeElement.querySelector('[data-node="second"] circle'),
        clientX: 21,
        clientY: 20,
        shiftKey: false,
        preventDefault() {},
      } as unknown as PointerEvent;
      try {
        canvas.down(event);
        canvas.move(event);
        canvas.up(event);
        expect(selections).toEqual([['first']]);
        expect(moves).toEqual([]);
        expect(canvas.preview()).toEqual([]);
        fixture.nativeElement
          .querySelector('[data-node="second"]')
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(selections.at(-1)).toEqual(['second']);
        fixture.componentRef.setInput('disabled', true);
        canvas.down(event);
        canvas.activateNode('first');
        expect(selections).toHaveLength(2);
      } finally {
        Object.defineProperty(globalThis, 'DOMPoint', { value: original, configurable: true });
      }
    },
  );

  it('keeps photo markers the same screen size as the map resizes and zooms', async () => {
    let measure: ResizeObserverCallback | undefined;
    const original = globalThis.ResizeObserver;
    class Observer {
      constructor(callback: ResizeObserverCallback) {
        measure = callback;
      }
      observe() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { value: Observer, configurable: true });
    try {
      await TestBed.configureTestingModule({ imports: [GraphCanvas] }).compileComponents();
      const fixture = TestBed.createComponent(GraphCanvas),
        canvas = fixture.componentInstance;
      fixture.componentRef.setInput('width', 2000);
      fixture.componentRef.setInput('height', 1000);
      fixture.componentRef.setInput('selectionOnly', true);
      fixture.componentRef.setInput('nodes', [
        { id: 'one', x: 50, y: 50, label: 'Point 1', kind: 'checkpoint' },
      ]);
      fixture.detectChanges();
      const resized = (width: number, height: number) => {
        measure!([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
        fixture.detectChanges();
      };
      resized(400, 300);
      expect(canvas.unitsPerPixel()).toBe(5);
      expect(Number(fixture.nativeElement.querySelector('.node-hit').getAttribute('r')) / 5).toBe(
        22,
      );
      canvas.zoomBy(2);
      fixture.detectChanges();
      expect(canvas.unitsPerPixel()).toBe(2.5);
      expect(Number(fixture.nativeElement.querySelector('.node-hit').getAttribute('r')) / 2.5).toBe(
        22,
      );
      resized(800, 300);
      expect(canvas.unitsPerPixel()).toBeCloseTo(5 / 3);
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', { value: original, configurable: true });
    }
  });
});
