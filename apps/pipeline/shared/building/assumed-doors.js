import { clone, distance, pointSegment } from "../map.js";
import {
  applyAccessDecisions,
  checkRouteAccess,
  newAccessRecord,
  openingWidthLimit,
  segmentOverlap,
  validateOpening,
} from "./access.js";
import { roomAvailability } from "./routing.js";
import { edgeIssue } from "./validation.js";
import {
  doorRecord,
  regionNeedsSemanticReview,
  spaceAccessState,
} from "./access-state.js";

// Fallback for rooms whose doorway the source review could not establish: an
// explicitly assumed door at the middle of the room edge that touches a hallway,
// or a neighbouring room when no hallway edge is usable.
// It makes the room routable, is never counted as verified, and stays listed
// for a developer to move, confirm or remove.
export const ASSUMED_REVIEWER = "Assumed-doorway fallback";
export const NEEDS_DOOR = ["missing", "unknown", "stale-unknown", "unresolved"];
const NOT_A_ROOM = /\b(duct|shaft|chase|roof|balcony|void|open to below|riser)\b/i;
const NEAR_GAP = 15; // px; closer but not touching halls are reported for editing

const edges = (s) =>
  s.polygon.map((a, i) => ({ a, b: s.polygon[(i + 1) % s.polygon.length], index: i }));
const lerp = (l, t) => ({ x: l.a.x + (l.b.x - l.a.x) * t, y: l.a.y + (l.b.y - l.a.y) * t });

export const isAssumed = (record) => record?.evidence?.method === "assumed";

// Edges a door could open onto, best first: corridors, then lobbies, then a
// neighbouring room when no hallway touches; within each, the longest shared
// stretch. `near` lists spaces within a few pixels that do not share a boundary,
// which only a geometry edit can resolve.
const RANK = { corridor: 0, lobby: 1 };
export function neighbourEdges(floor, spaceId) {
  const g = floor.geometry,
    room = g.spaces.find((s) => s.id === spaceId);
  if (!room) throw new Error(`Unknown region ${spaceId}`);
  const neighbours = g.spaces.filter(
    (s) =>
      s.id !== spaceId &&
      s.access !== "nonwalkable" &&
      !NOT_A_ROOM.test(s.label) &&
      !regionNeedsSemanticReview(floor, s.id),
  );
  const shared = [],
    near = [];
  for (const other of neighbours) {
    let touching = false;
    for (const e of edges(room))
      for (const h of edges(other)) {
        let o = segmentOverlap(e.a, e.b, h.a, h.b);
        // Orient left-to-right (or top-to-bottom) so position 0% is predictable.
        if (o && (o.b.x < o.a.x - 0.5 || (Math.abs(o.b.x - o.a.x) <= 0.5 && o.b.y < o.a.y))) o = { ...o, a: o.b, b: o.a };
        if (o && o.length >= 4) {
          touching = true;
          shared.push({ adjacentId: other.id, adjacentLabel: other.label, adjacentKind: other.kind,
            hallway: other.kind in RANK, edgeIndex: e.index, a: o.a, b: o.b, length: o.length });
        }
      }
    if (!touching) {
      const gap = Math.min(...room.polygon.flatMap((p) => edges(other).map((h) => pointSegment(p, h.a, h.b))),
        ...other.polygon.flatMap((p) => edges(room).map((e) => pointSegment(p, e.a, e.b))));
      if (gap <= NEAR_GAP) near.push({ adjacentId: other.id, adjacentLabel: other.label, gap: Math.round(gap * 10) / 10 });
    }
  }
  shared.sort((x, z) => (RANK[x.adjacentKind] ?? 2) - (RANK[z.adjacentKind] ?? 2) || z.length - x.length);
  return { candidates: shared.map((c, i) => ({ ...c, key: i })), near: near.sort((x, z) => x.gap - z.gap) };
}

export function defaultDoorWidth(floor, spaceId, edge) {
  return Math.max(2, Math.min(openingWidthLimit(floor, spaceId, "door") * 0.75, edge.length * 0.8));
}

// The door segment centred at fraction `t` of the shared edge, kept inside it.
export function assumedSegment(edge, t = 0.5, width) {
  const len = edge.length,
    w = Math.min(width, len),
    centre = Math.min(len - w / 2, Math.max(w / 2, t * len));
  return { a: lerp(edge, (centre - w / 2) / len), b: lerp(edge, (centre + w / 2) / len) };
}

