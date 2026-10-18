import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPipelineArtifact, routePipelineArtifact } from './pipeline-adapter.mjs';
import { parseBuilding } from '../../apps/pipeline/shared/building/schema.js';
import { doorAccessState } from '../../apps/pipeline/shared/building/access-state.js';
import { roomTransitEdge } from '../../apps/pipeline/shared/building/endpoints.js';

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const region = (id, kind, polygon, extra = {}) => ({ id, label: id, kind, polygon, ...extra });
const door = (id, regionIds, segment, extra = {}) => ({ id, regionIds, segment, status: 'draft', evidenceNote: 'Synthetic test opening; no real-building claim.', ...extra });

function fixture(floorId = 'L2') {
  return {
    id: floorId, label: floorId, level: Number(floorId.slice(1)), width: 300, height: 200,
    geometryBasis: 'synthetic-test',
    regions: [
      region(`${floorId}:hall`, 'corridor', rect(0, .4, 1, .6)),
      region(`${floorId}:a`, 'room', rect(0, 0, .3, .4)),
      region(`${floorId}:b`, 'room', rect(.7, 0, 1, .4)),
      region(`${floorId}:tiered`, 'room', rect(.2, .6, .8, 1)),
    ],
    doors: [
      door(`${floorId}:a-door`, [`${floorId}:a`, `${floorId}:hall`], [[.14, .4], [.17, .4]]),
      door(`${floorId}:b-door`, [`${floorId}:b`, `${floorId}:hall`], [[.82, .4], [.85, .4]]),
      door(`${floorId}:tiered-west`, [`${floorId}:tiered`, `${floorId}:hall`], [[.27, .6], [.3, .6]]),
      door(`${floorId}:tiered-east`, [`${floorId}:tiered`, `${floorId}:hall`], [[.7, .6], [.73, .6]]),
    ],
    candidateLandings: [{ id: `${floorId}:stair-a`, status: 'candidate', point: [.5, .5] }],
  };
}

const specification = (floors = [fixture()]) => ({
  id: 'synthetic-manual-test', name: 'Synthetic manual adapter test',
  generatedAt: '2026-10-17T00:00:00.000Z', floors,
  connectorCandidates: [{ id: 'stairs-a', from: 'L2:stair-a', to: 'L3:stair-a', status: 'unverified' }],
});

test('existing access transaction creates assumed doorway nodes and same-floor draft routes', () => {
  const spec = specification();
  const before = structuredClone(spec);
  const artifact = buildPipelineArtifact(spec);
  assert.deepEqual(spec, before, 'caller-authored input must remain unchanged');
  assert.doesNotThrow(() => parseBuilding(artifact.navigationBundle));
  const floor = artifact.building.floors[0];
  assert.equal(floor.geometry.scale, null);
  assert.equal(floor.geometry.source.width, 300);
  assert.deepEqual(floor.geometry.spaces.find(s => s.id === 'L2:a').polygon[1], { x: 90, y: 0 });
  assert.ok(floor.access.records.length > 0);
  assert.ok(floor.access.records.every(record => record.review.status === 'agent-inspected'));
  assert.ok(floor.geometry.doors.every(door => doorAccessState(floor, door).state === 'assumed'));
  assert.ok(artifact.building.edges.every(edge => edge.accessible === 'unknown'));
  assert.equal(routePipelineArtifact(artifact, 'L2:a', 'L2:b'), null, 'strict default cannot route draft source evidence');
  const route = routePipelineArtifact(artifact, 'L2:a', 'L2:b', { allowDraft: true });
  assert.ok(route?.steps.length);
  assert.deepEqual(route.floorIds, ['L2']);
  assert.equal(route.evidenceStatus, 'draft-assumed');
  assert.equal(route.accessible, false);
  assert.equal(routePipelineArtifact(artifact, 'L2:a', 'L2:b', { allowDraft: true, verifiedAccessible: true }), null);
});

test('tiered-room entrances never become a room interior shortcut', () => {
  const artifact = buildPipelineArtifact(specification());
  assert.ok(artifact.report.removedRoomTransitEdgeIds.some(id => id.includes('tiered')));
  assert.equal(artifact.building.edges.some(edge => roomTransitEdge(artifact.building, edge)), false);
  const route = routePipelineArtifact(artifact, 'L2:a', 'L2:b', { allowDraft: true });
  assert.ok(route);
  assert.ok(route.steps.every(step => !step.edgeId.includes('door-link')));
});

