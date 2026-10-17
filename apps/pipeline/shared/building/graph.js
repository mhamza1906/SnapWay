import { clone, centre, inside, midpoint, distance } from "../map.js";
import {
  segmentProblem,
  edgeIssue,
  pathLength,
  nodeProblem,
} from "./validation.js";
import { doorNodeProblem } from "./access-state.js";
export function pathInside(floor, space, start, end) {
  const valid = (a, b) => {
    for (let j = 0; j <= 20; j++) {
      const t = j / 20;
      if (
        !inside(
          { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
          space.polygon,
        )
      )
        return false;
    }
    return !segmentProblem(floor, a, b);
  };
  if (valid(start, end)) return [start, end];
  const c = centre(space.polygon),
    points = [
      start,
      end,
      ...space.polygon
        .map((p) => {
          const l = distance(p, c) || 1;
          return {
            x: p.x + ((c.x - p.x) * 2) / l,
            y: p.y + ((c.y - p.y) * 2) / l,
          };
        })
        .filter((p) => inside(p, space.polygon)),
    ];
  const costs = points.map(() => Infinity),
    previous = [],
    pending = new Set(points.map((_, i) => i));
  costs[0] = 0;
  while (pending.size) {
    const i = [...pending].reduce((a, b) => (costs[a] < costs[b] ? a : b));
    pending.delete(i);
    if (!Number.isFinite(costs[i])) break;
    if (i === 1) {
      const path = [points[1]];
      let k = 1;
      while (k !== 0) {
        k = previous[k];
        path.unshift(points[k]);
      }
      return path;
    }
    for (const j of pending)
      if (
        valid(points[i], points[j]) &&
        costs[i] + distance(points[i], points[j]) < costs[j]
      ) {
        costs[j] = costs[i] + distance(points[i], points[j]);
        previous[j] = i;
      }
  }
  return null;
}
export function newNode(
  id,
  floorId,
  label,
  type,
  position,
  spaceIds,
  extra = {},
) {
  return {
    id: boundedId(id),
    floorId,
    label,
    type,
    position,
    spaceIds,
    doorId: null,
    connectorId: null,
    status: "draft",
    ...extra,
  };
}
export function simplifyPath(floor, path) {
  const result = [];
  for (const point of path) {
    if (result.length && distance(result.at(-1), point) < 0.001) continue;
    while (result.length >= 2) {
      const a = result.at(-2),
        m = result.at(-1),
        cross = (m.x - a.x) * (point.y - m.y) - (m.y - a.y) * (point.x - m.x),
        dot = (m.x - a.x) * (point.x - m.x) + (m.y - a.y) * (point.y - m.y);
      if (
        Math.abs(cross) > 0.0001 ||
        dot < 0 ||
        segmentProblem(floor, a, point)
      )
        break;
      result.pop();
    }
    result.push(point);
  }
  return result.length >= 2 ? result : path;
}
// Composite IDs can exceed the schema's 150-character limit on long corridor
// chains; keep them deterministic but bounded.
export function boundedId(id, max = 150) {
  if (id.length <= max) return id;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  const tag = `~${(h >>> 0).toString(36)}${id.length.toString(36)}`;
  return id.slice(0, max - tag.length) + tag;
}

export function newEdge(id, floor, a, b, path, extra = {}) {
  path = simplifyPath(floor, path);
  return {
    id: boundedId(id),
    from: a.id,
    to: b.id,
    floorId: floor.id,
    path,
    direction: "both",
    traversal: "corridor",
    connectorId: null,
    length: pathLength(path) / (floor.geometry.scale?.pixelsPerMetre || 1),
    units: floor.geometry.scale ? "m" : "px",
    accessible: "unknown",
    restricted: false,
    status: "draft",
    photoIds: [],
    geometryRevision: floor.revision,
    ...extra,
  };
}
export function buildGraph(building, floorId) {
  const b = clone(building),
    f = b.floors.find((f) => f.id === floorId);
  if (f.geometryStatus !== "reviewed")
    throw new Error("Review the floor geometry before building paths.");
  const oldEdges = new Map(
    b.edges.filter((e) => e.floorId === floorId).map((e) => [e.id, e]),
  );
  const oldIds = new Set(
    b.nodes
      .filter((n) => n.floorId === floorId && !n.connectorId)
      .map((n) => n.id),
  );
  b.nodes = b.nodes.filter((n) => !oldIds.has(n.id));
  b.edges = b.edges.filter((e) => !oldIds.has(e.from) && !oldIds.has(e.to));
  for (const d of f.geometry.doors)
    if (!doorNodeProblem(f, d.id) && !b.nodes.some((n) => n.id === `${d.id}:nav`))
      b.nodes.push(
        newNode(
          `${d.id}:nav`,
          f.id,
          d.label,
          d.spaceIds.length === 1 ? "entrance" : "doorway",
          midpoint(d.a, d.b),
          d.spaceIds,
          { doorId: d.id },
        ),
      );
  for (const s of f.geometry.spaces) {
    if (s.access === "nonwalkable") continue;
    const doors = b.nodes.filter(
      (n) =>
        n.floorId === f.id &&
        n.spaceIds.includes(s.id) &&
        (n.doorId || n.connectorId),
    );
    if (s.kind === "corridor") {
      // Rectangular corridors use a centre-line spine with decision nodes at door projections.
      const xs = s.polygon.map((p) => p.x),
        ys = s.polygon.map((p) => p.y),
        xmin = Math.min(...xs),
        xmax = Math.max(...xs),
        ymin = Math.min(...ys),
        ymax = Math.max(...ys),
        horizontal = xmax - xmin >= ymax - ymin;
      const rectangular =
        s.polygon.length === 4 &&
        s.polygon.every(
          (p) =>
            (p.x === xmin || p.x === xmax) && (p.y === ymin || p.y === ymax),
        );
      if (rectangular) {
        const spine = [];
        for (const d of doors) {
          // An end-wall door must connect to an interior point. Projecting it
          // onto the wall either creates a disconnected duplicate node or runs
          // along a wall outside the opening.
          const insetX = Math.min(2, (xmax - xmin) / 4),
            insetY = Math.min(2, (ymax - ymin) / 4);
          const p = horizontal
            ? {
                x: Math.max(
                  xmin + insetX,
                  Math.min(xmax - insetX, d.position.x),
                ),
                y: (ymin + ymax) / 2,
              }
            : {
                x: (xmin + xmax) / 2,
                y: Math.max(
                  ymin + insetY,
                  Math.min(ymax - insetY, d.position.y),
                ),
              };
          let n = spine.find((n) => distance(n.position, p) < 1);
          if (!n) {
            n = newNode(
              `${s.id}:junction:${Math.round(p.x)}:${Math.round(p.y)}`,
              f.id,
              `${s.label} junction`,
              "junction",
              p,
              [s.id],
            );
            spine.push(n);
            b.nodes.push(n);
          }
          if (distance(n.position, d.position) > 0.1)
            b.edges.push(
              newEdge(`${d.id}:${s.id}`, f, d, n, [d.position, p], {
                traversal: d.doorId ? "doorway" : "corridor",
              }),
            );
        }
        spine.sort((a, b) =>
          horizontal
            ? a.position.x - b.position.x
            : a.position.y - b.position.y,
        );
        for (let i = 1; i < spine.length; i++)
          b.edges.push(
            newEdge(`${s.id}:spine:${i}`, f, spine[i - 1], spine[i], [
              spine[i - 1].position,
              spine[i].position,
            ]),
          );
        continue;
      }
      // Axis-aligned cell centres form an interior spine for L-shaped corridors.
      const xs2 = [...new Set(s.polygon.map((p) => p.x))].sort((a, b) => a - b),
        ys2 = [...new Set(s.polygon.map((p) => p.y))].sort((a, b) => a - b),
        cells = [];
      if (xs2.length * ys2.length <= 20000) {
        for (let x = 1; x < xs2.length; x++)
          for (let y = 1; y < ys2.length; y++) {
            const p = {
              x: (xs2[x - 1] + xs2[x]) / 2,
              y: (ys2[y - 1] + ys2[y]) / 2,
            };
            if (inside(p, s.polygon)) {
              const n = newNode(
                `${s.id}:cell:${x}:${y}`,
                f.id,
                `${s.label} decision point`,
                "junction",
                p,
                [s.id],
              );
              cells.push({
                n,
                x,
                y,
                xmin: xs2[x - 1],
                xmax: xs2[x],
                ymin: ys2[y - 1],
                ymax: ys2[y],
              });
              b.nodes.push(n);
            }
          }
        for (let i = 0; i < cells.length; i++)
          for (let j = i + 1; j < cells.length; j++) {
            const a = cells[i],
              z = cells[j];
            if (
              Math.abs(a.x - z.x) + Math.abs(a.y - z.y) === 1 &&
              !segmentProblem(f, a.n.position, z.n.position)
            )
              b.edges.push(
                newEdge(`${a.n.id}:${z.n.id}`, f, a.n, z.n, [
                  a.n.position,
                  z.n.position,
                ]),
              );
          }
        // Extend terminal cells along their centreline. Door approaches can
        // then join the nearest point on the spine instead of detouring to a
        // distant cell centre (particularly on a long main hallway).
        let linkId = 0;
        const link = (a, z) =>
          newEdge(`${s.id}:link:${linkId++}`, f, a, z, [
            a.position,
            z.position,
          ]);
        for (const c of cells) {
          const horizontal = c.xmax - c.xmin >= c.ymax - c.ymin;
          for (const sign of [-1, 1]) {
            if (
              cells.some((other) =>
                horizontal
                  ? other.y === c.y && other.x === c.x + sign
                  : other.x === c.x && other.y === c.y + sign,
              )
            )
              continue;
            const inset = Math.min(
              2,
              (horizontal ? c.xmax - c.xmin : c.ymax - c.ymin) / 4,
            );
            const p = horizontal
              ? {
                  x: sign < 0 ? c.xmin + inset : c.xmax - inset,
                  y: c.n.position.y,
                }
              : {
                  x: c.n.position.x,
                  y: sign < 0 ? c.ymin + inset : c.ymax - inset,
                };
            if (
              distance(p, c.n.position) < 0.1 ||
              segmentProblem(f, p, c.n.position)
            )
              continue;
            const n = newNode(
              `${c.n.id}:end:${sign}`,
              f.id,
              `${s.label} spine end`,
              "junction",
              p,
              [s.id],
            );
            b.nodes.push(n);
            b.edges.push(link(c.n, n));
          }
        }
        for (const d of doors) {
          const spineEdges = b.edges.filter(
            (e) =>
              e.floorId === f.id &&
              [e.from, e.to].every(
                (id) =>
                  b.nodes.find((n) => n.id === id)?.spaceIds.length === 1 &&
                  b.nodes.find((n) => n.id === id)?.spaceIds[0] === s.id,
              ),
          );
          const targets = spineEdges
            .map((e) => {
              const a = e.path[0],
                z = e.path.at(-1),
                dx = z.x - a.x,
                dy = z.y - a.y;
              const t = Math.max(
                0,
                Math.min(
                  1,
                  ((d.position.x - a.x) * dx + (d.position.y - a.y) * dy) /
                    (dx * dx + dy * dy),
                ),
              );
              const p = { x: a.x + t * dx, y: a.y + t * dy };
              return { edge: e, p, proximity: distance(d.position, p) };
            })
            .sort((a, z) => a.proximity - z.proximity)
            .slice(0, 8)
            .map((c) => ({ ...c, path: pathInside(f, s, d.position, c.p) }))
            .filter((c) => c.path)
            .sort((a, z) => pathLength(a.path) - pathLength(z.path));
          if (targets.length) {
            const t = targets[0];
            const a = b.nodes.find((n) => n.id === t.edge.from),
              z = b.nodes.find((n) => n.id === t.edge.to);
            let n =
              distance(t.p, a.position) < 0.01
                ? a
                : distance(t.p, z.position) < 0.01
                  ? z
                  : null;
            if (!n) {
              n = newNode(
                `${d.id}:${s.id}:junction`,
                f.id,
                `${s.label} doorway junction`,
                "junction",
                t.p,
                [s.id],
              );
              b.nodes.push(n);
              b.edges = b.edges.filter((e) => e !== t.edge);
              b.edges.push(link(a, n), link(n, z));
            }
            if (pathLength(t.path) > 0.01)
              b.edges.push(
                newEdge(`${d.id}:${s.id}`, f, d, n, t.path, {
                  traversal: d.doorId ? "doorway" : "corridor",
                }),
              );
          }
        }
        if (cells.length) continue;
      }
    }
    const connector = b.nodes.find(
      (n) => n.floorId === f.id && n.connectorId && n.spaceIds.includes(s.id),
    );
    if (!["corridor", "lobby"].includes(s.kind) && !connector) {
      // Rooms terminate at their actual doors. When a room has multiple
      // openings, retain valid door-to-door traversal without a centre hub.
      for (let i = 0; i < doors.length; i++)
        for (let j = i + 1; j < doors.length; j++) {
          const path = pathInside(f, s, doors[i].position, doors[j].position);
          if (path && pathLength(path) > 0.01)
            b.edges.push(
              newEdge(
                `${s.id}:door-link:${i}:${j}`,
                f,
                doors[i],
                doors[j],
                path,
                { traversal: "doorway" },
              ),
            );
        }
      continue;
    }
    const retained = b.nodes.find(
        (n) =>
          n.id === `${s.id}:destination` ||
          (n.floorId === f.id && n.connectorId && n.spaceIds.includes(s.id)),
      ),
      position = retained?.position || centre(s.polygon),
      hub =
        retained ||
        newNode(
          `${s.id}:destination`,
          f.id,
          s.label,
          s.kind === "corridor" ? "junction" : "destination",
          position,
          [s.id],
        );
    if (!retained) b.nodes.push(hub);
    for (const d of doors) {
      if (d.id === hub.id) continue;
      const path = pathInside(f, s, position, d.position);
      if (path)
        b.edges.push(
          newEdge(`${hub.id}:${d.id}`, f, hub, d, path, {
            traversal: d.doorId ? "doorway" : "corridor",
          }),
        );
    }
  }
  // Remove straight, degree-two cell nodes; bends and doorway decisions remain explicit.
  for (const node of [...b.nodes].filter(
    (n) => n.floorId === floorId && n.id.includes(":cell:"),
  )) {
    const incident = b.edges.filter(
      (e) => e.floorId === floorId && (e.from === node.id || e.to === node.id),
    );
    if (incident.length !== 2 || b.photos.some((p) => p.nodeId === node.id))
      continue;
    const [one, two] = incident,
      a = b.nodes.find(
        (n) => n.id === (one.from === node.id ? one.to : one.from),
      ),
      z = b.nodes.find(
        (n) => n.id === (two.from === node.id ? two.to : two.from),
      );
    const path = simplifyPath(f, [a.position, node.position, z.position]);
    if (path.length !== 2) continue;
    b.edges = b.edges.filter((e) => !incident.includes(e));
    b.edges.push(newEdge(`${a.id}:via:${z.id}`, f, a, z, path));
    b.nodes = b.nodes.filter((n) => n.id !== node.id);
  }
  for (const p of b.photos) {
    const edge = b.edges.find((e) => e.id === p.edgeId),
      old = oldEdges.get(p.edgeId);
    if (
      p.edgeId &&
      (!edge || (old && JSON.stringify(old.path) !== JSON.stringify(edge.path)))
    ) {
      p.status = "stale";
      p.issue = "Path replaced during graph construction; reassign this image.";
    }
  }
  return revalidateGraph(b, floorId);
}
export function revalidateGraph(building, floorId) {
  const b = clone(building),
    f = b.floors.find((f) => f.id === floorId);
  if (f.geometryStatus !== "reviewed")
    throw new Error("Review edited geometry first.");
  for (const n of b.nodes.filter((n) => n.floorId === floorId))
    n.status = nodeProblem(b, n) ? "stale" : "reviewed";
  for (const e of b.edges.filter((e) => e.floorId === floorId)) {
    e.geometryRevision = f.revision;
    e.status = edgeIssue(b, e, { requireReviewed: false })
      ? "stale"
      : "reviewed";
    e.length = pathLength(e.path) / (f.geometry.scale?.pixelsPerMetre || 1);
    e.units = f.geometry.scale ? "m" : "px";
    e.photoIds = b.photos.filter((p) => p.edgeId === e.id).map((p) => p.id);
  }
  for (const e of b.edges.filter((e) => e.floorId === null))
    e.status =
      edgeIssue(b, e, { requireReviewed: false }) ||
      [e.from, e.to].some(
        (id) => b.nodes.find((n) => n.id === id)?.status !== "reviewed",
      )
        ? "stale"
        : "reviewed";
  f.graphRevision = f.revision;
  return b;
}
export function connectLandings(building, fromId, toId, type, label, evidence) {
  const b = clone(building),
    a = b.nodes.find((n) => n.id === fromId),
    z = b.nodes.find((n) => n.id === toId);
  if (!a || !z || a.floorId === z.floorId)
    throw new Error("Select landings on different floors.");
  if (!evidence.trim())
    throw new Error("Record evidence for this floor connection.");
  const existing = b.connectors.find(
    (c) => c.id === a.connectorId || c.id === z.connectorId,
  );
  if (a.connectorId && z.connectorId && a.connectorId !== z.connectorId)
    throw new Error("Landings belong to different connectors.");
  if (existing && existing.type !== type)
    throw new Error("Connector traversal type must match.");
  const id = existing?.id || `connector:${fromId}:${toId}`;
  if (
    b.edges.some(
      (e) =>
        e.connectorId === id &&
        ((e.from === a.id && e.to === z.id) ||
          (e.from === z.id && e.to === a.id)),
    )
  )
    throw new Error("These landings are already connected.");
  const landingIds = [
    ...new Set([...(existing?.landingIds || []), a.id, z.id]),
  ];
  if (
    new Set(landingIds.map((id) => b.nodes.find((n) => n.id === id).floorId))
      .size !== landingIds.length
  )
    throw new Error("A connector can have only one landing per floor.");
  a.type = z.type = type === "stairs" ? "stair" : "elevator";
  a.connectorId = z.connectorId = id;
  if (existing) {
    existing.landingIds = landingIds;
    existing.evidence += "\n" + evidence;
    existing.status = "reviewed";
  } else
    b.connectors.push({
      id,
      label,
      type,
      landingIds,
      status: "reviewed",
      evidence,
    });
  b.edges.push({
    id: id + ":edge:" + a.id + ":" + z.id,
    from: a.id,
    to: z.id,
    floorId: null,
    path: [a.position, z.position],
    direction: "both",
    traversal: type,
    connectorId: id,
    length: 1,
    units: "transition",
    accessible: "unknown",
    restricted: false,
    status: "reviewed",
    photoIds: [],
    geometryRevision: 0,
  });
  return b;
}
