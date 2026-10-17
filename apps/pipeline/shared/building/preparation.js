import { clone, distance } from "../map.js";
export const applyTransform = (p, t) => ({
  x: t[0] * p.x + t[2] * p.y + t[4],
  y: t[1] * p.x + t[3] * p.y + t[5],
});
// Floor coordinates back to the source image frame.
export function invertTransform(p, [a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-8)
    throw new Error("Source transform cannot be inverted.");
  return {
    x: (d * (p.x - e) - c * (p.y - f)) / det,
    y: (-b * (p.x - e) + a * (p.y - f)) / det,
  };
}
export function similarityTransform(a, b) {
  const u = { x: b.image.x - a.image.x, y: b.image.y - a.image.y },
    v = { x: b.floor.x - a.floor.x, y: b.floor.y - a.floor.y },
    den = u.x * u.x + u.y * u.y;
  if (den < 1 || distance(a.floor, b.floor) < 1)
    throw new Error("Choose two distinct shared landmarks.");
  const c = (u.x * v.x + u.y * v.y) / den,
    s = (u.x * v.y - u.y * v.x) / den;
  return [
    c,
    s,
    -s,
    c,
    a.floor.x - c * a.image.x + s * a.image.y,
    a.floor.y - s * a.image.x - c * a.image.y,
  ];
}
export const sourceFeatureId = (source, id) =>
  id.startsWith(source.id + ":") || source.geometryIds?.includes(id)
    ? id
    : source.id + ":" + id;
export function transformGeometry(map, source) {
  const m = clone(map),
    p = (v) => applyTransform(v, source.transform),
    prefix = `${source.id}:`;
  const id = (v) => sourceFeatureId(source, v);
  m.spaces = m.spaces.map((s) => ({
    ...s,
    id: id(s.id),
    polygon: s.polygon.map(p),
  }));
  m.walls = m.walls.map((w) => ({
    ...w,
    id: id(w.id),
    points: w.points.map(p),
  }));
  m.doors = m.doors.map((d) => ({
    ...d,
    id: id(d.id),
    a: p(d.a),
    b: p(d.b),
    spaceIds: d.spaceIds.map(id),
  }));
  m.pois = m.pois.map((o) => ({
    ...o,
    id: id(o.id),
    position: p(o.position),
    spaceId: id(o.spaceId),
  }));
  return m;
}
export function mergeProposal(floor, sourceId, proposal) {
  const s = floor.sources.find((s) => s.id === sourceId);
  if (!s) throw new Error("Choose a source image.");
  if (s.alignment !== "reviewed")
    throw new Error(
      "Confirm this source’s alignment before accepting geometry.",
    );
  const n = transformGeometry(proposal, s),
    g = clone(floor.geometry),
    prefix = sourceId + ":";
  for (const key of ["spaces", "walls", "doors", "pois"])
    g[key] = [
      ...g[key].filter(
        (x) =>
          !x.id.startsWith(prefix) && !(s.geometryIds || []).includes(x.id),
      ),
      ...n[key],
    ];
  g.review = {
    status: "draft",
    reviewer: "",
    reviewedAt: null,
    issues: [
      ...g.review.issues.filter((i) => !i.id.startsWith(prefix)),
      ...proposal.review.issues.map((i) => ({
        ...i,
        id: prefix + i.id,
        resolved: false,
        resolution: "",
      })),
    ],
  };
  g.extraction = proposal.extraction;
  g.graph = { nodes: [], edges: [] };
  return g;
}
export function sourceSection(floor, spaceId) {
  const source = floor.sources.find(
    (s) => spaceId.startsWith(s.id + ":") || s.geometryIds.includes(spaceId),
  );
  return source?.sectionId || "reviewed-base";
}
export function sourceGeometry(floor, source) {
  const g = clone(floor.geometry),
    owned = new Set(source.geometryIds),
    keep = (id) => id.startsWith(source.id + ":") || owned.has(id);
  const [a, b, c, d, e, f] = source.transform,
    det = a * d - b * c;
  if (Math.abs(det) < 1e-8)
    throw new Error("Source transform cannot be inverted.");
  const p = (v) => ({
    x: (d * (v.x - e) - c * (v.y - f)) / det,
    y: (-b * (v.x - e) + a * (v.y - f)) / det,
  });
  g.spaces = g.spaces
    .filter((s) => keep(s.id))
    .map((s) => ({ ...s, polygon: s.polygon.map(p) }));
  const spaces = new Set(g.spaces.map((s) => s.id));
  g.doors = g.doors
    .filter((d) => d.spaceIds.every((id) => spaces.has(id)))
    .map((d) => ({ ...d, a: p(d.a), b: p(d.b) }));
  g.walls = g.walls
    .filter((w) => keep(w.id))
    .map((w) => ({ ...w, points: w.points.map(p) }));
  g.pois = g.pois
    .filter((o) => spaces.has(o.spaceId))
    .map((o) => ({ ...o, position: p(o.position) }));
  g.graph = { nodes: [], edges: [] };
  return g;
}
