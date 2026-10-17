import { z } from "zod";
export const Point = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
const ID = z.string().min(1).max(100),
  Label = z.string().min(1).max(200);
const imageData = z
  .string()
  .refine(
    (s) => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s),
    "Expected embedded PNG, JPEG or WebP image",
  );
export const MapSchema = z.object({
  id: ID,
  version: z.literal(1),
  floorName: Label,
  source: z.object({
    name: Label,
    width: z.number().positive().max(10000),
    height: z.number().positive().max(10000),
    dataUrl: imageData,
    normalized: z.literal(true),
    provenance: z.string(),
    fictional: z.boolean(),
    originalWidth: z.number().optional(),
    originalHeight: z.number().optional(),
  }),
  coordinates: z.object({
    unit: z.literal("pixel"),
    origin: z.literal("top-left"),
    yAxis: z.literal("down"),
    imageToMap: z.tuple([
      z.literal(1),
      z.literal(0),
      z.literal(0),
      z.literal(1),
      z.literal(0),
      z.literal(0),
    ]),
  }),
  scale: z
    .object({
      pixelsPerMetre: z.number().positive(),
      a: Point,
      b: Point,
      knownMetres: z.number().positive(),
    })
    .nullable(),
  spaces: z
    .array(
      z.object({
        id: ID,
        label: Label,
        kind: z.enum(["room", "corridor", "lobby", "restroom", "storage"]),
        polygon: z.array(Point).min(3),
        confidence: z.number().min(0).max(1),
        access: z.enum(["known", "unknown", "nonwalkable"]).optional(),
      }),
    )
    .max(500),
  walls: z.array(z.object({ id: ID, points: z.array(Point).min(2) })).max(2000),
  doors: z
    .array(
      z.object({
        id: ID,
        label: Label,
        a: Point,
        b: Point,
        spaceIds: z.array(ID).min(1).max(2),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(500),
  pois: z.array(
    z.object({
      id: ID,
      label: Label,
      kind: z.enum(["entrance", "poi"]),
      position: Point,
      spaceId: ID,
    }),
  ),
  graph: z.object({
    nodes: z
      .array(
        z.object({
          id: ID,
          label: Label,
          position: Point,
          spaceIds: z.array(ID).min(1),
          doorId: ID.optional(),
        }),
      )
      .max(1500),
    edges: z.array(z.object({ id: ID, from: ID, to: ID })).max(10000),
  }),
  photos: z
    .array(
      z.object({
        id: ID,
        label: Label,
        position: Point,
        direction: z.number().min(0).max(359),
        dataUrl: imageData,
      }),
    )
    .max(100),
  review: z.object({
    status: z.enum(["draft", "reviewed"]),
    reviewer: z.string(),
    reviewedAt: z.string().nullable(),
    issues: z.array(
      z.object({
        id: ID,
        message: z.string(),
        resolved: z.boolean(),
        resolution: z.string(),
      }),
    ),
  }),
  extraction: z.object({
    provider: z.string(),
    model: z.string(),
    mode: z.enum(["sample", "live", "manual"]),
    createdAt: z.string(),
    notes: z.string(),
  }),
});
export const clone = (x) => JSON.parse(JSON.stringify(x));
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export function pointSegment(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    t = Math.max(
      0,
      Math.min(
        1,
        ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
      ),
    );
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}
export function inside(p, poly) {
  if (
    poly.some((a, i) => pointSegment(p, a, poly[(i + 1) % poly.length]) < 0.01)
  )
    return true;
  let yes = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      yes = !yes;
  }
  return yes;
}
const cross = (a, b, c) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
export function intersection(a, b, c, d) {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den,
    u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  if (t >= -1e-8 && t <= 1 + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8)
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), t };
  return null;
}
export function centre(poly) {
  const p = {
    x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
    y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
  };
  if (inside(p, poly)) return p;
  const xs = poly.map((p) => p.x),
    ys = poly.map((p) => p.y);
  for (let y = Math.min(...ys) + 1; y < Math.max(...ys); y += 5)
    for (let x = Math.min(...xs) + 1; x < Math.max(...xs); x += 5)
      if (inside({ x, y }, poly)) return { x, y };
  return poly[0];
}
export function edgeProblem(map, edge) {
  const a = map.graph.nodes.find((n) => n.id === edge.from),
    b = map.graph.nodes.find((n) => n.id === edge.to);
  if (!a || !b) return "references a missing node";
  if (a.id === b.id || distance(a.position, b.position) < 0.01)
    return "has zero length";
  for (const node of [a, b]) {
    if (
      node.spaceIds.some(
        (id) =>
          !map.spaces.some(
            (s) => s.id === id && inside(node.position, s.polygon),
          ),
      )
    )
      return "uses a node outside its linked space";
    if (node.doorId) {
      const door = map.doors.find((d) => d.id === node.doorId);
      if (
        !door ||
        pointSegment(node.position, door.a, door.b) > 1 ||
        node.spaceIds.some((id) => !door.spaceIds.includes(id))
      )
        return "uses a missing or detached doorway";
    }
    if (
      node.spaceIds.length > 1 &&
      !map.doors.some(
        (d) =>
          node.spaceIds.every((id) => d.spaceIds.includes(id)) &&
          pointSegment(node.position, d.a, d.b) < 1,
      )
    )
      return "uses a shared node without a door";
  }
  const p = a.position,
    q = b.position;
  const validDoors = map.doors.filter(
    (d) =>
      d.spaceIds.every((id) => map.spaces.some((s) => s.id === id)) &&
      d.spaceIds.every((id) => {
        const s = map.spaces.find((s) => s.id === id);
        return s.polygon.some(
          (v, i) =>
            pointSegment(d.a, v, s.polygon[(i + 1) % s.polygon.length]) <= 3 &&
            pointSegment(d.b, v, s.polygon[(i + 1) % s.polygon.length]) <= 3,
        );
      }),
  );
  const gate = (hit, spaceId) =>
    validDoors.some(
      (d) =>
        (!spaceId || d.spaceIds.includes(spaceId)) &&
        pointSegment(hit, d.a, d.b) < 1,
    );
  // Any intersection with an explicit wall is blocked unless inside a valid door gap.
  for (const w of map.walls)
    for (let i = 1; i < w.points.length; i++) {
      const c = w.points[i - 1],
        d = w.points[i],
        hit = intersection(p, q, c, d);
      if (hit && !gate(hit)) return "crosses a wall";
      if (
        Math.abs(cross(p, q, c)) < 0.001 &&
        Math.abs(cross(p, q, d)) < 0.001
      ) {
        const mid = midpoint(c, d);
        if (pointSegment(mid, p, q) < 0.01 && !gate(mid))
          return "runs along a wall";
      }
    }
  // Split at every space boundary, inspect each open interval (no sampling gaps).
  const cuts = [0, 1];
  for (const s of map.spaces)
    for (let i = 0; i < s.polygon.length; i++) {
      const hit = intersection(
        p,
        q,
        s.polygon[i],
        s.polygon[(i + 1) % s.polygon.length],
      );
      if (hit) {
        cuts.push(Math.max(0, Math.min(1, hit.t)));
        if (hit.t > 1e-6 && hit.t < 1 - 1e-6 && !gate(hit, s.id))
          return "crosses a space boundary without a door";
      }
    }
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    const t = (cuts[i - 1] + cuts[i]) / 2,
      pt = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    if (!map.spaces.some((s) => inside(pt, s.polygon)))
      return "leaves walkable space";
  }
  // A graph endpoint on a boundary must be an actual doorway if connecting different spaces.
  const common = a.spaceIds.filter((id) => b.spaceIds.includes(id));
  if (!common.length) {
    const door = validDoors.some(
      (d) =>
        d.spaceIds.some((id) => a.spaceIds.includes(id)) &&
        d.spaceIds.some((id) => b.spaceIds.includes(id)) &&
        intersection(p, q, d.a, d.b),
    );
    if (!door) return "connects spaces without a linked door";
  }
  return null;
}
export function shortestPath(map, from, to) {
  const nodes = map.graph.nodes;
  if (!nodes.some((n) => n.id === from) || !nodes.some((n) => n.id === to))
    return null;
  const dist = new Map(nodes.map((n) => [n.id, Infinity])),
    previous = new Map(),
    pending = new Set(nodes.map((n) => n.id));
  dist.set(from, 0);
  while (pending.size) {
    let current = [...pending].reduce((a, b) =>
      dist.get(a) < dist.get(b) ? a : b,
    );
    if (!Number.isFinite(dist.get(current))) break;
    pending.delete(current);
    if (current === to) {
      const path = [to];
      while (previous.has(path[0])) path.unshift(previous.get(path[0]));
      return { nodeIds: path, length: dist.get(to) };
    }
    for (const e of map.graph.edges) {
      if (edgeProblem(map, e)) continue;
      let next = e.from === current ? e.to : e.to === current ? e.from : null;
      if (!next || !pending.has(next)) continue;
      const n = nodes.find((n) => n.id === current),
        m = nodes.find((n) => n.id === next),
        cost = dist.get(current) + distance(n.position, m.position);
      if (cost < dist.get(next)) {
        dist.set(next, cost);
        previous.set(next, current);
      }
    }
  }
  return null;
}
export function deriveGraph(map) {
  const m = clone(map);
  m.graph = { nodes: [], edges: [] };
  for (const s of m.spaces)
    m.graph.nodes.push({
      id: `n-${s.id}`,
      label: s.label,
      position: centre(s.polygon),
      spaceIds: [s.id],
    });
  for (const d of m.doors) {
    if (d.spaceIds.length !== 2) continue;
    m.graph.nodes.push({
      id: `n-${d.id}`,
      label: d.label,
      position: midpoint(d.a, d.b),
      spaceIds: d.spaceIds,
      doorId: d.id,
    });
    for (const id of d.spaceIds) {
      const e = { id: `e-${d.id}-${id}`, from: `n-${id}`, to: `n-${d.id}` };
      if (!edgeProblem(m, e)) m.graph.edges.push(e);
    }
  }
  return m.graph;
}
export function validateMap(m) {
  const issues = [],
    add = (code, message, target, severity = "error") =>
      issues.push({ code, message, target, severity });
  const parsed = MapSchema.safeParse(m);
  if (!parsed.success)
    return parsed.error.issues.map((i) => ({
      code: "schema",
      message: `${i.path.join(".")}: ${i.message}`,
      severity: "error",
    }));
  if (!m.spaces.length)
    add(
      "empty",
      "No walkable spaces yet — extract or trace the floor plan.",
      null,
    );
  const ids = new Set();
  for (const [kind, items] of Object.entries({
    spaces: m.spaces,
    walls: m.walls,
    doors: m.doors,
    nodes: m.graph.nodes,
    edges: m.graph.edges,
    pois: m.pois,
    photos: m.photos,
  }))
    for (const item of items) {
      if (ids.has(item.id))
        add("duplicate", `Duplicate ID: ${item.id}`, { kind, id: item.id });
      ids.add(item.id);
    }
  const bounded = (p) =>
    p.x >= 0 && p.y >= 0 && p.x <= m.source.width && p.y <= m.source.height;
  for (const s of m.spaces) {
    const target = { kind: "spaces", id: s.id },
      p = s.polygon;
    let area = 0;
    for (let i = 0; i < p.length; i++) {
      let a = p[i],
        b = p[(i + 1) % p.length];
      area += a.x * b.y - b.x * a.y;
      if (distance(a, b) < 0.01)
        add("polygon", `${s.label}: duplicate vertices`, target);
      for (let j = i + 2; j < p.length; j++) {
        if (i === 0 && j === p.length - 1) continue;
        if (intersection(a, b, p[j], p[(j + 1) % p.length]))
          add("polygon", `${s.label}: polygon self-intersects`, target);
      }
    }
    if (Math.abs(area) < 2)
      add("polygon", `${s.label}: zero-area polygon`, target);
    if (!p.every(bounded))
      add("bounds", `${s.label}: vertices outside image`, target);
    if (
      !m.doors.some((d) => d.spaceIds.includes(s.id)) &&
      s.access !== "nonwalkable"
    )
      add(
        "door",
        `${s.label}: no connected doorway`,
        target,
        s.access === "unknown" ? "warning" : "error",
      );
  }
  const strictlyInside = (p, poly) =>
    inside(p, poly) &&
    poly.every(
      (a, i) => pointSegment(p, a, poly[(i + 1) % poly.length]) > 0.05,
    );
  for (let i = 0; i < m.spaces.length; i++)
    for (let j = i + 1; j < m.spaces.length; j++) {
      const a = m.spaces[i],
        b = m.spaces[j];
      const overlap =
        a.polygon.some((p) => strictlyInside(p, b.polygon)) ||
        b.polygon.some((p) => strictlyInside(p, a.polygon)) ||
        strictlyInside(centre(a.polygon), b.polygon) ||
        strictlyInside(centre(b.polygon), a.polygon) ||
        a.polygon.some((p, pi) =>
          b.polygon.some((q, qi) => {
            const p2 = a.polygon[(pi + 1) % a.polygon.length],
              q2 = b.polygon[(qi + 1) % b.polygon.length],
              hit = intersection(p, p2, q, q2);
            return (
              hit &&
              distance(hit, p) > 0.05 &&
              distance(hit, p2) > 0.05 &&
              distance(hit, q) > 0.05 &&
              distance(hit, q2) > 0.05
            );
          }),
        );
      if (overlap)
        add("overlap", `${a.label} overlaps ${b.label}`, {
          kind: "spaces",
          id: a.id,
        });
    }
  for (const w of m.walls)
    if (!w.points.every(bounded))
      add("bounds", `${w.id}: wall outside image`, { kind: "walls", id: w.id });
  for (const d of m.doors) {
    const t = { kind: "doors", id: d.id };
    if (!bounded(d.a) || !bounded(d.b) || distance(d.a, d.b) < 2)
      add("door", `${d.label}: invalid opening geometry`, t);
    for (const id of d.spaceIds) {
      const s = m.spaces.find((s) => s.id === id);
      if (!s) add("reference", `${d.label}: missing space ${id}`, t);
      else if (
        !s.polygon.some(
          (v, i) =>
            pointSegment(d.a, v, s.polygon[(i + 1) % s.polygon.length]) <= 3 &&
            pointSegment(d.b, v, s.polygon[(i + 1) % s.polygon.length]) <= 3,
        )
      )
        add("door", `${d.label}: opening is off the boundary of ${s.label}`, t);
    }
  }
  for (const n of m.graph.nodes) {
    const t = { kind: "nodes", id: n.id };
    for (const id of n.spaceIds) {
      const s = m.spaces.find((s) => s.id === id);
      if (!s) add("reference", `${n.label}: missing space ${id}`, t);
      else if (!inside(n.position, s.polygon))
        add("node", `${n.label}: node outside linked space`, t);
    }
    if (n.doorId) {
      const d = m.doors.find((d) => d.id === n.doorId);
      if (!d || pointSegment(n.position, d.a, d.b) > 1)
        add("node", `${n.label}: node is detached from its door`, t);
    }
  }
  for (const e of m.graph.edges) {
    const problem = edgeProblem(m, e);
    if (problem)
      add("edge", `Edge ${e.id} ${problem}`, { kind: "edges", id: e.id });
  }
  const originSpace =
    m.pois.find((p) => p.kind === "entrance")?.spaceId || m.spaces[0]?.id;
  const origin = m.graph.nodes.find(
    (n) => n.spaceIds.includes(originSpace) && !n.doorId,
  );
  for (const s of m.spaces) {
    const targets = m.graph.nodes.filter(
      (n) => n.spaceIds.includes(s.id) && !n.doorId,
    );
    if (!origin || !targets.some((n) => shortestPath(m, origin.id, n.id)))
      add("disconnected", `${s.label}: disconnected from entrance`, {
        kind: "spaces",
        id: s.id,
      });
  }
  for (const p of m.pois)
    if (
      !m.spaces.some((s) => s.id === p.spaceId && inside(p.position, s.polygon))
    )
      add("poi", `${p.label}: invalid space or position`, {
        kind: "pois",
        id: p.id,
      });
  for (const p of m.photos)
    if (!m.spaces.some((s) => inside(p.position, s.polygon)))
      add("photo", `${p.label}: photo outside mapped space`, {
        kind: "photos",
        id: p.id,
      });
  for (const i of m.review.issues)
    if (!i.resolved)
      add("review", i.message, { kind: "review", id: i.id }, "warning");
  if (!m.scale)
    add("scale", "Unscaled map — distances are shown in pixels", null, "info");
  return issues;
}
export function emptyMap(source) {
  return {
    id: `map-${Date.now()}`,
    version: 1,
    floorName: "Untitled floor",
    source,
    coordinates: {
      unit: "pixel",
      origin: "top-left",
      yAxis: "down",
      imageToMap: [1, 0, 0, 1, 0, 0],
    },
    scale: null,
    spaces: [],
    walls: [],
    doors: [],
    pois: [],
    graph: { nodes: [], edges: [] },
    photos: [],
    review: { status: "draft", reviewer: "", reviewedAt: null, issues: [] },
    extraction: {
      provider: "None",
      model: "None",
      mode: "manual",
      createdAt: new Date().toISOString(),
      notes: "Awaiting extraction or manual tracing.",
    },
  };
}
export function exportProject(m) {
  return JSON.stringify(MapSchema.parse(m), null, 2);
}
export function importProject(text) {
  return MapSchema.parse(JSON.parse(text));
}
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export function exportSVG(m) {
  const pts = (p) => p.map((v) => `${v.x},${v.y}`).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${m.source.width}" height="${m.source.height}" viewBox="0 0 ${m.source.width} ${m.source.height}"><title>${esc(m.floorName)}</title><metadata>${esc(JSON.stringify({ id: m.id, coordinates: m.coordinates, scale: m.scale, review: m.review, photos: m.photos.map(({ dataUrl, ...p }) => p) }))}</metadata><rect width="100%" height="100%" fill="#fafbf9"/>${m.spaces.map((s) => `<polygon points="${pts(s.polygon)}" fill="${s.kind === "corridor" ? "#e4e9ed" : "#e1efe9"}" stroke="#3c7e6a" stroke-width="2"/><text x="${centre(s.polygon).x}" y="${centre(s.polygon).y - 15}" text-anchor="middle" font-family="sans-serif" font-size="20">${esc(s.label)}</text>`).join("")}${m.walls.map((w) => `<polyline points="${pts(w.points)}" fill="none" stroke="#293c38" stroke-width="6"/>`).join("")}${m.doors.map((d) => `<line x1="${d.a.x}" y1="${d.a.y}" x2="${d.b.x}" y2="${d.b.y}" stroke="#f8fbf9" stroke-width="10"/><line x1="${d.a.x}" y1="${d.a.y}" x2="${d.b.x}" y2="${d.b.y}" stroke="#d68c34" stroke-width="4"/>`).join("")}${m.graph.edges
    .filter((e) => !edgeProblem(m, e))
    .map((e) => {
      const a = m.graph.nodes.find((n) => n.id === e.from).position,
        b = m.graph.nodes.find((n) => n.id === e.to).position;
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#328d76" stroke-width="3" stroke-dasharray="8 6"/>`;
    })
    .join(
      "",
    )}${m.pois.map((p) => `<circle cx="${p.position.x}" cy="${p.position.y}" r="8" fill="#d68c34"/><text x="${p.position.x}" y="${p.position.y + 30}" text-anchor="middle" font-family="sans-serif" font-size="18">${esc(p.label)}</text>`).join("")}${m.photos.map((p) => `<g transform="translate(${p.position.x} ${p.position.y}) rotate(${p.direction})"><circle r="9" fill="#8868bc"/><path d="M 0 -20 L -6 -10 L 6 -10 Z" fill="#8868bc"/></g>`).join("")}<text x="30" y="${m.source.height - 25}" font-family="sans-serif" font-size="16">${esc(m.review.status.toUpperCase())} · ${m.scale ? `${m.scale.pixelsPerMetre.toFixed(2)} px/m` : "UNSCALED · pixel coordinates"}${m.source.fictional ? " · FICTIONAL TEST PLAN" : ""}</text></svg>`;
}
