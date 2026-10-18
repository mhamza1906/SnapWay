/**
 * Offline adapter around the existing authoring pipeline's pure domain modules.
 * No server, model, environment-file, UI, storage or provider module is loaded.
 *
 * Inputs use normalized source-frame coordinates. Region polygons must be
 * explicitly traced; report annotation rectangles are never walkable outlines.
 * Draft openings are intentionally recorded as assumed, even when a source SVG
 * contains a doorway-shaped mark: the report has not verified physical access.
 */
import { LIGHT_IMAGE, MapSchema, clone, inside, intersection, pointSegment } from '../../apps/pipeline/shared/map.js';
import { newBuilding, newFloor, parseBuilding } from '../../apps/pipeline/shared/building/schema.js';
import { applyAccessDecisions, routeAccessResults } from '../../apps/pipeline/shared/building/access.js';
import { buildGraph } from '../../apps/pipeline/shared/building/graph.js';
import { routeBuilding, roomAvailability } from '../../apps/pipeline/shared/building/routing.js';
import { navigationBundle } from '../../apps/pipeline/shared/building/navigation-bundle.js';
import { geometryIssues, edgeIssue } from '../../apps/pipeline/shared/building/validation.js';

const REVIEWER = 'Codex manual Sam Ibrahim experiment';
const BASES = new Set(['svg-traced', 'hand-traced-source', 'synthetic-test']);
const OPENING_TYPES = new Set(['door', 'double-door', 'open-passage', 'decomposition-join', 'exterior-door']);

function requireThat(condition, message) {
  if (!condition) throw new Error(`Manual pipeline adapter: ${message}`);
}

function point(value, floor) {
  const x = Array.isArray(value) ? value[0] : value?.x;
  const y = Array.isArray(value) ? value[1] : value?.y;
  requireThat(Number.isFinite(x) && Number.isFinite(y), `${floor.id}: expected a finite normalized coordinate`);
  requireThat(x >= 0 && x <= 1 && y >= 0 && y <= 1, `${floor.id}: coordinates must be in the normalized source frame [0, 1]`);
  return { x: x * floor.width, y: y * floor.height };
}

function description(input, fallback) {
  const text = input.evidenceNote || input.evidence?.description || fallback;
  const page = input.reviewPage ?? input.evidence?.sourcePage;
  const shapes = input.sourceShapeIds?.length ? ` SVG shapes: ${input.sourceShapeIds.join(', ')}.` : '';
  return `${text}${page ? ` Review PDF page ${page}.` : ''}${shapes}`.slice(0, 3000);
}

function evidence(input, fallback, method = 'assumed') {
  return { method, description: description(input, fallback), confidence: null, crops: [] };
}

function validateRegion(region, floor) {
  const basis = region.geometryBasis || floor.geometryBasis;
  requireThat(BASES.has(basis), `${region.id}: geometryBasis must describe explicit SVG/source tracing, never an annotation bounding box`);
  requireThat(Array.isArray(region.polygon) && region.polygon.length >= 3, `${region.id}: an explicit traced polygon is required`);
  if (basis === 'svg-traced') {
    requireThat(region.sourceFrameId || floor.sourceFrameId, `${region.id}: SVG tracing requires sourceFrameId`);
    requireThat((region.sourceShapeIds || []).length > 0, `${region.id}: SVG tracing requires sourceShapeIds`);
  }
  requireThat(region.use !== 'hall', `${region.id}: room-through-routing is disabled in this experiment`);
  const kind = region.kind || 'room';
  requireThat(region.use !== 'stair' || kind === 'lobby', `${region.id}: a stair depiction uses kind lobby and use stair`);
  return {
    id: region.id,
    label: region.label,
    kind,
    polygon: region.polygon.map(p => point(p, floor)),
    confidence: region.confidence ?? 0.5,
    // The access transaction clears unknown only after inserting usable
    // assumed openings. Even a corridor outline alone establishes no access.
    access: region.access === 'nonwalkable' ? 'nonwalkable' : 'unknown',
    ...(region.use ? { use: region.use } : {}),
  };
}

