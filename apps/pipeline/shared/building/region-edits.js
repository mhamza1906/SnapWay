import { MERGE_SNAP, SPACE_KINDS, applyAccessDecisions, regionLabel, segmentOverlap, spaceRole } from "./access.js";

// Developer region edits: rename, mark or unmark a stair, set the kind, merge
// regions. Each runs through the shared access transaction (validation, wall
// cleanup, graph rebuild, evidence records). Only a named person's edit is
// recorded as human-reviewed; an unnamed edit is agent-inspected, like
// defineAsRoom.
const editor = (reviewer = "") => {
  const name = typeof reviewer === "string" ? reviewer.trim() : "";
  return { reviewer: name || "Unnamed editor action", reviewStatus: name ? "human-reviewed" : "agent-inspected" };
};
function regionOf(building, floorId, spaceId) {
  const floor = building.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  const space = floor.geometry.spaces.find((s) => s.id === spaceId);
  if (!space) throw new Error("Unknown region.");
  return space;
}

export function renameSpace(building, floorId, spaceId, label, reviewer = "") {
  const space = regionOf(building, floorId, spaceId),
    name = regionLabel(label);
  if (name === space.label) return building;
  return applyAccessDecisions(building, floorId, [{ op: "rename-space", spaceId, label: name }], {
    ...editor(reviewer), reason: `${space.label} renamed to ${name}`,
  }).building;
}

// `stair` true marks the region as a walkable stair (kind lobby, use stair);
// false makes it a room again. Asking for the current state changes nothing.
export function setSpaceStair(building, floorId, spaceId, stair, reviewer = "") {
  if (typeof stair !== "boolean") throw new Error("Say whether the region is a stair (stair: true or false).");
  const space = regionOf(building, floorId, spaceId);
  if ((space.use === "stair") === stair) return building;
  return applyAccessDecisions(building, floorId, [{ op: "set-space-use", spaceId, use: stair ? "stair" : null }], {
    ...editor(reviewer), reason: stair ? `${space.label} marked as a stair` : `${space.label} unmarked as a stair`,
  }).building;
}

// Sets a region's role (see SPACE_KINDS in access.js): "room", "hall-room" (a
// room that also works as a hall), "corridor", "lobby", "stair" or "closed"
// (cannot be entered; its doorways are kept, unused). Any role but "closed"
// re-opens a closed or non-walkable region with its doors. A stair given any
// other role is no longer a stair. Asking for the current role changes nothing.
export function setSpaceKind(building, floorId, spaceId, kind, reviewer = "") {
  if (!SPACE_KINDS.includes(kind))
    throw new Error(`Choose a region kind: ${SPACE_KINDS.slice(0, -1).join(", ")} or ${SPACE_KINDS.at(-1)}.`);
  const space = regionOf(building, floorId, spaceId);
  if (spaceRole(space) === kind) return building;
  return applyAccessDecisions(building, floorId, [{ op: "set-space-kind", spaceId, kind }], {
    ...editor(reviewer), reason: kind === "closed" ? `${space.label} closed` : `${space.label} set to ${kind}`,
  }).building;
}

// Regions that can be merged share a wall: some stretch of their outlines, at
// least MIN_SHARED px long, lies on the same line (within the merge snap).
// Touching at a corner is not enough. Returns a Map of id → neighbour ids for
// `spaces` (default: every region on the floor).
const MIN_SHARED = 4;
const boxOf = (p) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const v of p) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
  return { x0, y0, x1, y1 };
};
function sharesWall(a, b) {
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      const o = segmentOverlap(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length], MERGE_SNAP);
      if (o && o.length >= MIN_SHARED) return true;
    }
  return false;
}
export function mergeNeighbours(floor, spaces = floor.geometry.spaces) {
  const boxes = spaces.map((s) => boxOf(s.polygon)), out = new Map(spaces.map((s) => [s.id, []])), pad = MERGE_SNAP;
  for (let i = 0; i < spaces.length; i++)
    for (let j = i + 1; j < spaces.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x0 > b.x1 + pad || b.x0 > a.x1 + pad || a.y0 > b.y1 + pad || b.y0 > a.y1 + pad) continue;
      if (!sharesWall(spaces[i].polygon, spaces[j].polygon)) continue;
      out.get(spaces[i].id).push(spaces[j].id);
      out.get(spaces[j].id).push(spaces[i].id);
    }
  return out;
}

