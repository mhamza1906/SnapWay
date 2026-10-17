import type { MapDocument } from './prototype.models';
import { findRoute, stepInstruction } from './navigation-engine';

const map: MapDocument = {
  rooms: [],
  annotations: [],
  references: [],
  nodes: [
    { id: 'a', label: 'Entrance', x: 0, y: 0 },
    { id: 'b', label: 'Stairs', x: 1, y: 0 },
    { id: 'c', label: 'Ramp', x: 0, y: 3 },
    { id: 'd', label: 'Room', x: 2, y: 0 },
    { id: 'isolated', label: 'Closed room', x: 10, y: 10 },
  ],
  edges: [
    { id: 'ab', from: 'a', to: 'b', accessible: false, blocked: false },
    { id: 'bd', from: 'b', to: 'd', accessible: true, blocked: false },
    { id: 'ac', from: 'a', to: 'c', accessible: true, blocked: false },
    { id: 'cd', from: 'c', to: 'd', accessible: true, blocked: false },
  ],
};

describe('published graph routing', () => {
  it('uses actual connected shortest paths and an accessible alternative', () => {
    expect(findRoute(map, 'a', 'd')?.nodes.map((node) => node.id)).toEqual(['a', 'b', 'd']);
    expect(findRoute(map, 'a', 'd', true)?.nodes.map((node) => node.id)).toEqual(['a', 'c', 'd']);
  });
  it('excludes closures and reports unreachable or missing destinations', () => {
    const closed = {
      ...map,
      edges: map.edges.map((edge) => ({ ...edge, blocked: edge.id === 'cd' })),
    };
    expect(findRoute(closed, 'a', 'd', true)).toBeNull();
    expect(findRoute(map, 'a', 'isolated')).toBeNull();
    expect(findRoute(map, 'a', 'missing')).toBeNull();
    expect(findRoute(map, 'd', 'a')?.nodes.map((node) => node.id)).toEqual(['d', 'b', 'a']);
  });
  it('handles arrival and correct turn direction in SVG coordinates', () => {
    expect(findRoute(map, 'a', 'a')?.nodes.map((node) => node.id)).toEqual(['a']);
    expect(
      stepInstruction([map.nodes[0], map.nodes[1], { ...map.nodes[3], x: 1, y: 2 }], 1),
    ).toContain('Turn right');
  });
});
