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
});
