import polygonClipping from "polygon-clipping";
import {
  clone,
  emptyMap,
  centre,
  inside,
  distance,
  pointSegment,
  midpoint,
  validateMap,
} from "../map.js";

export const roomLabels = (label) => [
  ...new Set(
    (/\b(stair|flight|landing)\b/i.test(String(label)) ? "" : String(label))
      .toUpperCase()
      .match(/\b\d{1,5}[A-Z]?\b/g) || [],
  ),
];
const area = (p) =>
  Math.abs(
    p.reduce((n, a, i) => {
      const z = p[(i + 1) % p.length];
      return n + a.x * z.y - z.x * a.y;
    }, 0) / 2,
  );
const ring = (p) => [...p.map((v) => [v.x, v.y]), [p[0].x, p[0].y]];
const poly = (p) => [ring(p)];
const points = (r) => r.slice(0, -1).map(([x, y]) => ({ x, y }));
const valid = (p) => p.length >= 3 && area(p) > 2;
const sameRegion = (a, b) => {
  try {
    const overlap = polygonClipping
      .intersection(poly(a), poly(b))
      .reduce((n, p) => n + area(points(p[0])), 0);
    return overlap / (area(a) + area(b) - overlap) > 0.65;
  } catch {
    return false;
  }
};
const difference = (p, others) => {
  try {
    return polygonClipping.difference(poly(p), ...others.map(poly));
  } catch {
    return [poly(p)];
  }
};
export function tileGeometry(map, crop, width, height) {
  const transform = (p) => ({
    x: crop.x + (p.x * crop.width) / width,
    y: crop.y + (p.y * crop.height) / height,
  });
  return {
    ...map,
    spaces: map.spaces.map((s) => ({
      ...s,
      polygon: s.polygon.map(transform),
    })),
    doors: map.doors.map((d) => ({
      ...d,
      a: transform(d.a),
      b: transform(d.b),
    })),
    walls: map.walls.map((w) => ({ ...w, points: w.points.map(transform) })),
    pois: map.pois.map((p) => ({ ...p, position: transform(p.position) })),
  };
}
// Join only boundaries supported by a detected opening. Near-equal coordinates
// from overlapping image passes are reconciled in the common source frame.
export function sharedBoundary(a, z, p, tolerance = 3) {
  const candidates = [];
  for (let i = 0; i < a.polygon.length; i++)
    for (let j = 0; j < z.polygon.length; j++) {
      const v = a.polygon[i],
        w = a.polygon[(i + 1) % a.polygon.length],
        q = z.polygon[j],
        r = z.polygon[(j + 1) % z.polygon.length];
      const horizontal =
        Math.abs(v.y - w.y) < 0.1 &&
        Math.abs(q.y - r.y) < 0.1 &&
        Math.abs(v.y - q.y) < tolerance;
      const vertical =
        Math.abs(v.x - w.x) < 0.1 &&
        Math.abs(q.x - r.x) < 0.1 &&
        Math.abs(v.x - q.x) < tolerance;
      if (!horizontal && !vertical) continue;
      const axis = horizontal ? "x" : "y",
        fixed = horizontal ? "y" : "x",
        lo = Math.max(Math.min(v[axis], w[axis]), Math.min(q[axis], r[axis])),
        hi = Math.min(Math.max(v[axis], w[axis]), Math.max(q[axis], r[axis]));
      if (hi - lo < 2) continue;
      const c = {
        [axis]: Math.max(lo, Math.min(hi, p[axis])),
        [fixed]: (v[fixed] + q[fixed]) / 2,
      };
      candidates.push({
        axis,
        fixed,
        lo,
        hi,
        line: c[fixed],
        distance: distance(c, p),
      });
    }
  return candidates.sort((a, b) => a.distance - b.distance)[0];
}
export function addReviewedOpening(
  g,
  roomId,
  position,
  width = 10,
  label = "Source-reviewed doorway",
) {
  const room = g.spaces.find((s) => s.id === roomId);
  if (!room) return false;
  const matches = g.spaces
    .filter((s) => s.id !== roomId && s.access !== "nonwalkable")
    .map((s) => ({
      space: s,
      boundary: sharedBoundary(room, s, position, 0.1),
    }))
    .filter((x) => x.boundary && x.boundary.distance < 12)
    .sort((a, b) => a.boundary.distance - b.boundary.distance);
  if (!matches.length) return false;
  const { space, boundary } = matches[0],
    half = Math.min(width / 2, (boundary.hi - boundary.lo) / 2 - 0.1),
    c = Math.max(
      boundary.lo + half,
      Math.min(boundary.hi - half, position[boundary.axis]),
    );
  if (half < 1) return false;
  g.doors.push({
    id: `reviewed-opening-${g.doors.length}`,
    label,
    a: { [boundary.axis]: c - half, [boundary.fixed]: boundary.line },
    b: { [boundary.axis]: c + half, [boundary.fixed]: boundary.line },
    spaceIds: [room.id, space.id],
    confidence: 1,
  });
  delete room.access;
  delete space.access;
  return true;
}
export function traceBoundaryWalls(geometry) {
  const walls = [];
  for (const s of geometry.spaces)
    for (let i = 0; i < s.polygon.length; i++) {
      const a = s.polygon[i],
        z = s.polygon[(i + 1) % s.polygon.length],
        dx = z.x - a.x,
        dy = z.y - a.y,
        len = Math.hypot(dx, dy);
      if (len < 0.01) continue;
      const project = (p) => ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
      const on = (p) => pointSegment(p, a, z) < 0.1;
      const gaps = geometry.doors
        .filter((d) => d.spaceIds.includes(s.id) && on(d.a) && on(d.b))
        .map((d) => [
          Math.min(project(d.a), project(d.b)),
          Math.max(project(d.a), project(d.b)),
        ])
        .sort((a, b) => a[0] - b[0]);
      let t = 0;
      for (const [l, r] of [...gaps, [len, len]]) {
        if (l - t > 0.1)
          walls.push({
            id: `${s.id}:w:${i}:${Math.round(t * 10)}`,
            points: [
              { x: a.x + (t * dx) / len, y: a.y + (t * dy) / len },
              { x: a.x + (l * dx) / len, y: a.y + (l * dy) / len },
            ],
          });
        t = Math.max(t, r);
      }
    }
  return walls;
}
export function canonicalizeDoorways(doors, originalIds = new Set()) {
  const analytical = d => d.id.includes("coverage-open-");
  const score = d => (originalIds.has(d.id) ? 10000 : 0) + (!analytical(d) ? 1000 : 0) + (d.confidence || 0);
  const out = [];
  for (const d of [...doors].sort((a,b) => score(b) - score(a))) {
    const duplicate = out.some(o => {
      if (o.spaceIds.length !== d.spaceIds.length || !o.spaceIds.every(id => d.spaceIds.includes(id))) return false;
      const length = distance(o.a,o.b); if (!length) return false;
      const dx = (o.b.x-o.a.x)/length, dy = (o.b.y-o.a.y)/length;
      const offset = p => Math.abs(dx*(p.y-o.a.y)-dy*(p.x-o.a.x));
      if (offset(d.a)>0.8 || offset(d.b)>0.8) return false;
      const t = p => (p.x-o.a.x)*dx+(p.y-o.a.y)*dy,
        lo = Math.max(0,Math.min(t(d.a),t(d.b))), hi = Math.min(length,Math.max(t(d.a),t(d.b)));
      return hi-lo > 1 && hi-lo > Math.min(length,distance(d.a,d.b))*0.25;
    });
    if (!duplicate) out.push(d);
  }
  return out;
}

