import { SPACE_KINDS, applyAccessDecisions, mergeType, regionLabel, spaceRole } from "./access.js";

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

// Regions close enough to merge: within `reach` of each other (touching counts,
// gap 0). The reach is 2% of the floor's larger side, at least 30 px.
export const mergeReach = (floor) => Math.max(30, 0.02 * Math.max(floor.width || 0, floor.height || 0));
const boxOf = (p) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const v of p) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
  return { x0, y0, x1, y1 };
};
const pointToSegment = (v, s, t) => {
  const dx = t.x - s.x, dy = t.y - s.y, len2 = dx * dx + dy * dy || 1,
    k = Math.max(0, Math.min(1, ((v.x - s.x) * dx + (v.y - s.y) * dy) / len2));
  return Math.hypot(v.x - (s.x + k * dx), v.y - (s.y + k * dy));
};
function within(a, b, reach) {
  for (const [from, to] of [[a, b], [b, a]])
    for (const v of from)
      for (let j = 0; j < to.length; j++) if (pointToSegment(v, to[j], to[(j + 1) % to.length]) <= reach) return true;
  return false;
}
// id → ids of the `spaces` (default: every region on the floor) within reach.
export function mergeNeighbours(floor, spaces = floor.geometry.spaces, reach = mergeReach(floor)) {
  const boxes = spaces.map((s) => boxOf(s.polygon)), out = new Map(spaces.map((s) => [s.id, []]));
  for (let i = 0; i < spaces.length; i++)
    for (let j = i + 1; j < spaces.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x0 > b.x1 + reach || b.x0 > a.x1 + reach || a.y0 > b.y1 + reach || b.y0 > a.y1 + reach) continue;
      if (!within(spaces[i].polygon, spaces[j].polygon, reach)) continue;
      out.get(spaces[i].id).push(spaces[j].id);
      out.get(spaces[j].id).push(spaces[i].id);
    }
  return out;
}

// Merges two or more rooms into the first, which keeps its ID and its name
// (unless `label` is given, or it has a default name and another a real one).
// The rooms need not touch: each must be within reach of at least one other
// chosen room (not only the kept one); small gaps are bridged. `stair`: true
// makes the result a stair, false a non-stair; omitted keeps a stair only if
// all were. Each merge is recorded so it can be undone with unmergeSpaces.
export function mergeSpaces(building, floorId, spaceIds, { label, stair, reviewer = "" } = {}) {
  const floor = building.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  if (Array.isArray(spaceIds) && spaceIds.length >= 2 && new Set(spaceIds).size === spaceIds.length) {
    const chosen = spaceIds.map((id) => floor.geometry.spaces.find((s) => s.id === id));
    if (chosen.every(Boolean)) {
      const type = mergeType(chosen[0]), other = chosen.find((s) => mergeType(s) !== type);
      if (other)
        throw new Error(`Hallways, rooms and stairs only merge with their own type: ${chosen[0].label} is a ${type}, ${other.label} is a ${mergeType(other)}.`);
      const links = mergeNeighbours(floor, chosen), seen = new Set([spaceIds[0]]), queue = [spaceIds[0]];
      for (let i = 0; i < queue.length; i++)
        for (const n of links.get(queue[i])) if (!seen.has(n)) { seen.add(n); queue.push(n); }
      const apart = chosen.filter((s) => !seen.has(s.id));
      if (apart.length)
        throw new Error(`Only rooms close to each other can be merged: ${apart.map((s) => s.label).join(", ")} ${apart.length === 1 ? "is" : "are"} too far from the others.`);
    }
  }
  if (stair !== undefined && typeof stair !== "boolean") throw new Error("stair must be true or false.");
  if (label !== undefined && label !== null && typeof label !== "string") throw new Error("The merged region's name must be text.");
  const use = stair === undefined ? undefined : stair ? "stair" : null,
    result = applyAccessDecisions(building, floorId, [{ op: "merge-spaces", spaceIds, label, use, maxGap: mergeReach(floor) }], {
      ...editor(reviewer), reason: `Merged ${Array.isArray(spaceIds) ? spaceIds.length : 0} regions`,
    });
  const afterSpaces = result.building.floors.find((f) => f.id === floorId).geometry.spaces,
    after = new Map(afterSpaces.map((s) => [s.id, s])),
    absorbed = floor.geometry.spaces.filter((s) => !spaceIds.includes(s.id) && !after.has(s.id)).map((s) => ({ id: s.id, label: s.label })),
    carved = floor.geometry.spaces.filter((s) => !spaceIds.includes(s.id) && after.has(s.id) && JSON.stringify(after.get(s.id).polygon) !== JSON.stringify(s.polygon))
      .map((s) => ({ id: s.id, label: s.label }));
  // `absorbed`: regions between the chosen rooms taken whole; `carved`: regions
  // that gave up only the part directly between the rooms.
  return { building: result.building, spaceId: spaceIds[0], absorbed, carved };
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
      const removed = u.removedAll?.length ? u.removedAll : [u.removed],
        back = removed.find((r) => spaces.some((s) => s.id === r.id)),
        parts = (u.carved || []).map((c) => `part of ${c.label}`);
      const blocked = !kept ? "The merged region is no longer on the map."
        : back ? `${back.label} is already on the map.`
        : !same ? "Merged again since; unmerge the later merge first."
        : null;
      return { recordId: r.id, keptId: u.keptId, label: kept?.label ?? u.kept.label, keptLabel: u.kept.label,
        removedId: u.removedId, removedLabel: [...removed.map((x) => x.label), ...parts].join(", "), removedCount: removed.length,
        at: r.createdAt, undoable: !blocked, reason: blocked };
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
    ...editor(reviewer), reason: `Unmerged ${(rec.merge.removedAll?.length ? rec.merge.removedAll : [rec.merge.removed]).map((x) => x.label).join(", ")} from ${rec.merge.kept.label}`,
  }).building;
}

