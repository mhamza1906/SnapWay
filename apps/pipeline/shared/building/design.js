import { z } from "zod";
import { centre, inside, pointSegment } from "../map.js";

export const PALETTES = {
  forest: {
    name: "Forest",
    background: "#f7f8f4",
    room: "#d6e7de",
    corridor: "#ffffff",
    lobby: "#c1dfd4",
    restroom: "#c5dce8",
    storage: "#e4dcc9",
    wall: "#35554a",
    text: "#203e34",
    accent: "#237963",
  },
  sandstone: {
    name: "Sandstone",
    background: "#fbf7ef",
    room: "#f0dec2",
    corridor: "#fffdf8",
    lobby: "#e4c7a1",
    restroom: "#c7dfdf",
    storage: "#ded4e6",
    wall: "#635348",
    text: "#493c34",
    accent: "#ae6742",
  },
  blueprint: {
    name: "Blueprint",
    background: "#112d47",
    room: "#244966",
    corridor: "#173950",
    lobby: "#315c79",
    restroom: "#316978",
    storage: "#465b7d",
    wall: "#9fc8dc",
    text: "#f1f8fd",
    accent: "#7ee0d5",
  },
  lilac: {
    name: "Lilac",
    background: "#f8f6fc",
    room: "#e1dbf1",
    corridor: "#ffffff",
    lobby: "#cfc4e6",
    restroom: "#c8e3e2",
    storage: "#eddbc5",
    wall: "#655778",
    text: "#3f3551",
    accent: "#8561ad",
  },
  monochrome: {
    name: "Ink",
    background: "#f8f8f6",
    room: "#e7e8e4",
    corridor: "#ffffff",
    lobby: "#d3d6d0",
    restroom: "#e0e2e7",
    storage: "#dedbd5",
    wall: "#40483f",
    text: "#262c26",
    accent: "#283f37",
  },
};
const Color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color");
export const PaletteSchema = z
  .object(
    Object.fromEntries(
      Object.keys(PALETTES.forest)
        .filter((k) => k !== "name")
        .map((k) => [k, Color]),
    ),
  )
  .strict();