export function consolidateCoverage(
  source,
  sections,
  { baseMap = null, inventory = [], footprints = [] } = {},
) {
  const g = baseMap ? clone(baseMap) : emptyMap(source),
    diagnostics = [],
    candidates = [],
    rawDoors = [];
  const outlineUnion = footprints.length
    ? polygonClipping.union(...footprints.map(poly))
    : null;
  const originals = new Map(g.spaces.map((s) => [s.id, s]));
  for (const [i, section] of sections.entries()) {
    const m = section.map,
      crop = section.crop || {
        x: 0,
        y: 0,
        width: source.width,
        height: source.height,
      };
    const projected = tileGeometry(m, crop, m.source.width, m.source.height);
    const reference = new Map(projected.spaces.map((s) => [s.id, s]));
    for (const s of projected.spaces) {
      if (outlineUnion) {
        const pieces = polygonClipping.intersection(
            poly(s.polygon),
            outlineUnion,
          ),
          best = pieces
            .map((p) => points(p[0]))
            .filter(valid)
            .sort((a, b) => area(b) - area(a))[0];
        if (!best) continue;
        s.polygon = best;
      }
      const margin = Math.min(
        ...s.polygon.flatMap((p) => [
          crop.x > 0 ? p.x - crop.x : Infinity,
          crop.y > 0 ? p.y - crop.y : Infinity,
          crop.x + crop.width < source.width ? crop.x + crop.width - p.x : Infinity,
          crop.y + crop.height < source.height ? crop.y + crop.height - p.y : Infinity,
        ]),
      );
      candidates.push({
        ...s,
        section: i,
        score:
          (margin > 2 ? 100 : 0) +
          (s.confidence || 0) * 10 +
          (section.refinement && margin > 2 ? 25 : 0) +
          (section.overview ? -30 : 0),
        originalId: s.id,
      });
    }
    for (const d of projected.doors)
      rawDoors.push({
        ...d,
        section: i,
        rooms: d.spaceIds.map((id) => reference.get(id)).filter(Boolean),
      });
  }
  const rooms = g.spaces.filter((s) => s.kind !== "corridor"),
    known = new Map();
  const baseLabels = new Map(
    rooms.flatMap((s) => roomLabels(s.label).map((l) => [l, s.id])),
  );
  // Repeated measurements within three source pixels refer to the same wall
  // centreline. Existing reviewed coordinates anchor the reconciliation.
  const unsnapped = new Map(candidates.map((s) => [s, clone(s.polygon)]));
  for (const axis of ["x", "y"]) {
    const anchors = [
      ...new Set(g.spaces.flatMap((s) => s.polygon.map((p) => p[axis]))),
    ];
    const values = [
        ...new Set(candidates.flatMap((s) => s.polygon.map((p) => p[axis]))),
      ].sort((a, b) => a - b),
      groups = [];
    for (const value of values) {
      const group = groups.at(-1);
      if (group && value - group[0] < 2.5) group.push(value);
      else groups.push([value]);
    }
    const snapped = new Map();
    for (const group of groups) {
      const mid = group[Math.floor(group.length / 2)],
        anchor = anchors
          .filter((a) => Math.abs(a - mid) < 3)
          .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0],
        target = anchor ?? Math.round(mid * 2) / 2;
      for (const value of group) snapped.set(value, target);
    }
    for (const s of candidates)
      for (const p of s.polygon) p[axis] = snapped.get(p[axis]);
  }
  for (const s of candidates)
    if (area(s.polygon) < area(unsnapped.get(s)) * 0.25)
      s.polygon = unsnapped.get(s);
  for (const s of candidates)
    s.polygon = s.polygon.filter(
      (p, i) => distance(p, s.polygon[(i + 1) % s.polygon.length]) > 0.1,
    );
  for (const s of rooms.filter((s) => s.kind !== "lobby")) {
    const labels = roomLabels(s.label);
    const choices = candidates
      .filter(
        (c) =>
          c.score >= 100 &&
          roomLabels(c.label).some((l) => labels.includes(l)) &&
          !roomLabels(c.label).some(
            (l) => baseLabels.has(l) && baseLabels.get(l) !== s.id,
          ),
      )
      .sort((a, b) => b.score - a.score);
    if (
      choices.length &&
      labels.every((l) => roomLabels(choices[0].label).includes(l))
    ) {
      s.polygon = clone(choices[0].polygon);
      s.label = choices[0].label;
    }
  }
  const placed = [];
  for (const s of [...rooms].sort(
    (a, b) =>
      (a.kind === "lobby" ? -1 : 0) - (b.kind === "lobby" ? -1 : 0) ||
      area(a.polygon) - area(b.polygon),
  )) {
    const cuts = difference(
      s.polygon,
      placed.map((s) => s.polygon),
    )
      .map((q) => points(q[0]))
      .filter(valid)
      .sort((a, b) => area(b) - area(a));
    if (cuts.length) s.polygon = cuts[0];
    placed.push(s);
  }
  for (const s of rooms)
    for (const label of roomLabels(s.label)) known.set(label, s);
  const idMap = new Map(),
    seenCandidates = [];
  for (const s of candidates
    .filter((s) => s.kind !== "corridor")
    .sort((a, b) => b.score - a.score || area(a.polygon) - area(b.polygon))) {
    if (/^(unlabelled|unlabeled|unknown|space)\b/i.test(s.label) && s.score < 100) continue;
    const labels = s.access === "nonwalkable" ? [] : roomLabels(s.label),
      existing =
        labels.map((l) => known.get(l)).find(Boolean) ||
        rooms.find(
          (r) =>
            r.label.toLowerCase() === s.label.toLowerCase() &&
            sameRegion(r.polygon, s.polygon),
        );
    if (existing) {
      idMap.set(`${s.section}:${s.originalId}`, existing.id);
      continue;
    }
    if (!valid(s.polygon)) continue;
    const cut = difference(
      s.polygon,
      rooms.map((r) => r.polygon),
    )
      .filter((p) => valid(points(p[0])))
      .sort((a, b) => area(points(b[0])) - area(points(a[0])));
    const pieces = cut.map((p) => points(p[0]));
    // A hole means this candidate completely encloses an existing region, and
    // polygons cannot carry holes. The same space observed twice (e.g. stair
    // treads inside the stair enclosure: same kind, no room number the
    // container lacks) takes the enclosing outline under the existing ID and
    // label. Anything else, such as a numbered room inside a larger one, is not
    // merged: the candidate is retained for coverage review instead of being
    // added as an overlapping region that blocks the whole floor.
    if (cut[0]?.length > 1) {
      const holes = cut[0].slice(1).map((h) => centre(points(h))),
        enclosed = rooms.filter((r) => holes.some((h) => inside(h, r.polygon)));
      const duplicate = enclosed.length === 1 && enclosed[0].kind === s.kind &&
        roomLabels(enclosed[0].label).every((l) => roomLabels(s.label).includes(l)) &&
        !roomLabels(s.label).some((l) => known.has(l) && known.get(l) !== enclosed[0]);
      if (duplicate) {
        enclosed[0].polygon = clone(s.polygon);
        idMap.set(`${s.section}:${s.originalId}`, enclosed[0].id);
        for (const l of labels) known.set(l, enclosed[0]);
        diagnostics.push({ code: "nested-duplicate", label: s.label,
          message: `Enclosing observation of ${enclosed[0].label} merged into its outline; review that both describe one space.` });
      } else
        diagnostics.push({ code: "overlap", label: s.label,
          message: "Candidate encloses an existing region; retained for coverage review." });
      continue;
    }
    if (!pieces.length || area(pieces[0]) < area(s.polygon) * 0.25) {
      diagnostics.push({
        code: "overlap",
        label: s.label,
        message:
          "Candidate conflicts with an existing room; retained for coverage review.",
      });
      continue;
    }
    const id = `coverage-${labels[0] || "space"}-${rooms.length}`,
      room = {
        id,
        label: s.label,
        kind: s.kind,
        polygon: pieces[0],
        confidence: s.confidence,
        ...(s.access ? { access: s.access } : {}),
      };
    rooms.push(room);
    for (const l of labels) known.set(l, room);
    idMap.set(`${s.section}:${s.originalId}`, id);
    seenCandidates.push(s);
  }
  // The union preserves overlap relationships between crop corridors. Subtract
  // room footprints so a large corridor proposal cannot paint over offices.
  const rawCorridors = [
    ...g.spaces.filter((s) => s.kind === "corridor"),
    ...candidates.filter((s) => s.kind === "corridor"),
  ];
  let corridorPolys = [];
  try {
    corridorPolys = rawCorridors.length
      ? polygonClipping.union(...rawCorridors.map((s) => poly(s.polygon)))
      : [];
  } catch {
    corridorPolys = rawCorridors.map((s) => poly(s.polygon));
  }
  const corridors = [];
  for (const p of corridorPolys) {
    let cuts;
    try {
      cuts = polygonClipping.difference(
        p,
        ...rooms.map((r) => poly(r.polygon)),
      );
    } catch {
      cuts = [p];
    }
    for (const q of cuts) {
      let components = [q];
      if (q.length > 1) {
        const xs = [...new Set(q.flatMap((r) => r.map((p) => p[0])))].sort(
            (a, b) => a - b,
          ),
          ys = q.flatMap((r) => r.map((p) => p[1])),
          lo = Math.min(...ys) - 1,
          hi = Math.max(...ys) + 1;
        components = [];
        for (let i = 1; i < xs.length; i++)
          if (xs[i] - xs[i - 1] > 0.1)
            components.push(
              ...polygonClipping.intersection(q, [
                [
                  [xs[i - 1], lo],
                  [xs[i], lo],
                  [xs[i], hi],
                  [xs[i - 1], hi],
                  [xs[i - 1], lo],
                ],
              ]),
            );
      }
      for (const component of components) {
        const polygon = points(component[0]);
        if (valid(polygon))
          corridors.push({
            id: `coverage-corridor-${corridors.length}`,
            label: `Connected corridor ${corridors.length + 1}`,
            kind: "corridor",
            polygon,
            confidence: 0.8,
          });
      }
    }
  }
  g.spaces = [...rooms, ...corridors];
  g.doors = [];
  g.pois = [];
  g.graph = { nodes: [], edges: [] };
  // These are analytical joins inside one continuous circulation area, not
  // invented physical doorways. They keep decomposed corridor pieces connected.
  for (let i = 0; i < corridors.length; i++)
    for (let j = i + 1; j < corridors.length; j++) {
      const shared = sharedBoundary(
        corridors[i],
        corridors[j],
        centre(corridors[i].polygon),
        0.01,
      );
      if (shared && shared.hi - shared.lo >= 2)
        g.doors.push({
          id: `coverage-open-${i}-${j}`,
          label: "Open circulation join",
          a: { [shared.axis]: shared.lo, [shared.fixed]: shared.line },
          b: { [shared.axis]: shared.hi, [shared.fixed]: shared.line },
          spaceIds: [corridors[i].id, corridors[j].id],
          confidence: 1,
        });
    }
  // A separate inventory can identify the label of an otherwise unlabelled
  // enclosed region. Keep the relationship in the report for source review.
  for (const item of inventory.filter((i) => i.kind !== "corridor"))
    if (!known.has(item.label)) {
      const target = rooms.find(
        (s) =>
          /unlabel|未标注/i.test(s.label) && inside(item.position, s.polygon),
      );
      if (target) {
        target.label = item.label;
        known.set(item.label, target);
      }
    }
  const doorCandidates = [
    ...(baseMap?.doors?.map((d) => ({
      ...d,
      rooms: d.spaceIds.map((id) => originals.get(id)).filter(Boolean),
      original: true,
    })) || []),
    ...rawDoors,
  ];
  for (const d of doorCandidates) {
    const p = midpoint(d.a, d.b),
      ids = [];
    for (const r of d.rooms) {
      const labels = roomLabels(r.label),
        s =
          rooms.find((s) => s.id === idMap.get(`${d.section}:${r.id}`)) ||
          labels.map((l) => known.get(l)).find(Boolean) ||
          rooms.find((s) => s.id === r.id) ||
          g.spaces
            .filter((s) => s.kind === "corridor")
            .find((s) => inside(p, s.polygon));
      if (s && !ids.includes(s.id)) ids.push(s.id);
    }
    // Resolve corridors by boundary proximity when subtraction puts the point
    // precisely on a different corridor component.
    const near = g.spaces.filter((s) =>
      s.polygon.some(
        (v, i) => pointSegment(p, v, s.polygon[(i + 1) % s.polygon.length]) < 8,
      ),
    );
    // A crop-edge opening can have one reference even though its neighbour
    // has now been mapped by another detail. Resolve it before treating it as
    // exterior; this also makes duplicate observations use the same IDs.
    if (ids.length === 1) {
      const own = g.spaces.find(s => s.id === ids[0]);
      const adjacent = near.filter(s => s.id !== own.id).map(s => ({ s, shared: sharedBoundary(own,s,p,0.1) }))
        .filter(x => x.shared && x.shared.distance < 3).sort((a,b) => a.shared.distance-b.shared.distance);
      if (adjacent.length === 1) ids.push(adjacent[0].s.id);
    }
    if (ids.length < 2 && d.rooms.length > 1)
      for (const s of near) if (!ids.includes(s.id)) ids.push(s.id);
    if (ids.length >= 2) {
      const a = g.spaces.find((s) => s.id === ids[0]),
        z = g.spaces.find((s) => s.id === ids[1]),
        boundary = sharedBoundary(a, z, p, 0.1);
      if (!boundary || boundary.distance > 18) {
        diagnostics.push({
          code: "door-boundary",
          label: d.label,
          position: p,
          message: "Detected door does not yet meet both space boundaries.",
        });
        continue;
      }
      const half = Math.min(
          distance(d.a, d.b) / 2,
          (boundary.hi - boundary.lo) / 2 - 0.1,
          12,
        ),
        c = Math.max(
          boundary.lo + half,
          Math.min(boundary.hi - half, p[boundary.axis]),
        );
      const a1 = { [boundary.axis]: c - half, [boundary.fixed]: boundary.line },
        b1 = { [boundary.axis]: c + half, [boundary.fixed]: boundary.line };
      if (half < 1) continue;
      if (
        !g.doors.some(
          (o) =>
            !o.id.includes("coverage-open-") &&
            distance(midpoint(o.a, o.b), midpoint(a1, b1)) < 3 &&
            ids.slice(0, 2).every((id) => o.spaceIds.includes(id)),
        )
      )
        g.doors.push({
          id: d.original ? d.id : `coverage-door-${g.doors.length}`,
          label: d.label,
          a: a1,
          b: b1,
          spaceIds: ids.slice(0, 2),
          confidence: d.confidence,
        });
    } else if (ids.length === 1 && d.rooms.length === 1) {
      const s = g.spaces.find((s) => s.id === ids[0]),
        i = s.polygon.findIndex(
          (v, i) =>
            pointSegment(d.a, v, s.polygon[(i + 1) % s.polygon.length]) < 1 &&
            pointSegment(d.b, v, s.polygon[(i + 1) % s.polygon.length]) < 1,
        );
      if (i >= 0) {
        const a = s.polygon[i],
          z = s.polygon[(i + 1) % s.polygon.length],
          dx = z.x - a.x,
          dy = z.y - a.y,
          den = dx * dx + dy * dy,
          project = (p) => {
            const t = Math.max(
              0,
              Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / den),
            );
            return { x: a.x + t * dx, y: a.y + t * dy };
          };
        g.doors.push({
          id: d.original ? d.id : `coverage-door-${g.doors.length}`,
          label: d.label,
          a: project(d.a),
          b: project(d.b),
          spaceIds: ids,
          confidence: d.confidence,
        });
      }
    }
  }
  g.doors = canonicalizeDoorways(g.doors, new Set(baseMap?.doors?.map(d => d.id) || []));
  for (const s of g.spaces)
    if (
      s.access !== "nonwalkable" &&
      !g.doors.some((d) => d.spaceIds.includes(s.id))
    )
      s.access = "unknown";
  g.walls = traceBoundaryWalls(g);
  g.review = {
    status: "draft",
    reviewer: "",
    reviewedAt: null,
    issues: [
      {
        id: "coverage-review",
        message:
          "Compare the inventory, merged boundaries, doors, and uncovered regions with the source before review.",
        resolved: false,
        resolution: "",
      },
    ],
  };
  g.extraction = {
    ...sections.at(-1)?.map.extraction,
    notes:
      "Overlapping detail passes, label reconciliation, geometry validation, and explicit coverage accounting.",
  };
  const expected = [
    ...inventory,
    ...g.spaces
      .filter((s) => s.kind !== "corridor")
      .flatMap((s) =>
        roomLabels(s.label).map((label) => ({
          label,
          position: centre(s.polygon),
        })),
      ),
  ];
  const items = [
    ...new Map(
      expected.map((i) => [
        i.label,
        {
          ...i,
          spaceId:
            known.get(i.label)?.id ||
            (/^\s*\d/.test(i.label) ? roomLabels(i.label).map(l => known.get(l)).find(Boolean)?.id : null) ||
            (/^\s*\d/.test(i.label) ? g.spaces.find(s =>
              s.label.match(/^\s*(\d{1,5}[A-Z]?)\b/)?.[1] === i.label.match(/^\s*(\d{1,5}[A-Z]?)\b/)?.[1] &&
              inside(i.position, s.polygon))?.id : null) ||
            g.spaces.find((s) => s.label.trim().toLowerCase() === i.label.trim().toLowerCase())?.id ||
            (i.kind === "corridor"
              ? corridors.find((s) => inside(i.position, s.polygon))?.id
              : /^Unlabelled|^Unlabeled/i.test(i.label)
                ? g.spaces.find((s) => inside(i.position, s.polygon))?.id
                : null) ||
            null,
        },
      ]),
    ).values(),
  ];
  const issues = validateMap(g).filter(
    (i) => !["review", "scale", "disconnected"].includes(i.code),
  );
  return {
    map: g,
    coverage: {
      version: 1,
      createdAt: new Date().toISOString(),
      stage: "needs-review",
      tiles: sections.length,
      items,
      diagnostics,
      geometryIssues: issues.map((i) => ({
        code: i.code,
        message: i.message,
        target: i.target?.id,
        severity: i.severity,
      })),
    },
  };
}
