// Read-only map API for mobile photo capture, mounted at /api/capture-map
// (contract: docs/photo-capture.md, "Pipeline map API"). Buildings come from
// the building library (parsed once per file change, see building-library.js)
// plus the in-memory SYNTHETIC TEST FIXTURE. Nothing here writes a building.
import express from "express";
import { z } from "zod";
import { libraryEntries, libraryEntry } from "./building-library.js";
import { renderFloor } from "./authoring-routes.js";
import { captureFixture, CAPTURE_FIXTURE_ID } from "./capture-fixture.js";
import {
  CaptureError, chainView, corridorChains, floorFeatures, planCapturePoints, scaleOf, snapToCorridor,
} from "../shared/building/capture-points.js";

const hasCorridors = (b, floorId) => b.edges.some((e) => e.floorId === floorId && e.traversal === "corridor");
const floorList = (b) => [...b.floors].sort((x, y) => x.level - y.level).filter((f) => hasCorridors(b, f.id))
  .map((f) => ({ id: f.id, label: f.label, revision: f.revision, scaleVerified: !!scaleOf(f) }));

async function resolve(buildingId) {
  if (buildingId === CAPTURE_FIXTURE_ID) return { building: captureFixture(), identity: "fixture" };
  const entry = await libraryEntry(buildingId);
  if (!entry) throw new CaptureError("Unknown building.", 404);
  return { building: entry.building, identity: `${entry.file}:${entry.identity}` };
}

// Derived data per building file version and floor (chains, features, SVG).
const derived = new Map();
function floorData(buildingId, identity, building, floorId) {
  if (!building.floors.some((f) => f.id === floorId)) throw new CaptureError("Unknown floor.", 404);
  const key = `${buildingId}|${identity}|${floorId}`;
  let hit = derived.get(key);
  if (!hit) {
    if (derived.size > 64) derived.clear();
    const chains = corridorChains(building, floorId);
    hit = { chains, features: floorFeatures(building, floorId, chains), svg: null };
    derived.set(key, hit);
  }
  return hit;
}

const Base = z.object({
  buildingId: z.string().min(1).max(200),
  floorId: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
  corridorId: z.string().min(1).max(200),
  direction: z.enum(["forward", "reverse"]),
});
const PlanBody = Base.extend({ spacingM: z.number().min(0.5).max(50).nullable().optional() });
const SnapBody = Base.extend({
  x: z.number().finite().optional(), y: z.number().finite().optional(),
  corridorDistancePx: z.number().finite().nonnegative().optional(),
}).refine((b) => Number.isFinite(b.corridorDistancePx) || (Number.isFinite(b.x) && Number.isFinite(b.y)),
  "Give x and y, or corridorDistancePx.");

async function current(body) {
  const { building, identity } = await resolve(body.buildingId),
    data = floorData(body.buildingId, identity, building, body.floorId),
    floor = building.floors.find((f) => f.id === body.floorId);
  if (body.revision !== floor.revision)
    throw Object.assign(new CaptureError("The map changed since this plan was made. Reload the floor.", 409), { currentRevision: floor.revision });
  return { building, data };
}

const fail = (res, next) => (e) => {
  if (e instanceof CaptureError)
    return res.status(e.status).json({ error: e.message, ...(e.currentRevision !== undefined ? { currentRevision: e.currentRevision } : {}) });
  if (e.name === "ZodError")
    return res.status(400).json({ error: "Invalid request: " + e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ") });
  next(e);
};

export function captureMapRouter() {
  const r = express.Router();
  r.get("/buildings", async (_, res, next) => {
    try {
      const library = (await libraryEntries())
        .filter((e) => e.building.floors.some((f) => hasCorridors(e.building, f.id)))
        .map((e) => ({ id: e.key, name: e.building.name, floors: floorList(e.building) })),
        fx = captureFixture();
      res.json([...library, { id: CAPTURE_FIXTURE_ID, name: fx.name, floors: floorList(fx) }]);
    } catch (e) { fail(res, next)(e); }
  });
  r.get("/buildings/:buildingId/floors/:floorId", async (req, res, next) => {
    try {
      const { buildingId, floorId } = req.params, { building, identity } = await resolve(buildingId),
        data = floorData(buildingId, identity, building, floorId), floor = building.floors.find((f) => f.id === floorId),
        ppm = scaleOf(floor);
      data.svg ??= renderFloor(building, floorId);
      res.json({
        buildingId, floorId, floorLabel: floor.label, revision: floor.revision, width: floor.width, height: floor.height,
        scale: { verified: !!ppm, pixelsPerMetre: ppm },
        svg: data.svg,
        corridors: data.chains.map(chainView),
        nodes: data.features.nodes,
        landmarks: data.features.landmarks,
      });
    } catch (e) { fail(res, next)(e); }
  });
  r.post("/plan", async (req, res, next) => {
    try {
      const body = PlanBody.parse(req.body), { building, data } = await current(body);
      res.json(planCapturePoints(building, body.floorId, body.corridorId,
        { direction: body.direction, spacingM: body.spacingM ?? 2, chains: data.chains }));
    } catch (e) { fail(res, next)(e); }
  });
  r.post("/snap", async (req, res, next) => {
    try {
      const body = SnapBody.parse(req.body), { building, data } = await current(body);
      res.json(snapToCorridor(building, body.floorId, body.corridorId,
        { direction: body.direction, x: body.x, y: body.y, corridorDistancePx: body.corridorDistancePx, chains: data.chains }));
    } catch (e) { fail(res, next)(e); }
  });
  return r;
}
