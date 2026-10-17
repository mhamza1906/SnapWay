// Endpoints the SnapWay Angular app uses for map authoring. Every geometry or
// access change goes through the shared access transaction (applyAccessDecisions)
// inside the doorway helpers; nothing here writes a saved file.
import express from "express";
import multer from "multer";
import { preparePlan } from "./pipelines/preparation.js";
import { hashBytes } from "./pipelines/extraction.js";
import { BuildingSchema, newBuilding, newFloor, parseBuilding } from "../shared/building/schema.js";
import { emptyMap } from "../shared/map.js";
import { designedSVG } from "../shared/building/design.js";
import { accessInventory } from "../shared/building/access.js";
import { roomAvailability, routeBuilding } from "../shared/building/routing.js";
import { routeDisplaySegments } from "../shared/building/route-display.js";
import { validateBuilding } from "../shared/building/validation.js";
import {
  addAssumedDoor, assumedDoors, defineAsRoom, defineNotRoom, doorEdgeOptions,
  editAssumedDoor, placeAssumedDoorways, removeAssumedDoor,
} from "../shared/building/assumed-doors.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const body = (req) => ({ building: BuildingSchema.parse(req.body.building), floorId: req.body.floorId });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const edgeView = (c) => ({ key: c.key, adjacentId: c.adjacentId, adjacentLabel: c.adjacentLabel, adjacentKind: c.adjacentKind,
  hallway: c.hallway, length: Math.round(c.length), doors: c.doors ?? null, a: c.a, b: c.b });

// Everything the authoring screen lists for one floor; geometry stays on the server.
export function floorSummary(building, floorId, rooms = roomAvailability(building)) {
  const floor = building.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  const inventory = accessInventory(building, rooms).floors.find((f) => f.floorId === floorId),
    doors = (id) => floor.geometry.doors.filter((d) => d.spaceIds.includes(id)).length;
  return {
    floorId, label: floor.label, level: floor.level, geometryStatus: floor.geometryStatus,
    regions: floor.geometry.spaces.length,
    rooms: rooms.filter((r) => r.floorId === floorId).map((r) => ({ id: r.id, label: r.label, kind: r.kind, ready: r.ready, reason: r.reason, doors: doors(r.id) })),
    spaces: floor.geometry.spaces.filter((s) => s.access !== "nonwalkable")
      .map((s) => ({ id: s.id, label: s.label, kind: s.kind, doors: doors(s.id) }))
      .sort((a, z) => a.label.localeCompare(z.label, undefined, { numeric: true })),
    needsAttention: inventory.queue.map((q) => ({ spaceId: q.spaceId, label: q.label, kind: q.kind, status: q.status, reason: q.reason })),
    assumed: assumedDoors(floor).map((a) => ({
      doorId: a.door.id, roomId: a.room.id, roomLabel: a.room.label, roomDoors: doors(a.room.id),
      edgeKey: a.edgeKey, t: a.t, width: a.width, segment: { a: a.door.a, b: a.door.b },
      candidates: a.candidates.map(edgeView),
    })),
    counts: { verified: inventory.verified, assumed: inventory.assumed, ready: rooms.filter((r) => r.floorId === floorId && r.ready).length, destinations: inventory.destinations },
  };
}

export function buildingSummary(building) {
  const rooms = roomAvailability(building);
  return {
    id: building.id, name: building.name,
    floors: building.floors.map((f) => floorSummary(building, f.id, rooms)),
    validationErrors: validateBuilding(building).filter((i) => i.severity === "error").length,
  };
}