function assumedRecord(floor, room, edge, segment, doorId, note = "") {
  return newAccessRecord({
    id: `${doorId}:assumed:${Date.now().toString(36)}`,
    kind: "opening",
    status: "accepted",
    spaceId: room.id,
    doorId,
    openingType: "door",
    adjacentIds: [room.id, edge.adjacentId],
    segment,
    label: "Assumed doorway",
    reason: note || `No doorway was established from the source plan. Assumed at the middle of the ${room.label} edge shared with ${edge.adjacentLabel}${edge.hallway ? "" : " (a neighbouring room; no hallway edge was usable)"}; edit it if the plan shows otherwise.`,
    evidence: { method: "assumed", description: "Placement rule: midpoint of the room edge shared with a hallway, or with a neighbouring room when no hallway edge is usable. Not observed in the source.", confidence: null, crops: [] },
    review: { status: "agent-inspected", reviewer: ASSUMED_REVIEWER, at: null, notes: "" },
    geometryRevision: floor.revision,
  });
}

// Positions along an edge, farthest from doors already on it first.
function spreadPositions(floor, edge) {
  const taken = floor.geometry.doors
    .map((d) => ({ x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 }))
    .filter((m) => pointSegment(m, edge.a, edge.b) < 1)
    .map((m) => distance(edge.a, m) / edge.length);
  const ts = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];
  return taken.length ? ts.sort((x, z) => Math.min(...taken.map((t) => Math.abs(t - z))) - Math.min(...taken.map((t) => Math.abs(t - x)))) : ts;
}