export const PresentationSchema = z
  .object({
    preset: z.enum(Object.keys(PALETTES)).default("forest"),
    colors: PaletteSchema.default(
      Object.fromEntries(
        Object.entries(PALETTES.forest).filter(([k]) => k !== "name"),
      ),
    ),
    lastAI: z
      .object({
        provider: z.string(),
        model: z.string(),
        at: z.string(),
        prompt: z.string(),
        tools: z.array(z.string()),
      })
      .nullable()
      .default(null),
    title: z.string().max(80).default(""),
    padding: z.number().min(1).max(20).default(5),
    wallWidth: z.number().min(0.3).max(3).default(1),
    showTitle: z.boolean().default(true),
    showLegend: z.boolean().default(true),
    showDoors: z.boolean().default(true),
    labels: z
      .object({
        visible: z.boolean().default(true),
        scale: z.number().min(0.6).max(2).default(1),
        font: z.enum(["sans", "serif", "mono"]).default("sans"),
        bold: z.boolean().default(false),
        corridors: z.boolean().default(false),
      })
      .default({}),
    rooms: z
      .record(
        z
          .object({
            fill: Color.nullable().default(null),
            label: z.string().max(60).nullable().default(null),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
export const presentation = (value) => PresentationSchema.parse(value || {});
// Agent-only access evidence must never read as a human plan review.
const reviewLabel = (floor) =>
  floor.geometryStatus !== "reviewed" ? "DRAFT"
    : (floor.access?.records || []).some((r) => r.review?.status && r.review.status !== "human-reviewed")
      ? "AGENT-INSPECTED · NOT HUMAN REVIEWED" : "PLAN REVIEWED";

export function presetPresentation(name, current = {}) {
  const { name: _, ...colors } = PALETTES[name] || PALETTES.forest;
  return presentation({ ...presentation(current), preset: name, colors });
}
export function buildingBounds(floor, style = presentation()) {
  const ps = floor.geometry.spaces.flatMap((s) => s.polygon);
  if (!ps.length) return { x: 0, y: 0, w: floor.width, h: floor.height };
  const xs = ps.map((p) => p.x),
    ys = ps.map((p) => p.y),
    left = Math.min(...xs),
    top = Math.min(...ys),
    w = Math.max(...xs) - left,
    h = Math.max(...ys) - top;
  const unit = Math.max(w, h) / 50,
    pad = Math.max(2, (Math.max(w, h) * style.padding) / 100);
  return {
    x: left - pad,
    y: top - pad - (style.showTitle ? unit * 3 : 0),
    w: w + pad * 2,
    h:
      h +
      pad * 2 +
      (style.showTitle ? unit * 3 : 0) +
      (style.showLegend ? unit * 3 : 0),
  };
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
const pts = (p) => p.map((v) => `${v.x},${v.y}`).join(" ");
// Walls the map author made from doorways are drawn black.
export const MADE_WALL = "#000000";
export function labelPoint(polygon) {
  const c = centre(polygon);
  const clearanceAt = (p) =>
    Math.min(
      ...polygon.map((a, i) =>
        pointSegment(p, a, polygon[(i + 1) % polygon.length]),
      ),
    );
  const width =
      Math.max(...polygon.map((p) => p.x)) -
      Math.min(...polygon.map((p) => p.x)),
    height =
      Math.max(...polygon.map((p) => p.y)) -
      Math.min(...polygon.map((p) => p.y));
  if (inside(c, polygon) && clearanceAt(c) > Math.min(width, height) * 0.2)
    return c;
  const xs = polygon.map((p) => p.x),
    ys = polygon.map((p) => p.y),
    l = Math.min(...xs),
    t = Math.min(...ys),
    w = Math.max(...xs) - l,
    h = Math.max(...ys) - t;
  let best = null,
    clearance = -1;
  for (let yi = 1; yi < 12; yi++)
    for (let xi = 1; xi < 12; xi++) {
      const p = { x: l + (w * xi) / 12, y: t + (h * yi) / 12 };
      if (!inside(p, polygon)) continue;
      const d = Math.min(
        ...polygon.map((a, i) =>
          pointSegment(p, a, polygon[(i + 1) % polygon.length]),
        ),
      );
      if (d > clearance) {
        best = p;
        clearance = d;
      }
    }
  return best || polygon[0];
}
// A merge that surrounds another region opens it with a thin seam, kept as its
// own region `<keptId>:seam-<n>` joined to the kept one by doorways along both
// long sides. Seams are drawn and clicked as part of the kept region.
export const seamParent = (id) => /^(.+):seam-\d+$/.exec(id)?.[1] ?? null;
const fontFamily = (font) =>
  ({
    sans: "Arial, Helvetica, sans-serif",
    serif: "Georgia, serif",
    mono: "Courier New, monospace",
  })[font];
export function designContent(
  floor,
  styleValue,
  { selection = null, showWalls = true } = {},
) {
  const s = presentation(styleValue),
    c = s.colors,
    box = buildingBounds(floor, s),
    ps = floor.geometry.spaces.flatMap((s) => s.polygon);
  if (!ps.length) return "";
  const minX = Math.min(...ps.map((p) => p.x)),
    minY = Math.min(...ps.map((p) => p.y)),
    maxX = Math.max(...ps.map((p) => p.x)),
    maxY = Math.max(...ps.map((p) => p.y)),
    unit = Math.max(maxX - minX, maxY - minY) / 50;
  const pattern = "nonwalkable-" + floor.id.replace(/[^a-zA-Z0-9_-]/g, "_"),
    // Developer-marked stairs get tread lines over the lobby colour.
    treads = "stair-" + floor.id.replace(/[^a-zA-Z0-9_-]/g, "_"),
    stairs = floor.geometry.spaces.some((r) => r.use === "stair" && r.access !== "nonwalkable");
  let out = `<defs><pattern id="${pattern}" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="${c.storage}"/><path d="M-1 1L1 -1M0 6L6 0M5 7L7 5" stroke="${c.wall}" stroke-opacity=".2" stroke-width=".7"/></pattern>${stairs ? `<pattern id="${treads}" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="${c.lobby}"/><path d="M0 2H4" stroke="${c.wall}" stroke-opacity=".35" stroke-width=".5"/></pattern>` : ""}</defs><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${c.background}"/>`;
  if (s.showTitle)
    out += `<text x="${minX}" y="${minY - unit * 1.4}" font-family="${fontFamily(s.labels.font)}" fill="${c.text}" font-size="${unit * 1.15}" font-weight="700">${esc(s.title || floor.label)}</text><text x="${maxX}" y="${minY - unit * 1.4}" text-anchor="end" font-family="Arial, sans-serif" fill="${c.text}" opacity=".65" font-size="${unit * 0.45}">INDOOR MAP · ${reviewLabel(floor)}</text>`;
  const fillOf = (r) =>
      r.access === "nonwalkable"
        ? `url(#${pattern})`
        : r.access === "unknown"
          ? "#f2d8a7"
          : s.rooms[r.id]?.fill || (r.use === "stair" ? `url(#${treads})` : c[r.kind] || c.room),
    byId = new Map(floor.geometry.spaces.map((r) => [r.id, r])),
    seams = floor.geometry.spaces.filter((r) => byId.has(seamParent(r.id)));
  // Seam fills go underneath, so neighbouring walls stay on top of them.
  for (const r of seams)
    out += `<g data-room-id="${esc(seamParent(r.id))}" class="designed-room designed-seam"><title>${esc(byId.get(seamParent(r.id)).label)}</title><polygon points="${pts(r.polygon)}" fill="${fillOf(byId.get(seamParent(r.id)))}" stroke="none"/></g>`;
  for (const r of floor.geometry.spaces) {
    if (seams.includes(r)) continue;
    const fill = fillOf(r);
    out += `<g data-room-id="${esc(r.id)}" class="designed-room"><title>${esc(r.label)}${r.use === "stair" ? " · Stair" : ""}${r.access === "unknown" ? " · Doorway review needed" : r.use === "closed" ? " · Closed" : r.access === "nonwalkable" ? " · Non-walkable" : ""}</title><polygon points="${pts(r.polygon)}" fill="${fill}" stroke="${selection === r.id ? c.accent : showWalls ? c.wall : "none"}" stroke-width="${selection === r.id ? s.wallWidth * 2 : s.wallWidth}" stroke-linejoin="round"${r.access === "unknown" ? ' stroke-dasharray="2 1.5"' : ""}/></g>`;
  }
  // The kept region's outline along each seam's long sides is painted over in
  // its fill, so the seam reads as part of it; its short ends sit on walls
  // (the outer edge and the surrounded region's), which are drawn back on top.
  for (const r of seams) {
    const parent = byId.get(seamParent(r.id)),
      fill = fillOf(parent),
      edges = r.polygon.map((a, i) => [a, r.polygon[(i + 1) % r.polygon.length]]),
      // Ends reach past the painted sides (by `grow`) so no fill shows through.
      path = (long, grow = 0) =>
        edges
          .filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) > 4 === long)
          .map(([a, b]) => {
            const l = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = ((b.x - a.x) / l) * grow, uy = ((b.y - a.y) / l) * grow;
            return `M${a.x - ux},${a.y - uy}L${b.x + ux},${b.y + uy}`;
          })
          .join(""),
      sides = path(true),
      ends = path(false, s.wallWidth);
    if (sides)
      out += `<g data-room-id="${esc(parent.id)}" class="designed-room designed-seam"><title>${esc(parent.label)}</title><path d="${sides}" fill="none" stroke="${fill}" stroke-width="${s.wallWidth * 2}"/>${showWalls && ends ? `<path d="${ends}" fill="none" stroke="${c.wall}" stroke-width="${s.wallWidth}" stroke-linecap="square"/>` : ""}</g>`;
  }
  const seamJoin = (d) => d.spaceIds.length === 2 && d.spaceIds.some((id) => seams.some((r) => r.id === id) && d.spaceIds.includes(seamParent(id)));
  if (s.showDoors && showWalls)
    for (const d of floor.geometry.doors) {
      if (seamJoin(d)) continue;
      const target = d.spaceIds
          .map((id) => floor.geometry.spaces.find((r) => r.id === id))
          .find((r) => r?.kind === "corridor" || r?.kind === "lobby"),
        fill = target ? c[target.kind] || c.corridor : c.corridor;
      // A wide transparent line makes the doorway easy to click in the editor.
      out += `<g data-door-id="${esc(d.id)}" class="designed-door"><title>${esc(d.label || "Doorway")}</title><path d="M${d.a.x},${d.a.y}L${d.b.x},${d.b.y}" fill="none" stroke="${fill}" stroke-width="${s.wallWidth * 2.2}"/><path d="M${d.a.x},${d.a.y}L${d.b.x},${d.b.y}" fill="none" stroke="${c.accent}" stroke-width="${s.wallWidth * 0.45}" opacity=".7"/><path d="M${d.a.x},${d.a.y}L${d.b.x},${d.b.y}" fill="none" stroke="transparent" stroke-width="${Math.max(10, s.wallWidth * 10)}" pointer-events="stroke"/></g>`;
    }
  // Doorways the map author made into walls: drawn as solid black walls.
  if (showWalls)
    for (const w of floor.geometry.walls.filter((w) => w.id.endsWith(":wall")))
      out += `<polyline data-wall-id="${esc(w.id)}" class="made-wall" points="${pts(w.points)}" fill="none" stroke="${MADE_WALL}" stroke-width="${s.wallWidth * 2.4}" stroke-linecap="round"><title>Wall (was a doorway)</title></polyline>`;
  if (s.labels.visible)
    for (const r of floor.geometry.spaces) {
      if (
        (!s.labels.corridors && r.kind === "corridor") ||
        (r.access === "nonwalkable" && r.use !== "closed") ||
        seamParent(r.id)
      )
        continue;
      const xs = r.polygon.map((p) => p.x),
        ys = r.polygon.map((p) => p.y),
        w = Math.max(...xs) - Math.min(...xs),
        h = Math.max(...ys) - Math.min(...ys);
      let label = s.rooms[r.id]?.label ?? r.label;
      if (/unlabelled|unlabeled/i.test(label))
        label =
          r.kind === "storage"
            ? "Storage"
            : r.kind === "lobby"
              ? "Landing"
              : "Unlabelled";
      if (/stair .* landing|stair enclosure/i.test(label)) label = "Stair";
      if (r.use === "stair" && s.rooms[r.id]?.label == null && !/stair/i.test(label))
        label = /^(landing|unlabelled)$/i.test(label) ? "Stair" : `${label} (stair)`;
      if (r.use === "closed" && s.rooms[r.id]?.label == null) label = `${label} (closed)`;
      if (w < 4 || h < 4) continue;
      const p = labelPoint(r.polygon),
        font = Math.min(
          8 * s.labels.scale,
          (w * 0.82) / (Math.max(4, label.length) * 0.6),
          h * 0.27,
        );
      if (font < 1.8) continue;
      out += `<text data-label-for="${esc(r.id)}" x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="middle" font-family="${fontFamily(s.labels.font)}" font-size="${font}" font-weight="${s.labels.bold ? 700 : 500}" fill="${r.access === "unknown" ? "#604624" : c.text}" pointer-events="none">${esc(label)}</text>`;
    }
  if (s.showLegend) {
    const entries = [
      ["Rooms", c.room],
      ["Circulation", c.corridor],
      ["Doorway review", "#f2d8a7"],
      ["Non-walkable", c.storage],
    ];
    const gap = (maxX - minX) / entries.length,
      y = maxY + unit * 1.5;
    out += entries
      .map(
        ([label, color], i) =>
          `<g transform="translate(${minX + i * gap},${y})"><rect y="${-unit * 0.45}" width="${unit * 0.6}" height="${unit * 0.6}" rx="${unit * 0.12}" fill="${color}" stroke="${c.wall}" stroke-width="${unit * 0.035}"/><text x="${unit * 0.85}" font-family="Arial, sans-serif" font-size="${Math.min(unit * 0.45, gap / 18)}" fill="${c.text}">${label}</text></g>`,
      )
      .join("");
  }
  return out;
}
export function designedSVG(building, floorId, styleValue) {
  const f = building.floors.find((f) => f.id === floorId);
  if (!f) throw Error("Choose an existing floor.");
  const s = presentation(styleValue || f.presentation),
    box = buildingBounds(f, s);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(box.w)}" height="${Math.round(box.h)}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}"><title>${esc(building.name)} — ${esc(s.title || f.label)}</title><metadata>${esc(JSON.stringify({ floorId, revision: f.revision, presentation: s, geometry: "Original mapped coordinates; appearance only" }))}</metadata>${designContent(f, s)}</svg>`;
}

// The model can call only these presentation tools. No tool can modify a
// polygon, doorway, source image, graph, floor connection or access status.
export const DESIGN_TOOLS = {
  set_map_palette: {
    description:
      "Set the map background, room-type fills, walls, labels and accent colors.",
    schema: PaletteSchema,
  },
  set_map_layout: {
    description:
      "Frame the complete building and configure title, legend, doorway detail and wall weight. Padding is a percent of building extent; all geometry stays visible.",
    schema: z
      .object({
        title: z.string().max(80),
        padding: z.number().min(1).max(20),
        wallWidth: z.number().min(0.3).max(3),
        showTitle: z.boolean(),
        showLegend: z.boolean(),
        showDoors: z.boolean(),
      })
      .strict(),
  },
  set_map_labels: {
    description:
      "Adjust room-label visibility, scale and font without changing actual room identifiers.",
    schema: z
      .object({
        visible: z.boolean(),
        scale: z.number().min(0.6).max(2),
        font: z.enum(["sans", "serif", "mono"]),
        bold: z.boolean(),
        corridors: z.boolean(),
      })
      .strict(),
  },
  style_map_rooms: {
    description:
      "Style existing room IDs. A display label changes presentation only, not room identity or routing. Null resets an override.",
    schema: z
      .object({
        roomIds: z.array(z.string()).min(1).max(60),
        fill: Color.nullable(),
        label: z.string().max(60).nullable(),
      })
      .strict(),
  },
};
export function applyDesignTools(floor, calls) {
  if (!Array.isArray(calls) || !calls.length || calls.length > 12)
    throw Error("Expected 1–12 map design tool calls.");
  let result = presentation(floor.presentation);
  for (const call of calls) {
    const tool = DESIGN_TOOLS[call.name];
    if (!tool) throw Error("Unsupported design tool: " + call.name);
    const args = tool.schema.parse(call.arguments);
    if (call.name === "set_map_palette") result.colors = args;
    else if (call.name === "set_map_layout") Object.assign(result, args);
    else if (call.name === "set_map_labels") result.labels = args;
    else
      for (const id of args.roomIds) {
        if (!floor.geometry.spaces.some((s) => s.id === id))
          throw Error("Design refers to an unknown room.");
        result.rooms[id] = { fill: args.fill, label: args.label };
      }
  }
  return presentation(result);
}

// Styling does not invalidate the expensive geometry and routing checks.
export function navigationSignature(building) {
  return JSON.stringify({
    floors: building.floors.map(
      ({ presentation, history, snapshots, ...floor }) => floor,
    ),
    nodes: building.nodes,
    edges: building.edges,
    photos: building.photos,
    connectors: building.connectors,
    routing: building.routing,
    assets: Object.entries(building.assets).map(([id, a]) => [id, a.hash]),
  });
}