// Thin strips: regions the raster cut between double wall lines or along a
// corridor's grey edge, with no room to walk. A region is a strip when under
// STRIP_THICK_SHARE of its area lies more than STRIP_CLEARANCE (at least 4 px,
// 0.2% of the floor's larger side) from its outline; regions with a printed
// name are never strips. Each strip is folded into the neighbour it shares the
// most outline with, as an ordinary merge that can be undone.
export const STRIP_THICK_SHARE = 0.2;
const STRIP_CLEARANCE = 0.002, STRIP_TOUCH = 2.5;
const unnamed = (s) => /^(unlabelled|unlabeled|hallway)\b/i.test(s.label);
const ringArea = (p) => Math.abs(p.reduce((t, a, i) => t + a.x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * a.y, 0) / 2);
const ringLength = (p) => p.reduce((t, a, i) => t + Math.hypot(p[(i + 1) % p.length].x - a.x, p[(i + 1) % p.length].y - a.y), 0);
const stripBox = (p) => ({ x0: Math.min(...p.map((q) => q.x)), x1: Math.max(...p.map((q) => q.x)), y0: Math.min(...p.map((q) => q.y)), y1: Math.max(...p.map((q) => q.y)) });
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy || 1, k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l));
  return Math.hypot(p.x - a.x - k * dx, p.y - a.y - k * dy);
}
const ringDist = (p, ring) => { let d = Infinity; for (let i = 0; i < ring.length; i++) d = Math.min(d, segDist(p, ring[i], ring[(i + 1) % ring.length])); return d; };
function insideRing(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    if (ring[i].y > p.y !== ring[j].y > p.y && p.x < ((ring[j].x - ring[i].x) * (p.y - ring[i].y)) / (ring[j].y - ring[i].y) + ring[i].x) c = !c;
  return c;
}