function openingRecord(input, floor) {
  const ids = input.regionIds || input.spaceIds;
  requireThat(Array.isArray(ids) && ids.length >= 1 && ids.length <= 2, `${input.id}: door needs one or two explicit region IDs`);
  // The compact hand-authored vocabulary uses "open" for an analytical
  // circulation partition. Preserve its meaning in the pipeline's own enum.
  const type = input.openingType === 'open' ? 'decomposition-join' : (input.openingType || (ids.length === 1 ? 'exterior-door' : 'door'));
  requireThat(OPENING_TYPES.has(type), `${input.id}: unsupported openingType`);
  const segment = input.segment || [input.a, input.b];
  return {
    id: `${input.id}:access`, kind: 'opening', status: 'accepted',
    spaceId: ids[0], doorId: input.id, adjacentIds: ids,
    openingType: type, label: input.label || input.id,
    segment: { a: point(segment[0], floor), b: point(segment[1], floor) },
    reason: 'Manually encoded draft source candidate; physical threshold and elevation remain unverified.',
    evidence: evidence(input, 'Hand-authored draft opening; not physically verified.'),
  };
}

function normalizeTimes(building, at) {
  building.updatedAt = at;
  for (const floor of building.floors) {
    floor.geometry.extraction.createdAt = at;
    floor.geometry.review.reviewedAt = at;
    for (const record of floor.access.records) {
      record.createdAt = at;
      record.review.at = at;
      if (record.validation) record.validation.checkedAt = at;
    }
    for (const entry of floor.history) entry.at = at;
  }
}

const terminalRegion = region => !['corridor', 'lobby'].includes(region.kind);

// Split each line at exact polygon-boundary intersections. Sampling the
// resulting intervals catches even a short interior excursion without treating
// a shared doorway threshold or a corridor-side approach as room transit.
function segmentEntersInterior(a, b, polygon) {
  const cuts = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const hit = intersection(a, b, polygon[i], polygon[(i + 1) % polygon.length]);
    if (hit) cuts.push(Math.max(0, Math.min(1, hit.t)));
  }
  cuts.sort((x, y) => x - y);
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] - cuts[i - 1] < 1e-9) continue;
    const t = (cuts[i] + cuts[i - 1]) / 2;
    const p = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    if (inside(p, polygon) && polygon.every((v, j) => pointSegment(p, v, polygon[(j + 1) % polygon.length]) > 1e-6)) return true;
  }
  return false;
}

function removeRoomTransit(building, report) {
  const terminalByFloor = new Map(building.floors.map(floor => [floor.id, floor.geometry.spaces.filter(terminalRegion)]));
  building.edges = building.edges.filter(edge => {
    const crosses = (terminalByFloor.get(edge.floorId) || []).some(region => edge.path.some((point, index) => index > 0 && segmentEntersInterior(edge.path[index - 1], point, region.polygon)));
    if (!crosses) return true;
    report.removedRoomTransitEdgeIds.push(edge.id);
    return false;
  });
  const used = new Set(building.edges.flatMap(edge => [edge.from, edge.to]));
  building.nodes = building.nodes.filter(node => node.doorId || node.connectorId || used.has(node.id) || !node.spaceIds.some(id => terminalByFloor.get(node.floorId)?.some(region => region.id === id)));
  for (const floor of building.floors) {
    const records = floor.access.records.filter(record => record.kind === 'opening');
    const check = routeAccessResults(building, floor.id, [...new Set(records.flatMap(record => record.adjacentIds))]);
    for (const record of records) {
      const result = check.results.find(item => item.spaceId === record.spaceId);
      record.validation.routeCheck = { passed: !!result?.passed, message: result?.message || 'No room access after terminal-only filtering.' };
    }
  }
}

/**
 * Build a schema-compatible experimental building. This is deliberately a draft
 * artifact: all inserted doors have assumed evidence, accessibility is unknown,
 * scale is absent, and cross-floor candidates cannot enter the routing graph.
 *
 * @param {object} spec {id,name,provenance,generatedAt?,floors:[{id,label,level,
 * width,height,geometryBasis,sourceFrameId?,regions:[{id,label,kind,polygon,
 * sourceShapeIds?,access?,use?}],doors:[{id,regionIds,segment,status:'draft'|
 * 'candidate',openingType?,evidenceNote?,reviewPage?}],candidateLandings?:[]}],
 * connectorCandidates?:[]}
 */