// The designed SVG plus optional highlights (a door being edited, a route).
// Overlay coordinates come from the request; only finite numbers reach the SVG.
const num = (v) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error("Overlay coordinates must be numbers."); return n; };
export function renderFloor(building, floorId, overlay = {}) {
  const svg = designedSVG(building, floorId),
    lines = (overlay.segments || []).map((s) =>
      `<line x1="${num(s.a.x)}" y1="${num(s.a.y)}" x2="${num(s.b.x)}" y2="${num(s.b.y)}" stroke="${esc(s.color || "#c2185b")}" stroke-width="4" stroke-linecap="round"/>`),
    paths = (overlay.routes || []).map((pts) =>
      `<polyline points="${pts.map((p) => `${num(p.x)},${num(p.y)}`).join(" ")}" fill="none" stroke="#1565c0" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
  return lines.length || paths.length ? svg.replace(/<\/svg>$/, `<g data-overlay="true">${paths.join("")}${lines.join("")}</g></svg>`) : svg;
}

const respond = (res, building, extra = {}) => res.json({ building, summary: buildingSummary(building), ...extra });

export function authoringRouter() {
  const r = express.Router();
  // A PDF or image becomes a building with one floor per page, ready for /api/map-jobs.
  r.post("/plans", upload.single("plan"), async (req, res, next) => {
    try {
      if (!req.file) throw new Error("Choose a PDF, PNG or JPEG floor plan.");
      const prepared = await preparePlan(req.file.buffer, req.file.originalname, req.file.mimetype),
        b = newBuilding();
      b.id = "plan-" + hashBytes(req.file.buffer).slice(0, 16);
      b.name = (req.body.name || req.file.originalname.replace(/\.[^.]+$/, "")).slice(0, 200);
      b.provenance = "SnapWay map-authoring pipeline from an uploaded plan; uncertain access remains disabled.";
      b.assets = prepared.assets;
      b.floors = prepared.sources.map((source, i) => {
        const f = newFloor(`floor-${i + 1}`, prepared.sources.length === 1 && req.body.floorLabel ? req.body.floorLabel : `Floor ${i + 1}`, i + 1);
        f.width = source.width; f.height = source.height;
        f.sources = [{ ...source, geometryIds: [], alignment: "reviewed",
          notes: "Each uploaded page is its own floor in source coordinates. No human alignment review claimed." }];
        f.geometry = emptyMap({ name: source.name, width: source.width, height: source.height,
          dataUrl: b.assets[source.assetId].dataUrl, normalized: true, provenance: "Original source", fictional: false });
        return f;
      });
      const building = parseBuilding(b);
      res.json({ building, summary: buildingSummary(building) });
    } catch (e) { next(e); }
  });
  r.post("/summary", (req, res, next) => {
    try { res.json(buildingSummary(BuildingSchema.parse(req.body.building))); } catch (e) { next(e); }
  });
  r.post("/render", (req, res, next) => {
    try { const { building, floorId } = body(req); res.json({ svg: renderFloor(building, floorId, req.body.overlay) }); } catch (e) { next(e); }
  });
  r.post("/routes", (req, res, next) => {
    try {
      const building = BuildingSchema.parse(req.body.building),
        known = new Set(building.floors.flatMap((f) => f.geometry.spaces.map((s) => s.id)));
      for (const id of [req.body.from, req.body.to]) if (!known.has(id)) throw new Error(`Unknown room ${id}.`);
      const route = routeBuilding(building, req.body.from, req.body.to);
      if (!route) return res.json({ route: null, message: "No connected route between these rooms yet." });
      const floors = route.floorIds.map((floorId) => ({ floorId, segments: routeDisplaySegments(route, floorId).map((seg) => seg.displayPoints) }));
      res.json({ route: { steps: route.steps.length, cost: route.cost, units: route.units, floorIds: route.floorIds, floors } });
    } catch (e) { next(e); }
  });
  // Doorway tools.
  r.post("/doorways/place", (req, res, next) => {
    try {
      const { building, floorId } = body(req),
        floors = floorId ? [floorId] : building.floors.filter((f) => f.geometryStatus === "reviewed").map((f) => f.id);
      let b = building; const results = [];
      for (const id of floors) {
        const out = placeAssumedDoorways(b, id, { spaceIds: req.body.spaceIds || null });
        b = out.building;
        results.push({ floorId: id, placed: out.placed, skipped: out.skipped, roomed: out.roomed || [], enabled: out.enabled || [], bridged: out.bridged || [] });
      }
      respond(res, b, { results });
    } catch (e) { next(e); }
  });
  r.post("/doorways/define-room", (req, res, next) => {
    try { const { building, floorId } = body(req), out = defineAsRoom(building, floorId, req.body.spaceId, req.body.reviewer || "");
      respond(res, out.building, { placed: out.placed, skipped: out.skipped }); } catch (e) { next(e); }
  });
  r.post("/doorways/not-room", (req, res, next) => {
    try { const { building, floorId } = body(req); respond(res, defineNotRoom(building, floorId, req.body.spaceId, req.body.reviewer || "")); } catch (e) { next(e); }
  });
  r.post("/doorways/edges", (req, res, next) => {
    try { const { building, floorId } = body(req), floor = building.floors.find((f) => f.id === floorId);
      res.json({ edges: doorEdgeOptions(floor, req.body.spaceId).map(edgeView) }); } catch (e) { next(e); }
  });
  r.post("/doorways/add", (req, res, next) => {
    try { const { building, floorId } = body(req),
        out = addAssumedDoor(building, floorId, req.body.spaceId, req.body.reviewer || "", { edgeKey: req.body.edgeKey ?? null });
      respond(res, out.building, { doorId: out.doorId, opensOnto: out.opensOnto }); } catch (e) { next(e); }
  });
  r.post("/doorways/edit", (req, res, next) => {
    try { const { building, floorId } = body(req), { doorId, edgeKey, t, width, confirm, reviewer } = req.body;
      respond(res, editAssumedDoor(building, floorId, doorId, { edgeKey, t, width, confirm: !!confirm, reviewer: reviewer || "" })); } catch (e) { next(e); }
  });
  r.post("/doorways/remove", (req, res, next) => {
    try { const { building, floorId } = body(req); respond(res, removeAssumedDoor(building, floorId, req.body.doorId, req.body.reviewer || "")); } catch (e) { next(e); }
  });
  return r;
}
