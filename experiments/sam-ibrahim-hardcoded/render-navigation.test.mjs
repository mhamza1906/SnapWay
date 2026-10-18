import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNavigationSvg } from './render-navigation.mjs';

const original = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 100"><g><path d="M0 0 L500 0 L500 100 Z" fill="none" stroke="black"/></g></svg>';
const floor = { id: 'F', label: 'Floor & test', width: 500, height: 100, sourceFrameId: 'F:original-svg-viewbox' };
const a = { x: 10, y: 50 }, b = { x: 30, y: 50 }, c = { x: 60, y: 50 };
function fixture() {
  return {
    floors: [floor],
    nodes: [
      { id: 'a', floorId: 'F', label: 'A <door>', type: 'doorway', doorId: 'door-a', position: a },
      { id: 'b', floorId: 'F', label: 'B', type: 'junction', doorId: null, position: b },
      { id: 'c', floorId: 'F', label: 'C', type: 'doorway', doorId: 'door-c', position: c },
    ],
    edges: [
      { id: 'ab', floorId: 'F', from: 'a', to: 'b', traversal: 'corridor', path: [a, b] },
      { id: 'bc', floorId: 'F', from: 'b', to: 'c', traversal: 'corridor', path: [b, c] },
    ],
  };
}

test('renders exact stored graph coordinates and display-only route composition', () => {
  const building = fixture(), before = structuredClone(building);
  const route = { startNode: 'a', endNode: 'c', steps: building.edges.map(edge => ({ ...edge, edgeId: edge.id })) };
  const svg = renderNavigationSvg(floor, building, original, { route });
  assert.equal((svg.match(/data-node-id=/g) || []).length, 3);
  assert.equal((svg.match(/data-edge-id=/g) || []).length, 2);
  assert.equal((svg.match(/data-route-segment=/g) || []).length, 1);
  assert.match(svg, /data-route-segment="0" points="10,50 60,50"/);
  assert.match(svg, /data-edge-id="ab" points="10,50 30,50"/);
  assert.match(svg, /NO MEASURED SCALE/);
  assert.match(svg, /Floor &amp; test/);
  assert.match(svg, /A &lt;door&gt;/);
  assert.deepEqual(building, before);
});

test('rejects mismatched source frames, active source content and invented route paths', () => {
  assert.throws(() => renderNavigationSvg({ ...floor, width: 501 }, fixture(), original), /dimensions/);
  assert.throws(() => renderNavigationSvg(floor, fixture(), original.replace('<g>', '<g onclick="evil()">')), /static/);
  assert.throws(() => renderNavigationSvg(floor, fixture(), original, { route: { steps: [{ floorId: 'F', edgeId: 'ab', path: [a, c] }] } }), /stored graph/);
});