/** The floor's thin strips, each with the neighbour it would be folded into. */
export function thinStrips(floor) {
  const spaces = floor.geometry.spaces, all = spaces.flatMap((s) => s.polygon);
  if (!all.length) return [];
  const box = stripBox(all), clearance = Math.max(4, STRIP_CLEARANCE * Math.max(box.x1 - box.x0, box.y1 - box.y0)),
    boxes = new Map(spaces.map((s) => [s.id, stripBox(s.polygon)]));
  const strips = spaces.filter((s) => {
    // Cheap first: a strip's mean width (2 × area / outline) is small.
    if (!unnamed(s) || s.id.includes(":seam-") || (2 * ringArea(s.polygon)) / ringLength(s.polygon) > 2.5 * clearance) return false;
    const b = boxes.get(s.id);
    let n = 0, thick = 0;
    for (let x = b.x0 + 0.5; x < b.x1; x++)
      for (let y = b.y0 + 0.5; y < b.y1; y++) {
        const p = { x, y };
        if (!insideRing(p, s.polygon)) continue;
        n++;
        if (ringDist(p, s.polygon) > clearance) thick++;
      }
    return n > 0 && thick < STRIP_THICK_SHARE * n;
  });
  // Shared outline: samples every 2 px along the strip's outline that lie on
  // another region's outline (merge seams count for their kept region).
  return strips.map((s) => {
    const b = boxes.get(s.id), near = spaces.filter((o) => {
      const q = boxes.get(o.id);
      return o.id !== s.id && q.x0 <= b.x1 + STRIP_TOUCH && q.x1 >= b.x0 - STRIP_TOUCH && q.y0 <= b.y1 + STRIP_TOUCH && q.y1 >= b.y0 - STRIP_TOUCH;
    }), shared = new Map();
    for (let i = 0; i < s.polygon.length; i++) {
      const a = s.polygon[i], c = s.polygon[(i + 1) % s.polygon.length], steps = Math.max(1, Math.round(Math.hypot(c.x - a.x, c.y - a.y) / 2));
      for (let k = 0; k < steps; k++) {
        const p = { x: a.x + ((c.x - a.x) * (k + 0.5)) / steps, y: a.y + ((c.y - a.y) * (k + 0.5)) / steps };
        let best = null, bestD = STRIP_TOUCH;
        for (const o of near) { const d = ringDist(p, o.polygon); if (d < bestD) { bestD = d; best = o; } }
        if (best) {
          const id = best.id.replace(/:seam-\d+$/, "");
          shared.set(id, (shared.get(id) || 0) + Math.hypot(c.x - a.x, c.y - a.y) / steps);
        }
      }
    }
    const [hostId] = [...shared].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0] || [];
    return { id: s.id, label: s.label, hostId: hostId ?? null, hostLabel: spaces.find((o) => o.id === hostId)?.label ?? null };
  });
}

// Folds every thin strip on the floor into its neighbour. A strip whose
// neighbour is itself a strip follows it to where that one goes. One undoable
// merge per strip, all in one transaction; if that fails, strips are folded
// one at a time and any that cannot be are skipped with the reason.
export function absorbThinStrips(building, floorId, reviewer = "") {
  const floor = building.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  const strips = thinStrips(floor).filter((s) => s.hostId), into = new Map(strips.map((s) => [s.id, s.hostId]));
  const final = (id) => { const seen = new Set(); while (into.has(id) && !seen.has(id)) { seen.add(id); id = into.get(id); } return id; };
  // Strips whose neighbour stays go first; a chain ending back at itself keeps one strip.
  const planned = [];
  for (const s of [...strips].sort((a, z) => Number(into.has(a.hostId)) - Number(into.has(z.hostId)))) {
    const host = final(s.hostId);
    if (host === s.id) { into.delete(s.id); continue; }
    planned.push({ ...s, hostId: host, hostLabel: floor.geometry.spaces.find((o) => o.id === host)?.label ?? s.hostLabel });
  }
  const fold = (b, list) => applyAccessDecisions(b, floorId, list.map((s) => ({ op: "merge-spaces", spaceIds: [s.hostId, s.id], maxGap: 0 })), {
    ...editor(reviewer), reason: list.length === 1 ? `Thin strip ${list[0].label} folded into ${list[0].hostLabel}` : `${list.length} thin strips folded into their neighbours`,
  }).building;
  if (!planned.length) return { building, absorbed: [], skipped: [] };
  try { return { building: fold(building, planned), absorbed: planned, skipped: [] }; } catch { /* one at a time below */ }
  let current = building;
  const absorbed = [], skipped = [];
  for (const s of planned)
    try { current = fold(current, [s]); absorbed.push(s); }
    catch (e) { skipped.push({ id: s.id, label: s.label, reason: e.message }); }
  return { building: current, absorbed, skipped };
}
