import {
  inside,
  distance,
  pointSegment,
  edgeProblem,
  edgeContext,
  boxOf,
  nearPoint,
  validateMap,
  intersection,
} from "../map.js";
import { sourceSection } from "./preparation.js";
import { roomDoorNodes } from "./endpoints.js";
import { doorNodeProblem } from "./access-state.js";
export const pathLength = (path) =>
  path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0);
// What every segment check on a floor reads: its unusable doorways and its
// walkable geometry. Share one only while the floor and its access records
// stay unchanged (a read-only pass over a built building).
export function segmentContext(floor) {
  const g = {
    ...floor.geometry,
    spaces: floor.geometry.spaces.filter((s) => s.access !== "nonwalkable"),
  };
  return {
    unusable: floor.geometry.doors.filter((d) => doorNodeProblem(floor, d.id)),
    g,
    // Boxes skip doors and spaces too far away for the exact tests below.
    doorBoxes: g.doors.map((d) => boxOf([d.a, d.b])),
    spaceBoxes: g.spaces.map((s) => boxOf(s.polygon)),
    edges: null,
  };
}
export function segmentProblem(floor, a, b, context = segmentContext(floor)) {
  // Check the entire polyline segment, including a bend placed on a closed
  // opening. Checking graph endpoints alone allows edited edges to bypass it.
  for (const d of context.unusable) {
    if (intersection(a, b, d.a, d.b) ||
        pointSegment(a, d.a, d.b) < 0.01 ||
        pointSegment(b, d.a, d.b) < 0.01)
      return `unusable doorway ${d.id}`;
  }
  const { g, doorBoxes, spaceBoxes } = context;
  const node = (position, id) => {
    const d = g.doors.find(
      (d, i) =>
        nearPoint(position, doorBoxes[i], 0.6) &&
        pointSegment(position, d.a, d.b) < 0.5,
    );
    return {
      id,
      label: id,
      position,
      spaceIds: d
        ? d.spaceIds
        : g.spaces
            .filter(
              (s, i) =>
                nearPoint(position, spaceBoxes[i], 0.02) &&
                inside(position, s.polygon),
            )
            .map((s) => s.id),
      ...(d ? { doorId: d.id } : {}),
    };
  };
  const from = node(a, "segment-from"),
    to = node(b, "segment-to");
  if (!from.spaceIds.length || !to.spaceIds.length)
    return "leaves walkable geometry";
  if (distance(a, b) < 0.01) return null;
  context.edges ??= edgeContext(g);
  return edgeProblem(
    { ...g, graph: { nodes: [from, to], edges: [] } },
    { from: from.id, to: to.id, id: "segment" },
    context.edges,
  );
}
export function nodeProblem(b, n) {
  const f = b.floors.find((f) => f.id === n.floorId);
  if (!f) return "missing floor";
  if (
    n.spaceIds.some(
      (id) =>
        !f.geometry.spaces.some(
          (s) => s.id === id && inside(n.position, s.polygon),
        ),
    )
  )
    return "outside linked walkable space";
  if (n.doorId) {
    const d = f.geometry.doors.find((d) => d.id === n.doorId);
    if (!d || pointSegment(n.position, d.a, d.b) > 1)
      return "detached from doorway";
    const access = doorNodeProblem(f, d.id);
    if (access) return access;
  }
  return null;
}
// `contexts` (a Map from floor to segmentContext) lets a read-only pass over
// many edges derive each floor's segment context once.
export function edgeIssue(b, e, { requireReviewed = true, contexts = null } = {}) {
  const a = b.nodes.find((n) => n.id === e.from),
    z = b.nodes.find((n) => n.id === e.to);
  if (!a || !z) return "missing endpoint";
  if (e.from === e.to) return "same endpoint";
  if (
    distance(e.path[0], a.position) > 1 ||
    distance(e.path.at(-1), z.position) > 1
  )
    return "path endpoints detached";
  if (nodeProblem(b, a) || nodeProblem(b, z))
    return "invalid endpoint position";
  if (
    requireReviewed &&
    (e.status !== "reviewed" ||
      a.status !== "reviewed" ||
      z.status !== "reviewed")
  )
    return "needs graph revalidation";
  if (a.floorId !== z.floorId) {
    if (e.floorId !== null || !["stairs", "elevator"].includes(e.traversal))
      return "accidental floor link";
    const c = b.connectors.find((c) => c.id === e.connectorId);
    if (
      !c ||
      c.type !== e.traversal ||
      !c.landingIds.includes(a.id) ||
      !c.landingIds.includes(z.id) ||
      a.connectorId !== c.id ||
      z.connectorId !== c.id
    )
      return "unmatched connector landings";
    if (
      a.type !== (c.type === "stairs" ? "stair" : "elevator") ||
      z.type !== a.type
    )
      return "incorrect landing type";
    if (requireReviewed && c.status !== "reviewed")
      return "connector needs review";
    return null;
  }
  const f = b.floors.find((f) => f.id === a.floorId);
  if (e.floorId !== f.id || ["stairs", "elevator"].includes(e.traversal))
    return "inconsistent floor or traversal";
  if (
    requireReviewed &&
    (f.geometryStatus !== "reviewed" || e.geometryRevision !== f.revision)
  )
    return "geometry revision changed";
  if (
    distance(e.path[0], a.position) > 1 ||
    distance(e.path.at(-1), z.position) > 1
  )
    return "path endpoints detached";
  const sections = new Set(
    [...a.spaceIds, ...z.spaceIds].map((id) => sourceSection(f, id)),
  );
  if (sections.size > 1)
    return "source sections have no established relationship";
  let context = contexts?.get(f);
  if (!context) {
    context = segmentContext(f);
    contexts?.set(f, context);
  }
  for (let i = 1; i < e.path.length; i++) {
    const issue = segmentProblem(f, e.path[i - 1], e.path[i], context);
    if (issue) return issue;
  }
  if (pathLength(e.path) < 0.01) return "zero-length edge";
  return null;
}
export function geometryIssues(f) {
  return validateMap(f.geometry).filter(
    (i) =>
      !["disconnected", "review", "scale", "node", "edge"].includes(i.code),
  );
}
export function validateBuilding(b) {
  const issues = [],
    add = (code, message, target, floorId, severity = "error") =>
      issues.push({ code, message, target, floorId, severity });
  const edgeResults = new Map(),
    contexts = new Map();
  const checkEdge = (e) => {
    if (!edgeResults.has(e.id)) edgeResults.set(e.id, edgeIssue(b, e, { contexts }));
    return edgeResults.get(e.id);
  };
  const ids = new Set();
  for (const x of [
    ...b.floors,
    ...b.nodes,
    ...b.edges,
    ...b.photos,
    ...b.connectors,
    ...b.floors.flatMap((f) => [
      ...f.sources,
      ...f.geometry.spaces,
      ...f.geometry.doors,
      ...f.geometry.walls,
      ...f.geometry.pois,
    ]),
  ]) {
    if (ids.has(x.id)) add("duplicate", `Duplicate ID: ${x.id}`, x.id);
    ids.add(x.id);
  }
  for (const f of b.floors) {
    for (const issue of geometryIssues(f))
      add(
        issue.code,
        `${f.label}: ${issue.message}`,
        issue.target?.id,
        f.id,
        issue.severity,
      );
    for (const s of f.sources) {
      if (!b.assets[s.assetId] || !b.assets[s.originalAssetId])
        add("asset", `${s.name}: missing source asset`, s.id, f.id);
      if (s.alignment !== "reviewed")
        add(
          "alignment",
          `${s.name}: alignment needs review`,
          s.id,
          f.id,
          "warning",
        );
    }
    const labels = new Set();
    for (const r of f.geometry.spaces) {
      if (labels.has(r.label))
        add(
          "label-conflict",
          `${f.label}: repeated label ${r.label}; compare overlapping sources`,
          r.id,
          f.id,
          "warning",
        );
      labels.add(r.label);
    }
    if (f.geometryStatus !== "reviewed")
      add(
        "review",
        `${f.label}: geometry needs source review`,
        f.id,
        f.id,
        "warning",
      );
    for (const d of f.geometry.doors)
      if (
        !b.nodes.some(
          (n) =>
            n.floorId === f.id &&
            n.doorId === d.id &&
            b.edges.some(
              (e) => (e.from === n.id || e.to === n.id) && !checkEdge(e),
            ),
        )
      )
        add("door", `${d.label}: unconnected doorway`, d.id, f.id, "warning");
  }
  for (const n of b.nodes) {
    const err = nodeProblem(b, n);
    if (err) add("node", `${n.label}: ${err}`, n.id, n.floorId);
  }
  for (const e of b.edges) {
    const err = checkEdge(e);
    if (err) add("edge", `${e.id}: ${err}`, e.id, e.floorId);
  }
  for (const c of b.connectors) {
    const ns = c.landingIds.map((id) => b.nodes.find((n) => n.id === id));
    if (
      ns.some((n) => !n) ||
      new Set(ns.filter(Boolean).map((n) => n.floorId)).size !== ns.length
    )
      add("connector", `${c.label}: missing or duplicate-floor landing`, c.id);
    if (!c.evidence.trim() || c.status !== "reviewed")
      add(
        "connector",
        `${c.label}: connection evidence needs review`,
        c.id,
        undefined,
        "warning",
      );
  }
  for (const p of b.photos) {
    if (!!p.edgeId === !!p.nodeId)
      add(
        "photo",
        `${p.label}: choose exactly one edge or node association`,
        p.id,
        p.floorId,
      );
    if (!b.assets[p.assetId])
      add("photo", `${p.label}: missing image asset`, p.id, p.floorId);
    const target = p.edgeId
      ? b.edges.find((e) => e.id === p.edgeId && e.floorId === p.floorId)
      : b.nodes.find((n) => n.id === p.nodeId && n.floorId === p.floorId);
    if (!target || p.issue)
      add(
        "photo",
        `${p.label}: ${p.issue || "association is missing"}`,
        p.id,
        p.floorId,
      );
    if (p.buildingId !== b.id)
      add("photo", `${p.label}: wrong building`, p.id, p.floorId);
  }
  const usable = b.edges.filter((e) => !e.restricted && !checkEdge(e)),
    origin =
      b.nodes.find(
        (n) =>
          n.type === "entrance" &&
          n.status === "reviewed" &&
          usable.some((e) => e.from === n.id || e.to === n.id),
      ) ||
      b.nodes.find(
        (n) =>
          n.doorId &&
          n.status === "reviewed" &&
          usable.some((e) => e.from === n.id || e.to === n.id),
      );
  if (origin) {
    const seen = new Set([origin.id]),
      queue = [origin.id];
    while (queue.length) {
      const id = queue.shift();
      for (const e of usable) {
        const next =
          e.from === id
            ? e.to
            : e.to === id && e.direction === "both"
              ? e.from
              : null;
        if (next && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const f of b.floors)
      for (const s of f.geometry.spaces.filter(
        (s) =>
          !["corridor", "lobby"].includes(s.kind) && s.access !== "nonwalkable",
      ))
        if (!roomDoorNodes(b, s.id).some((n) => seen.has(n.id)))
          add(
            "disconnected",
            `${s.label}: doorways disconnected from ${origin.label}`,
            s.id,
            f.id,
            "warning",
          );
  }
  return issues;
}
