import { z } from "zod";
import { MapSchema, Point, emptyMap, clone, LIGHT_IMAGE } from "../map.js";
import { PresentationSchema } from "./design.js";
import { AccessSchema, ACCESS_VERSION } from "./access-state.js";
const id = z.string().min(1).max(150),
  status = z.enum(["draft", "reviewed", "stale"]);
const asset = z.object({
  id,
  name: z.string(),
  mime: z.string(),
  dataUrl: z.string().startsWith("data:"),
  hash: z.string(),
  provenance: z.string(),
});
// A floor history entry with everything kept except the floor image
// (geometry.source.dataUrl becomes LIGHT_IMAGE). Nothing reads the image of a
// past geometry, and each entry used to repeat the full floor image
// (megabytes) up to 10 times. Never mutates its input; anything without a
// string image is returned unchanged for the schema to judge.
export function lightHistoryEntry(entry) {
  const source = entry?.geometry?.source;
  if (typeof source?.dataUrl !== "string" || source.dataUrl === LIGHT_IMAGE) return entry;
  return { ...entry, geometry: { ...entry.geometry, source: { ...source, dataUrl: LIGHT_IMAGE } } };
}
export const SourceSchema = z.object({
  id,
  assetId: id,
  originalAssetId: id,
  name: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  page: z.number().int().positive().nullable(),
  hash: z.string(),
  transform: z.tuple([
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
  sectionId: id,
  geometryIds: z.array(id).default([]),
  alignment: status,
  landmarks: z.array(z.object({ image: Point, floor: Point })),
  notes: z.string(),
  visible: z.boolean(),
  coverage: z
    .object({
      version: z.literal(1),
      createdAt: z.string(),
      stage: z.enum(["needs-review", "complete"]),
      tiles: z.number(),
      items: z.array(
        z.object({
          label: z.string(),
          position: Point,
          spaceId: id.nullable(),
          kind: z.string().optional(),
          excluded: z.boolean().optional(),
          reason: z.string().optional(),
        }),
      ),
    })
    .passthrough()
    .nullable()
    .default(null),
});
export const NodeSchema = z.object({
  id,
  floorId: id,
  label: z.string(),
  type: z.enum([
    "entrance",
    "doorway",
    "destination",
    "junction",
    "bend",
    "stair",
    "elevator",
  ]),
  position: Point,
  spaceIds: z.array(id).min(1),
  doorId: id.nullable(),
  connectorId: id.nullable(),
  status,
});
export const EdgeSchema = z.object({
  id,
  from: id,
  to: id,
  floorId: id.nullable(),
  path: z.array(Point).min(2),
  direction: z.enum(["both", "forward"]),
  traversal: z.enum(["corridor", "doorway", "stairs", "elevator"]),
  connectorId: id.nullable(),
  length: z.number().nonnegative(),
  units: z.enum(["px", "m", "transition"]),
  accessible: z.enum(["unknown", "yes", "no"]),
  restricted: z.boolean(),
  status,
  photoIds: z.array(id),
  geometryRevision: z.number().int().nonnegative(),
  // Narrowest clear width along the whole path (turns included). widthM only
  // when the floor has a scale; `issue` flags wall contact or < 0.9 m.
  clearance: z
    .object({
      widthPx: z.number().nullable(),
      widthM: z.number().nullable(),
      at: Point.nullable(),
      issue: z.string().nullable(),
    })
    .nullable()
    .default(null),
});
export const PhotoSchema = z.object({
  id,
  assetId: id,
  buildingId: id,
  floorId: id,
  edgeId: id.nullable(),
  nodeId: id.nullable(),
  position: Point,
  along: z.number().min(0).max(1).nullable(),
  direction: z.number().min(0).lt(360),
  label: z.string(),
  captureDate: z.string(),
  description: z.string(),
  status,
  kind: z.enum(["real", "test"]),
  issue: z.string(),
});
export const FloorSchema = z.object({
  id,
  label: z.string().min(1),
  level: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  sources: z.array(SourceSchema),
  geometry: MapSchema,
  presentation: PresentationSchema.default({}),
  access: AccessSchema,
  revision: z.number().int().nonnegative(),
  geometryStatus: status,
  reviewer: z.string(),
  reviewNotes: z.string(),
  graphRevision: z.number().int(),
  // Developer corrections to the centreline network, replayed on every rebuild.
  navOverrides: z
    .array(
      z.object({
        op: z.enum(["move-node", "edge-path", "door-link"]),
        spaceId: id.nullable().default(null),
        at: Point.optional(),
        to: Point.optional(),
        from: Point.optional(),
        path: z.array(Point).optional(),
        doorId: id.optional(),
        applied: z.boolean().default(true),
      }),
    )
    .default([]),
  // Geometry only: the floor image is replaced by LIGHT_IMAGE on every parse,
  // so a saved building with full images in its history shrinks on load.
  history: z.array(
    z.preprocess(
      lightHistoryEntry,
      z.object({
        revision: z.number(),
        at: z.string(),
        reason: z.string(),
        geometry: MapSchema,
      }),
    ),
  ),
  snapshots: z.array(
    z.object({
      sourceId: id,
      cacheKey: z.string(),
      createdAt: z.string(),
      mode: z.string(),
      geometry: MapSchema,
      coverage: z.any().nullable().optional(),
    }),
  ),
});
export const BuildingSchema = z.object({
  version: z.literal(2),
  id,
  name: z.string().min(1),
  provenance: z.string(),
  assets: z.record(asset),
  floors: z.array(FloorSchema),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  connectors: z.array(
    z.object({
      id,
      label: z.string(),
      type: z.enum(["stairs", "elevator"]),
      landingIds: z.array(id).min(2),
      status,
      evidence: z.string(),
    }),
  ),
  photos: z.array(PhotoSchema),
  routing: z.object({
    stairsPenalty: z.number().nonnegative(),
    elevatorPenalty: z.number().nonnegative(),
    uncalibratedFloorCost: z.number().positive(),
  }),
  updatedAt: z.string(),
});
export function newBuilding() {
  return {
    version: 2,
    id: `building-${Date.now()}`,
    name: "Untitled building",
    provenance: "User project",
    assets: {},
    floors: [],
    nodes: [],
    edges: [],
    connectors: [],
    photos: [],
    routing: {
      stairsPenalty: 2,
      elevatorPenalty: 3,
      uncalibratedFloorCost: 10,
    },
    updatedAt: new Date().toISOString(),
  };
}
export function newFloor(id, label, level = 0) {
  return {
    id,
    label,
    level,
    width: 1600,
    height: 1200,
    sources: [],
    geometry: emptyMap({
      name: "Blank floor",
      width: 1600,
      height: 1200,
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      normalized: true,
      provenance: "Blank floor",
      fictional: false,
    }),
    access: { version: ACCESS_VERSION, records: [] },
    revision: 0,
    geometryStatus: "draft",
    reviewer: "",
    reviewNotes: "",
    graphRevision: -1,
    history: [],
    snapshots: [],
  };
}
export function parseBuilding(value) {
  return BuildingSchema.parse(
    typeof value === "string" ? JSON.parse(value) : value,
  );
}
export function geometryChanged(
  building,
  floorId,
  geometry,
  reason = "Geometry edited",
) {
  const b = clone(building),
    f = b.floors.find((f) => f.id === floorId);
  f.history.push({
    revision: f.revision,
    at: new Date().toISOString(),
    reason,
    geometry: f.geometry,
  });
  f.history = f.history.slice(-10).map(lightHistoryEntry);
  f.geometry = MapSchema.parse(geometry);
  for (const s of f.sources) if (s.coverage) s.coverage.stage = "needs-review";
  f.revision++;
  f.geometryStatus = "draft";
  f.reviewer = "";
  for (const e of b.edges)
    if (
      e.floorId === floorId ||
      [e.from, e.to].some(
        (id) => b.nodes.find((n) => n.id === id)?.floorId === floorId,
      )
    )
      e.status = "stale";
  for (const n of b.nodes) if (n.floorId === floorId) n.status = "stale";
  b.updatedAt = new Date().toISOString();
  return b;
}