// Merges two regions that share a wall, one merge at a time: the second is
// merged into the first, which keeps its ID and its name (unless `label` is
// given, or the first has a default name and the second a real one). `stair`: true makes the result a stair, false a non-stair; omitted
// keeps a stair only if both were. Each merge is recorded so it can be undone
// with unmergeSpaces.
export function mergeSpaces(building, floorId, spaceIds, { label, stair, reviewer = "" } = {}) {
  const floor = building.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  if (!Array.isArray(spaceIds) || spaceIds.length !== 2) throw new Error("Merge two regions at a time.");
  if (Array.isArray(spaceIds) && spaceIds.length >= 2 && new Set(spaceIds).size === spaceIds.length) {
    const chosen = spaceIds.map((id) => floor.geometry.spaces.find((s) => s.id === id));
    if (chosen.every(Boolean)) {
      const links = mergeNeighbours(floor, chosen), seen = new Set([spaceIds[0]]), queue = [spaceIds[0]];
      for (let i = 0; i < queue.length; i++)
        for (const n of links.get(queue[i])) if (!seen.has(n)) { seen.add(n); queue.push(n); }
      const apart = chosen.filter((s) => !seen.has(s.id));
      if (apart.length)
        throw new Error(`Only regions that share a wall can be merged: ${apart.map((s) => s.label).join(", ")} ${apart.length === 1 ? "does" : "do"} not share a wall with the rest.`);
    }
  }
  if (stair !== undefined && typeof stair !== "boolean") throw new Error("stair must be true or false.");
  if (label !== undefined && label !== null && typeof label !== "string") throw new Error("The merged region's name must be text.");
  const use = stair === undefined ? undefined : stair ? "stair" : null,
    result = applyAccessDecisions(building, floorId, [{ op: "merge-spaces", spaceIds, label, use }], {
      ...editor(reviewer), reason: `Merged ${Array.isArray(spaceIds) ? spaceIds.length : 0} regions`,
    });
  return { building: result.building, spaceId: spaceIds[0] };
}

// Merges on a floor that can still be undone, newest first: the recorded merge,
// the region it produced (current name) and the region merged into it.
// `undoable` is false, with a reason, when the merged region changed shape
// since (a later merge must be undone first) or is gone.
export function mergeHistory(floor) {
  const spaces = floor.geometry.spaces;
  return (floor.access?.records || [])
    .filter((r) => r.kind === "classification" && r.merge && !r.merge.undone)
    .map((r) => {
      const u = r.merge, kept = spaces.find((s) => s.id === u.keptId);
      const same = !!kept && kept.polygon.length === u.after.length &&
        kept.polygon.every((p, i) => Math.abs(p.x - u.after[i].x) < 1e-6 && Math.abs(p.y - u.after[i].y) < 1e-6);
      const blocked = !kept ? "The merged region is no longer on the map."
        : spaces.some((s) => s.id === u.removedId) ? `${u.removed.label} is already on the map.`
        : !same ? "Merged again since; unmerge the later merge first."
        : null;
      return { recordId: r.id, keptId: u.keptId, label: kept?.label ?? u.kept.label, keptLabel: u.kept.label,
        removedId: u.removedId, removedLabel: u.removed.label, at: r.createdAt, undoable: !blocked, reason: blocked };
    })
    .reverse();
}

// Undoes one recorded merge: both regions come back as they were before it,
// the doorway between them is restored and checked again, and walking paths
// are rebuilt.
export function unmergeSpaces(building, floorId, recordId, reviewer = "") {
  const floor = building.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  const rec = (floor.access?.records || []).find((r) => r.id === recordId && r.merge);
  if (!rec) throw new Error("Unknown merge.");
  return applyAccessDecisions(building, floorId, [{ op: "unmerge-spaces", recordId }], {
    ...editor(reviewer), reason: `Unmerged ${rec.merge.removed.label} from ${rec.merge.kept.label}`,
  }).building;
}
