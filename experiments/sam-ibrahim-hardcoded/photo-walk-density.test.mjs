import test from 'node:test';
import assert from 'node:assert/strict';
import { densifyPhotoWalk } from './photo-walk-density.mjs';

function line(count = 30) {
  return { source: 'test:L1:hall:adaptive-30-v1', width: 800, height: 300,
    points: count, nodes: Array.from({ length: count }, (_, i) => ({ x: i * 10, y: 20, label: `Point ${i + 1}`, kind: 'checkpoint', photoOrder: i + 1 })),
    edges: Array.from({ length: count - 1 }, (_, i) => ({ from: i, to: i + 1 })) };
}
const totalLength = w => w.edges.reduce((sum, e) => sum + Math.hypot(w.nodes[e.to].x - w.nodes[e.from].x, w.nodes[e.to].y - w.nodes[e.from].y), 0);

test('40-stop expansion preserves every existing node and exact walking length', () => {
  const before = line(), original = structuredClone(before), after = densifyPhotoWalk(before);
  assert.equal(after.points, 40);
  assert.deepEqual(after.nodes.slice(0, 30), before.nodes);
  assert.equal(totalLength(after), totalLength(before));
  assert.deepEqual(before, original);
  for (const node of after.nodes.slice(30)) assert.equal(node.y, 20);
  assert.equal(new Set(after.nodes.map(n => `${n.x},${n.y}`)).size, after.nodes.length);
});
test('removed Level 1 orders remain retired while new labels append above 30', () => {
  const before = line();
  const retired = [5, 6, 23, 30];
  for (const number of retired) before.nodes[number - 1].label = 'Path support';
  before.points = 26;
  const after = densifyPhotoWalk(before, { reservedOrders: retired });
  assert.equal(after.points, 40);
  assert.deepEqual(after.nodes.slice(0, 30), before.nodes);
  for (const number of retired) assert(!after.nodes.some(n => n.label === `Point ${number}`));
  assert.deepEqual(after.densityProfile.addedOrders, Array.from({ length: 14 }, (_, i) => i + 31));
});
test('largest uncovered walking gap gets the next stop, with modest small-walk growth', () => {
  const before = line(3);
  before.nodes[1].x = 100; before.nodes[2].x = 110;
  const after = densifyPhotoWalk(before);
  assert.equal(after.points, 4);
  assert.deepEqual(after.nodes.at(-1), { x: 50, y: 20, label: 'Point 4', kind: 'checkpoint', photoOrder: 4 });
});
test('expansion is deterministic and applying its profile twice is a no-op', () => {
  const once = densifyPhotoWalk(line());
  assert.deepEqual(once, densifyPhotoWalk(line()));
  assert.deepEqual(once, densifyPhotoWalk(once));
  assert(once.previousSources.includes('test:L1:hall:adaptive-30-v1'));
});
test('disconnected paths never acquire a bridging edge', () => {
  const before = line(); before.edges.splice(14, 1);
  const after = densifyPhotoWalk(before);
  assert.equal(after.points, 40);
  assert.equal(totalLength(before), totalLength(after));
  for (const edge of after.edges) {
    const a = after.nodes[edge.from].x, b = after.nodes[edge.to].x;
    assert(!((a <= 140 && b >= 150) || (b <= 140 && a >= 150)));
  }
});
test('tiny areas and forty-stop walks are retained without forced extra photos', () => {
  assert.deepEqual(densifyPhotoWalk(line(1)), line(1));
  assert.deepEqual(densifyPhotoWalk(line(40)), line(40));
  assert.throws(() => densifyPhotoWalk(line(41)), /point count/);
});