export function buildPipelineArtifact(spec) {
  requireThat(spec?.id && spec?.name && Array.isArray(spec.floors), 'building id, name and floors are required');
  const at = spec.generatedAt || new Date().toISOString();
  requireThat(Number.isFinite(Date.parse(at)), 'generatedAt must be a valid date');
  const report = {
    artifactType: 'draft-manual-navigation-experiment',
    reviewStatus: 'agent-inspected',
    verifiedCrossFloorConnections: 0,
    scale: 'unmeasured',
    accessibility: 'unknown',
    removedRoomTransitEdgeIds: [],
    candidateOpenings: [],
    candidateLandings: [],
    connectorCandidates: clone(spec.connectorCandidates || []),
    floors: [],
    pipelineModules: ['shared/map.js', 'shared/building/schema.js', 'shared/building/access.js', 'shared/building/graph.js', 'shared/building/endpoints.js', 'shared/building/routing.js', 'shared/building/navigation-bundle.js', 'shared/building/validation.js'].map(path => `apps/pipeline/${path}`),
    limitations: [
      'Draft source geometry and assumed openings are not a verified physical navigation map.',
      'Strict routing is disabled; allowDraft:true is required for offline same-floor experiments.',
      'No candidate stairs, elevators, split levels or projected rooms connect floors.',
      'Rooms terminate at entrances; internal door-to-door transit is removed.',
      'Source images remain external; the embedded image is a one-pixel schema placeholder.',
      'Pipeline reviewed geometry/graph flags mean deterministic checks passed, not human or on-site review.',
    ],
  };
  let building = { ...newBuilding(), id: spec.id, name: spec.name, provenance: `${spec.provenance || 'Manual Sam Ibrahim source experiment'}; DRAFT, agent-inspected, assumed doorways, no verified floor transitions.`, updatedAt: at };
  const seen = new Set();
  const claim = id => {
    requireThat(typeof id === 'string' && id.length > 0 && id.length <= 100, 'IDs must contain 1–100 characters');
    requireThat(!seen.has(id), `duplicate ID ${id}`);
    seen.add(id);
  };

  for (const input of spec.floors) {
    claim(input.id);
    requireThat(Number.isFinite(input.width) && input.width > 0 && Number.isFinite(input.height) && input.height > 0, `${input.id}: source-frame width and height are required`);
    requireThat(Array.isArray(input.regions), `${input.id}: regions are required`);
    const regions = input.regions.map(region => { claim(region.id); return validateRegion(region, input); });
    const regionIds = new Set(regions.map(region => region.id));
    const doors = input.doors || input.openings || [];
    for (const door of doors) {
      claim(door.id);
      const ids = door.regionIds || door.spaceIds || [];
      requireThat(ids.length && ids.every(id => regionIds.has(id)), `${door.id}: doorway references must belong to ${input.id}`);
      requireThat(['draft', 'candidate', 'supported'].includes(door.status), `${door.id}: explicitly set status draft or candidate`);
    }
    const floor = newFloor(input.id, input.label || input.id, input.level ?? 0);
    floor.width = input.width;
    floor.height = input.height;
    floor.geometry.id = `${input.id}:geometry`;
    floor.geometry.floorName = floor.label;
    floor.geometry.source = {
      name: input.sourceFrameId || `${input.id} external source frame`, width: input.width, height: input.height,
      dataUrl: LIGHT_IMAGE, normalized: true, fictional: input.geometryBasis === 'synthetic-test',
      provenance: 'External source SVG/PDF manually compared; no source pixels embedded. Not evidence imagery.',
    };
    floor.geometry.extraction = { provider: 'Offline hardcoded experiment', model: 'none', mode: 'manual', createdAt: at, notes: 'Explicit source polygons; no AI extraction or invented annotation-box footprints.' };
    floor.geometry.scale = null;
    const proposedGeometry = MapSchema.parse({ ...floor.geometry, spaces: regions });
    const issues = geometryIssues({ ...floor, geometry: proposedGeometry }).filter(issue => issue.severity === 'error');
    requireThat(!issues.length, `${input.id}: invalid traced geometry: ${issues.map(issue => issue.message).join('; ')}`);
    building.floors.push(floor);

    const decisions = regions.map((region, index) => ({
      op: 'carve', space: region,
      record: {
        id: `${region.id}:outline`, kind: 'classification', status: 'accepted', spaceId: region.id,
        reason: 'Explicit draft source outline; classification does not establish physical access.',
        evidence: evidence(input.regions[index], `Manually encoded ${input.geometryBasis || input.regions[index].geometryBasis} outline.`, 'manual'),
      },
    }));
    for (const door of doors) {
      if (door.status === 'candidate') {
        const ids = door.regionIds || door.spaceIds;
        decisions.push({ op: 'unresolved', record: {
          id: `${door.id}:unresolved`, kind: 'unresolved', status: 'unresolved', spaceId: ids[0],
          adjacentIds: ids, label: door.label || door.id,
          reason: 'Unplaced or unsupported source candidate; no door or graph edge created.',
          evidence: evidence(door, 'Source candidate requires threshold and elevation review.'),
        } });
        report.candidateOpenings.push({ floorId: input.id, ...clone(door) });
      } else decisions.push({ op: 'opening', record: openingRecord(door, input) });
    }
    if (decisions.length) {
      building = applyAccessDecisions(building, input.id, decisions, {
        reviewer: REVIEWER, reviewStatus: 'agent-inspected',
        notes: 'Draft source tracing; assumed openings; no human review or on-site verification.',
        reason: 'Offline manual reconstruction in an isolated experiment.',
      }).building;
    } else {
      // Empty floors contain no paths; record the agent-only inspection state.
      floor.geometryStatus = 'reviewed';
      floor.reviewer = REVIEWER;
      floor.reviewNotes = 'Empty experimental floor, agent-inspected only.';
      floor.geometry.review = { ...floor.geometry.review, status: 'reviewed', reviewer: REVIEWER, reviewedAt: at };
      building = buildGraph(building, input.id);
    }
    report.candidateLandings.push(...(input.candidateLandings || []).map(candidate => ({ floorId: input.id, ...clone(candidate) })));
    report.floors.push({ floorId: input.id, sourceFrameId: input.sourceFrameId || null, regions: regions.length, draftOpenings: doors.filter(door => door.status !== 'candidate').length, excludedCandidateOpenings: doors.filter(door => door.status === 'candidate').length });
  }

  // buildGraph links room doors and can automatically promote a large room
  // with >=3 doors to a hall. Remove either form of room-interior transit while
  // preserving all corridor-side doorway approaches.
  removeRoomTransit(building, report);
  // Defense in depth: this adapter never calls connectLandings. Do not infer a
  // connector from matching labels, centres or any caller-supplied sidecar.
  requireThat(building.connectors.length === 0 && building.edges.every(edge => edge.floorId !== null && !edge.connectorId && !['stairs', 'elevator'].includes(edge.traversal)), 'an unverified cross-floor connection entered the graph');
  for (const node of building.nodes) requireThat(!node.connectorId, `unexpected connected landing ${node.id}`);
  for (const edge of building.edges) edge.accessible = 'unknown';
  normalizeTimes(building, at);
  building = parseBuilding(building);
  const contexts = new Map();
  report.edgeIssues = building.edges.map(edge => ({ edgeId: edge.id, issue: edgeIssue(building, edge, { contexts }) })).filter(item => item.issue);
  requireThat(!report.edgeIssues.length, `generated paths failed deterministic validation: ${report.edgeIssues.map(item => `${item.edgeId}: ${item.issue}`).join('; ')}`);
  report.roomAvailability = roomAvailability(building);
  report.nodeCount = building.nodes.length;
  report.edgeCount = building.edges.length;
  return { building, navigationBundle: parseBuilding(navigationBundle(building)), report };
}

/** Strict default is deliberate: these traced outlines and thresholds are drafts. */
export function routePipelineArtifact(artifact, fromRoomId, toRoomId, { allowDraft = false, ...options } = {}) {
  if (!allowDraft) return null;
  const building = artifact.building || artifact;
  requireThat(!building.connectors.length && building.edges.every(edge => edge.floorId !== null && !edge.connectorId), 'cross-floor transitions are forbidden in a draft route');
  const route = routeBuilding(building, fromRoomId, toRoomId, options);
  if (!route) return null;
  requireThat(route.floorIds.length === 1, 'a draft route unexpectedly changed floors');
  return { ...route, experimental: true, evidenceStatus: 'draft-assumed', warning: 'Source-plan experiment only; thresholds, elevations and accessibility are unverified.' };
}