test('large three-door classrooms cannot become automatic hall transit', () => {
  const floor = {
    id: 'L2', label: 'Synthetic tiered classroom', level: 2, width: 400, height: 300,
    geometryBasis: 'synthetic-test',
    regions: [
      region('west', 'corridor', rect(0, .2, .2, .8)),
      region('east', 'corridor', rect(.8, .2, 1, .8)),
      region('north', 'corridor', rect(.2, 0, .8, .2)),
      region('a', 'room', rect(0, 0, .2, .2)),
      region('b', 'room', rect(.8, 0, 1, .2)),
      region('c', 'room', rect(.4, .8, .6, 1)),
      region('large-tiered', 'room', rect(.2, .2, .8, .8)),
    ],
    doors: [
      door('a-door', ['a', 'west'], [[.08, .2], [.1, .2]]),
      door('b-door', ['b', 'east'], [[.9, .2], [.92, .2]]),
      door('west-tier', ['large-tiered', 'west'], [[.2, .45], [.2, .48]]),
      door('east-tier', ['large-tiered', 'east'], [[.8, .45], [.8, .48]]),
      door('north-tier', ['large-tiered', 'north'], [[.49, .2], [.51, .2]]),
      door('c-door', ['c', 'large-tiered'], [[.49, .8], [.51, .8]]),
    ],
  };
  const artifact = buildPipelineArtifact(specification([floor]));
  assert.ok(artifact.report.removedRoomTransitEdgeIds.length > 0);
  assert.equal(routePipelineArtifact(artifact, 'a', 'b', { allowDraft: true }), null, 'corridors must not connect through the tiered room');
  assert.ok(routePipelineArtifact(artifact, 'a', 'large-tiered', { allowDraft: true }), 'the west doorway approach remains usable');
  assert.ok(routePipelineArtifact(artifact, 'b', 'large-tiered', { allowDraft: true }), 'the east doorway approach remains usable');
});

test('stair candidates and repeated room names do not connect floors, even in draft mode', () => {
  const artifact = buildPipelineArtifact(specification([fixture('L2'), fixture('L3')]));
  assert.equal(artifact.report.verifiedCrossFloorConnections, 0);
  assert.equal(artifact.report.candidateLandings.length, 2);
  assert.equal(artifact.report.connectorCandidates.length, 1);
  assert.equal(artifact.building.connectors.length, 0);
  assert.ok(artifact.building.edges.every(edge => edge.floorId !== null && !edge.connectorId));
  assert.equal(routePipelineArtifact(artifact, 'L2:a', 'L3:b', { allowDraft: true }), null);
});

test('unsupported portal candidates become unresolved records, never legacy usable doors', () => {
  const floor = fixture();
  floor.regions.push(region('L2:projected', 'room', rect(.3, 0, .7, .4)));
  floor.doors.push(door('L2:projected-candidate', ['L2:projected', 'L2:hall'], undefined, { status: 'candidate' }));
  const artifact = buildPipelineArtifact(specification([floor]));
  const built = artifact.building.floors[0];
  assert.equal(built.geometry.doors.some(door => door.id === 'L2:projected-candidate'), false);
  assert.equal(artifact.building.nodes.some(node => node.doorId === 'L2:projected-candidate'), false);
  assert.equal(built.geometry.spaces.find(space => space.id === 'L2:projected').access, 'unknown');
  assert.equal(artifact.report.candidateOpenings.length, 1);
  assert.equal(routePipelineArtifact(artifact, 'L2:a', 'L2:projected', { allowDraft: true }), null);
});

test('rejects annotation rectangles, missing SVG provenance and off-boundary doors', () => {
  const annotation = fixture();
  annotation.geometryBasis = 'report-annotation-box';
  assert.throws(() => buildPipelineArtifact(specification([annotation])), /geometryBasis/);
  const svg = fixture();
  svg.geometryBasis = 'svg-traced';
  svg.sourceFrameId = 'L2-source-svg';
  assert.throws(() => buildPipelineArtifact(specification([svg])), /sourceShapeIds/);
  const badDoor = fixture();
  badDoor.doors[0].segment = [[.14, .3], [.17, .3]];
  assert.throws(() => buildPipelineArtifact(specification([badDoor])), /boundary/);
});

test('a fixed generatedAt yields reproducible artifact bytes', () => {
  assert.deepEqual(buildPipelineArtifact(specification()), buildPipelineArtifact(specification()));
});