// Tries the midpoint first, then nearby positions, on each candidate edge.
function placeOn(floor, room, candidates, width = null, spread = false) {
  for (const edge of candidates)
    for (const t of spread ? spreadPositions(floor, edge) : [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const w = width ?? defaultDoorWidth(floor, room.id, edge),
        segment = assumedSegment(edge, t, w),
        check = validateOpening(floor, { spaceId: room.id, adjacentId: edge.adjacentId, openingType: "door", ...segment });
      if (check.passed) return { edge, t, segment: check.segment };
    }
  return null;
}

// Every walkable region whose access is unsettled: rooms, stairs, lobbies and
// corridor pieces without a usable opening, and regions held for source
// classification (for example a stair polygon that mixes flights and landing).
export function roomsNeedingDoors(floor) {
  return floor.geometry.spaces.filter(
    (s) => s.access !== "nonwalkable" &&
      (regionNeedsSemanticReview(floor, s.id) || NEEDS_DOOR.includes(spaceAccessState(floor, s).status)),
  );
}

// Stairs, lobbies and held regions are treated as rooms: there is no separate
// stair type. Corridor pieces stay corridors. Never applied to areas labelled
// as ducts, shafts, roofs, balconies or voids.
const becomesRoom = (floor, s) =>
  !NOT_A_ROOM.test(s.label) && (s.kind === "lobby" || regionNeedsSemanticReview(floor, s.id));

// A developer's explicit "Make it a room" outranks the label heuristic.
const decidedRoom = (floor, spaceId) => {
  const r = (floor.access?.records || []).findLast((x) => x.spaceId === spaceId && x.kind === "classification");
  return r?.status === "accepted" && r.evidence.method === "manual" && r.change?.to.kind === "room";
};

function classificationRecord(floor, space, reason, method = "assumed") {
  return newAccessRecord({
    id: `${space.id}:classified:${Date.now().toString(36)}`,
    kind: "classification",
    status: "accepted",
    spaceId: space.id,
    reason,
    evidence: { method, description: reason, crops: [] },
    review: { status: "agent-inspected", reviewer: ASSUMED_REVIEWER, at: null, notes: "" },
    geometryRevision: floor.revision,
  });
}

// Earlier automated classification proposals for a region the developer has now
// decided are superseded, so they stop holding the region for review.
function supersedeProposals(building, floorId, spaceId, reviewer) {
  const next = clone(building),
    f = next.floors.find((f) => f.id === floorId);
  for (const r of f.access.records)
    if (r.spaceId === spaceId && r.kind === "classification" && r.status === "proposed") {
      r.status = "rejected";
      r.review = { status: "rejected", reviewer, at: new Date().toISOString(), notes: "Superseded by a developer room decision" };
    }
  return next;
}

// Places assumed doors for the given regions (default: every region that needs
// one). Stairs, lobbies and held regions first become rooms. Regions with no
// usable shared edge are skipped and reported; nothing is forced.
export function placeAssumedDoorways(building, floorId, { spaceIds = null, roomify = true } = {}) {
  let floor = building.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  const pick = (s) => !spaceIds || spaceIds.includes(s.id),
    toRoom = roomify ? roomsNeedingDoors(floor).filter((s) => pick(s) && becomesRoom(floor, s)) : [],
    roomed = toRoom.map((s) => s.label);
  if (toRoom.length) {
    building = applyAccessDecisions(building, floorId, toRoom.map((s) => ({
      op: "classify", spaceId: s.id, to: { kind: "room" },
      record: classificationRecord(floor, s, `${s.label} treated as a room: stairs, lobbies and unclear regions are rooms in this map. Change it with "Not a room" if it is not walkable.`),
    })), { reviewer: ASSUMED_REVIEWER, reviewStatus: "agent-inspected", reason: `Treated ${toRoom.length} region(s) as rooms` }).building;
    floor = building.floors.find((f) => f.id === floorId);
  }
  // Doors the visual check already supported but that stayed proposals because a
  // region was held for classification come first; assumed doors only fill gaps.
  const enabled = enableSupportedDoors(building, floorId, floor.geometry.spaces.filter((s) => pick(s) && s.access !== "nonwalkable").map((s) => s.id));
  building = enabled.building;
  floor = building.floors.find((f) => f.id === floorId);
  const work = { ...floor, geometry: clone(floor.geometry) },
    targets = roomsNeedingDoors(floor).filter(pick),
    decisions = [],
    placed = [],
    skipped = [];
  for (const room of targets) {
    if (NOT_A_ROOM.test(room.label) && !decidedRoom(work, room.id)) {
      skipped.push({ spaceId: room.id, label: room.label, reason: "Label suggests a non-walkable area; choose Make it a room or Not a room" });
      continue;
    }
    if (regionNeedsSemanticReview(work, room.id)) {
      skipped.push({ spaceId: room.id, label: room.label, reason: "Held for source classification; choose Make it a room or Not a room" });
      continue;
    }
    const { candidates, near } = neighbourEdges(work, room.id),
      spot = placeOn(work, room, candidates);
    if (!spot) {
      skipped.push({ spaceId: room.id, label: room.label, reason: candidates.length
        ? "Every shared edge is blocked by walls or other doors"
        : near.length ? `Does not touch any walkable space (${near[0].adjacentLabel} is ${near[0].gap} px away); adjust the outline`
          : "No walkable space shares an edge with this room" });
      continue;
    }
    // Never reuse an ID that has history: its last record would still describe the old door.
    const used = new Set([...work.geometry.doors.map((d) => d.id), ...(floor.access?.records || []).map((r) => r.doorId)]);
    let doorId = `${room.id}:assumed-door`;
    for (let n = 2; used.has(doorId); n++) doorId = `${room.id}:assumed-door-${n}`;
    const record = assumedRecord(floor, room, spot.edge, spot.segment, doorId);
    decisions.push({ op: "opening", record });
    work.geometry.doors.push({ id: doorId, label: "Assumed doorway", ...spot.segment, spaceIds: record.adjacentIds, confidence: 1 });
    // The transaction clears the unknown flag once a usable door exists; mirror it for the pre-check.
    const draftRoom = work.geometry.spaces.find((s) => s.id === room.id);
    if (draftRoom.access === "unknown") delete draftRoom.access;
    placed.push({ spaceId: room.id, label: room.label, doorId, opensOnto: spot.edge.adjacentLabel, viaRoom: !spot.edge.hallway });
  }
  // A door must connect its room to another room. Drop rooms whose hallway is
  // itself cut off, report them, and re-check the rest (removals only shrink).
  for (let round = 0; decisions.length && round < 5; round++) {
    const check = checkRouteAccess(building, floorId, work.geometry, placed.map((p) => p.spaceId)),
      failed = new Map((check.results || []).filter((r) => !r.passed).map((r) => [r.spaceId, r.message]));
    if (check.passed || !failed.size) break;
    for (const [spaceId, message] of failed) {
      const i = placed.findIndex((p) => p.spaceId === spaceId);
      if (i < 0) continue;
      const [gone] = placed.splice(i, 1);
      decisions.splice(decisions.findIndex((d) => d.record.doorId === gone.doorId), 1);
      work.geometry.doors = work.geometry.doors.filter((d) => d.id !== gone.doorId);
      const draftRoom = work.geometry.spaces.find((s) => s.id === spaceId), original = floor.geometry.spaces.find((s) => s.id === spaceId);
      if (original.access) draftRoom.access = original.access;
      skipped.push({ spaceId, label: gone.label, reason: `The space it would open onto does not reach other rooms (${message})` });
    }
  }
  if (!decisions.length) return { building, placed, skipped, roomed, enabled: enabled.doors };
  const result = applyAccessDecisions(building, floorId, decisions, {
    reviewer: ASSUMED_REVIEWER, reviewStatus: "agent-inspected",
    reason: `Assumed doorways for ${placed.length} room(s) without a source-established opening`,
  });
  // Some supported openings only pass the route check once neighbouring regions
  // have doors; try them again, then drop assumed doors they make redundant.
  const again = enableSupportedDoors(result.building, floorId, floor.geometry.spaces.filter((s) => pick(s) && s.access !== "nonwalkable").map((s) => s.id));
  let final = again.building;
  if (again.doors.length) {
    const f = final.floors.find((x) => x.id === floorId),
      // Only interior openings connect a room onward; an exterior door does not.
      covered = new Set(again.doors.map((id) => f.geometry.doors.find((d) => d.id === id)).filter((d) => d.spaceIds.length === 2).flatMap((d) => d.spaceIds)),
      redundant = placed.filter((p) => covered.has(p.spaceId));
    if (redundant.length)
      try {
        const trimmed = applyAccessDecisions(final, floorId, redundant.map((p) => ({
          op: "reject-door", doorId: p.doorId,
          record: rejectRecord(f, doorRecord(f, p.doorId), p.doorId, "Replaced by a source-supported opening"),
        })), { reviewer: ASSUMED_REVIEWER, reviewStatus: "agent-inspected", reason: "Assumed doorways replaced by source-supported openings" }).building;
        // Keep the assumed doors if removing them would leave any room unroutable.
        const ready = (x) => roomAvailability(x).filter((r) => r.floorId === floorId && r.ready).length;
        if (ready(trimmed) >= ready(final)) {
          final = trimmed;
          for (const p of redundant) placed.splice(placed.indexOf(p), 1);
        }
      } catch { /* keep the assumed doors if removing them fails validation */ }
  }
  const bridged = bridgeComponents(final, floorId);
  return { building: bridged.building, placed, skipped, roomed, enabled: [...enabled.doors, ...again.doors], bridged: bridged.doors };
}

// Groups of walking paths on one floor, keyed by node, over usable edges.
function components(building, floorId) {
  const nodes = building.nodes.filter((n) => n.floorId === floorId),
    adjacency = new Map(nodes.map((n) => [n.id, []]));
  for (const e of building.edges)
    if (adjacency.has(e.from) && adjacency.has(e.to) && !e.restricted && !edgeIssue(building, e)) {
      adjacency.get(e.from).push(e.to);
      adjacency.get(e.to).push(e.from);
    }
  const group = new Map();
  let next = 0;
  for (const n of nodes) {
    if (group.has(n.id)) continue;
    const queue = [n.id];
    group.set(n.id, next);
    for (let i = 0; i < queue.length; i++)
      for (const m of adjacency.get(queue[i])) if (!group.has(m)) { group.set(m, next); queue.push(m); }
    next++;
  }
  return { nodes, group };
}

// A detected opening the visual check called "unclear" (not wall or glazing) is
// switched on as an assumed door, at the detected position, only when it joins
// parts of the floor that are otherwise disconnected.
export function bridgeComponents(building, floorId, { limit = 12 } = {}) {
  const doors = [];
  for (let round = 0; round < limit; round++) {
    const f = building.floors.find((x) => x.id === floorId),
      { nodes, group } = components(building, floorId),
      // A disabled door's own node lists both spaces; it must not make them look connected.
      groupsOf = (spaceId, doorId) => new Set(nodes.filter((n) => n.spaceIds.includes(spaceId) && n.doorId !== doorId).map((n) => group.get(n.id)));
    const candidate = f.geometry.doors.find((door) => {
      const record = doorRecord(f, door.id);
      if (door.spaceIds.length !== 2 || record?.kind !== "opening" || record.status === "accepted" ||
        record.evidence?.verifier?.verdict !== "uncertain" || doors.includes(door.id)) return false;
      if (door.spaceIds.some((id) => regionNeedsSemanticReview(f, id) || f.geometry.spaces.find((s) => s.id === id)?.access === "nonwalkable")) return false;
      const [a, b] = door.spaceIds.map((id) => groupsOf(id, door.id));
      if (!a.size || !b.size || [...a].some((g) => b.has(g))) return false;
      const without = { ...f, geometry: { ...f.geometry, doors: f.geometry.doors.filter((d) => d.id !== door.id) } };
      return validateOpening(without, { spaceId: door.spaceIds[0], adjacentId: door.spaceIds[1], openingType: record.openingType || "door", a: door.a, b: door.b }).passed;
    });
    if (!candidate) break;
    const record = doorRecord(f, candidate.id);
    doors.push(candidate.id);
    try {
      building = applyAccessDecisions(building, floorId, [
        { op: "reject-door", doorId: candidate.id, record: rejectRecord(f, record, candidate.id, "Re-applied as an assumed opening") },
        { op: "opening", record: { ...record, id: `${candidate.id}:bridged:${Date.now().toString(36)}`, status: "accepted", label: "Assumed doorway",
          reason: "The visual check could not confirm this detected opening, but it is the only link between otherwise disconnected parts of the floor. Assumed; confirm, move or remove it.",
          evidence: { ...record.evidence, method: "assumed" } } },
      ], { reviewer: ASSUMED_REVIEWER, reviewStatus: "agent-inspected", reason: "Assumed opening joins disconnected areas" }).building;
    } catch { /* leave it for review if it fails a check */ }
  }
  return { building, doors: doors.filter((id) => doorRecord(building.floors.find((x) => x.id === floorId), id)?.evidence.method === "assumed") };
}

// Re-applies source-supported openings that were held back only because a
// linked region was awaiting classification. Each must still pass validation
// against the current geometry and the route check; any that do not are left alone.
export function enableSupportedDoors(building, floorId, spaceIds) {
  const floor = building.floors.find((f) => f.id === floorId),
    wanted = new Set(spaceIds),
    doors = [];
  let next = building;
  for (const door of floor.geometry.doors.filter((d) => d.spaceIds.some((id) => wanted.has(id)))) {
    const f = next.floors.find((x) => x.id === floorId),
      record = doorRecord(f, door.id);
    if (!record || record.kind !== "opening" || record.status !== "proposed" || record.evidence?.verifier?.verdict !== "supported" ||
      !record.evidence.crops?.length || door.spaceIds.some((id) => regionNeedsSemanticReview(f, id))) continue;
    const without = { ...f, geometry: { ...f.geometry, doors: f.geometry.doors.filter((d) => d.id !== door.id) } },
      check = validateOpening(without, { spaceId: door.spaceIds[0], adjacentId: door.spaceIds[1] || null, openingType: record.openingType, a: door.a, b: door.b });
    if (!check.passed) continue;
    try {
      next = applyAccessDecisions(next, floorId, [
        { op: "reject-door", doorId: door.id, record: rejectRecord(f, record, door.id, "Re-applied after its region was classified") },
        { op: "opening", record: { ...record, id: `${door.id}:enabled:${Date.now().toString(36)}`, status: "accepted",
          reason: "Original source supports this opening; re-applied once its linked region was no longer held for classification." } },
      ], { reviewer: "Hybrid API pipeline", reviewStatus: "agent-inspected", reason: "Source-supported opening re-applied" }).building;
      doors.push(door.id);
    } catch { /* route or geometry check failed: leave it for review */ }
  }
  return { building: next, doors };
}

// Adds another doorway to a room that may already have some. Hallways come
// before neighbouring rooms, and spaces the room has no door to yet before ones
// it does; on an edge that already has a door, the new one is offset along it.
// Move it afterwards like any assumed door.
// Shared edges a room can get a doorway on, with how many doors each already has.
export function doorEdgeOptions(floor, spaceId) {
  return neighbourEdges(floor, spaceId).candidates.map((c) => ({
    ...c,
    doors: floor.geometry.doors.filter((d) =>
      pointSegment({ x: (d.a.x + d.b.x) / 2, y: (d.a.y + d.b.y) / 2 }, c.a, c.b) < 1).length,
  }));
}

export function addAssumedDoor(building, floorId, spaceId, reviewer = "", { edgeKey = null } = {}) {
  const floor = building.floors.find((f) => f.id === floorId),
    room = floor?.geometry.spaces.find((s) => s.id === spaceId);
  if (!room) throw new Error("Unknown region.");
  if (room.access === "nonwalkable") throw new Error(`${room.label} is not a room; use Make it a room first.`);
  const linked = new Set(floor.geometry.doors.filter((d) => d.spaceIds.includes(spaceId)).flatMap((d) => d.spaceIds)),
    { candidates, near } = neighbourEdges(floor, spaceId),
    order = (c) => (c.hallway ? 0 : 2) + (linked.has(c.adjacentId) ? 1 : 0),
    // A chosen edge may already have doorways; the new one is spaced away from them.
    ordered = edgeKey === null ? [...candidates].sort((x, z) => order(x) - order(z)) : candidates.filter((c) => c.key === edgeKey),
    spot = placeOn(floor, room, ordered, null, true);
  if (!spot)
    throw new Error(edgeKey !== null && ordered.length ? `No free spot left on that edge; narrow or move one of its doorways first.`
      : candidates.length ? `No free spot on ${room.label}'s shared edges; move an existing doorway first.`
      : near.length ? `${room.label} does not touch any walkable space (${near[0].adjacentLabel} is ${near[0].gap} px away).`
        : `${room.label} shares no edge with a walkable space.`);
  const used = new Set([...floor.geometry.doors.map((d) => d.id), ...(floor.access?.records || []).map((r) => r.doorId)]);
  let doorId = `${spaceId}:assumed-door`;
  for (let n = 2; used.has(doorId); n++) doorId = `${spaceId}:assumed-door-${n}`;
  const record = assumedRecord(floor, room, spot.edge, spot.segment, doorId,
    `Additional doorway added by ${reviewer.trim() || "the developer"} on the edge shared with ${spot.edge.adjacentLabel}; move it to the real opening.`);
  const result = applyAccessDecisions(building, floorId, [{ op: "opening", record }], {
    reviewer: reviewer.trim() || "Developer edit", reviewStatus: "agent-inspected", reason: `Another doorway added to ${room.label}`,
  });
  return { building: result.building, doorId, opensOnto: spot.edge.adjacentLabel };
}

// Developer decision: this region is a room. It gets an assumed doorway at once.
export function defineAsRoom(building, floorId, spaceId, reviewer = "") {
  // Only a named person's decision is recorded as human-reviewed.
  const named = !!reviewer.trim(), who = reviewer.trim() || "Unnamed editor action",
    floor = building.floors.find((f) => f.id === floorId),
    space = floor?.geometry.spaces.find((s) => s.id === spaceId);
  if (!space) throw new Error("Unknown region.");
  const next = applyAccessDecisions(supersedeProposals(building, floorId, spaceId, who), floorId, [{
    op: "classify", spaceId, to: { kind: "room", access: "unknown" },
    record: classificationRecord(floor, space, `${space.label} defined as a room by ${who}.`, "manual"),
  }], { reviewer: who, reviewStatus: named ? "human-reviewed" : "agent-inspected", reason: `${space.label} defined as a room` }).building;
  return placeAssumedDoorways(next, floorId, { spaceIds: [spaceId], roomify: false });
}

// Developer decision: this region is not a room. It becomes non-walkable and any
// doors into it are removed, so it leaves the queue and is never routed through.
export function defineNotRoom(building, floorId, spaceId, reviewer = "") {
  const named = !!reviewer.trim(), who = reviewer.trim() || "Unnamed editor action",
    floor = building.floors.find((f) => f.id === floorId),
    space = floor?.geometry.spaces.find((s) => s.id === spaceId);
  if (!space) throw new Error("Unknown region.");
  const doors = floor.geometry.doors.filter((d) => d.spaceIds.includes(spaceId));
  return applyAccessDecisions(supersedeProposals(building, floorId, spaceId, who), floorId, [
    ...doors.map((d) => ({ op: "reject-door", doorId: d.id, record: rejectRecord(floor, doorRecord(floor, d.id) || {
      spaceId, openingType: d.spaceIds.length === 1 ? "exterior-door" : "door", adjacentIds: d.spaceIds, segment: { a: d.a, b: d.b }, label: d.label,
    }, d.id, `${space.label} marked as not a room by ${who}`) })),
    { op: "classify", spaceId, to: { access: "nonwalkable" },
      record: classificationRecord(floor, space, `${space.label} marked as not a room (non-walkable) by ${who}.`, "manual") },
  ], { reviewer: who, reviewStatus: named ? "human-reviewed" : "agent-inspected", reason: `${space.label} marked as not a room` }).building;
}

// Assumed doors on a floor, with their current edge and position for editing.
export function assumedDoors(floor) {
  return floor.geometry.doors
    .map((door) => ({ door, record: doorRecord(floor, door.id) }))
    .filter(({ record }) => isAssumed(record) && record.status === "accepted")
    .map(({ door, record }) => {
      const roomId = record.spaceId,
        room = floor.geometry.spaces.find((s) => s.id === roomId),
        { candidates } = neighbourEdges({ ...floor, geometry: { ...floor.geometry, doors: floor.geometry.doors.filter((d) => d.id !== door.id) } }, roomId),
        mid = { x: (door.a.x + door.b.x) / 2, y: (door.a.y + door.b.y) / 2 },
        edge = candidates.find((c) => c.adjacentId === door.spaceIds[1] && pointSegment(mid, c.a, c.b) < 1) || candidates[0] || null;
      return { door, record, room, candidates, edgeKey: edge?.key ?? null,
        t: edge ? distance(edge.a, mid) / edge.length : 0.5, width: distance(door.a, door.b) };
    });
}

// Moves an assumed door to another hallway edge, position or width. With
// `confirm`, a named developer records it as a manually reviewed opening.
export function editAssumedDoor(building, floorId, doorId, { edgeKey, t, width, confirm = false, reviewer = "" }) {
  const floor = building.floors.find((f) => f.id === floorId),
    old = floor?.geometry.doors.find((d) => d.id === doorId),
    record = old && doorRecord(floor, doorId);
  if (!old || !isAssumed(record)) throw new Error("That is not an assumed doorway.");
  if (confirm && !reviewer.trim()) throw new Error("Enter your name to confirm this doorway.");
  const room = floor.geometry.spaces.find((s) => s.id === record.spaceId),
    without = { ...floor, geometry: { ...floor.geometry, doors: floor.geometry.doors.filter((d) => d.id !== doorId) } },
    edge = neighbourEdges(without, room.id).candidates.find((c) => c.key === edgeKey);
  if (!edge) throw new Error("Pick the space this doorway opens onto.");
  const segment = assumedSegment(edge, t, width),
    next = assumedRecord(floor, room, edge, segment, doorId,
      confirm ? `Doorway placed and confirmed by ${reviewer} against the plan.` : `Assumed doorway moved by the developer onto the edge shared with ${edge.adjacentLabel}.`);
  if (confirm) {
    next.evidence = { ...next.evidence, method: "manual", description: `Confirmed by ${reviewer} after comparing with the original plan.` };
    next.label = "Doorway";
  }
  return applyAccessDecisions(building, floorId, [
    { op: "reject-door", doorId, record: rejectRecord(floor, record, doorId, confirm ? "Replaced by the confirmed doorway" : "Moved by the developer") },
    { op: "opening", record: next },
  ], confirm
    ? { reviewer, reviewStatus: "human-reviewed", reason: `Doorway confirmed for ${room.label}` }
    : { reviewer: reviewer.trim() || "Developer edit", reviewStatus: "agent-inspected", reason: `Assumed doorway moved for ${room.label}` }).building;
}

export function removeAssumedDoor(building, floorId, doorId, reviewer = "") {
  const floor = building.floors.find((f) => f.id === floorId),
    record = floor && doorRecord(floor, doorId);
  if (!isAssumed(record)) throw new Error("That is not an assumed doorway.");
  return applyAccessDecisions(building, floorId, [
    { op: "reject-door", doorId, record: rejectRecord(floor, record, doorId, "Assumed doorway removed by the developer") },
  ], { reviewer: reviewer.trim() || "Developer edit", reviewStatus: "agent-inspected", reason: "Assumed doorway removed" }).building;
}

function rejectRecord(floor, record, doorId, reason) {
  return newAccessRecord({
    id: `${doorId}:removed:${Date.now().toString(36)}`,
    kind: "rejected-door",
    status: "rejected",
    spaceId: record.spaceId,
    doorId,
    openingType: record.openingType,
    adjacentIds: record.adjacentIds,
    segment: record.segment,
    label: record.label,
    reason,
    evidence: { method: "assumed", description: reason, crops: [] },
    review: { status: "agent-inspected", reviewer: ASSUMED_REVIEWER, at: null, notes: "" },
    geometryRevision: floor.revision,
  });
}
