// SYNTHETIC TEST FIXTURE for photo capture planning (docs/photo-capture.md).
// Not a real building. Built in memory through the normal pipeline functions
// (traceBoundaryWalls + buildGraph), so it has a real corridor centreline
// graph: an L-shaped hallway with a bend, a T junction with a side hallway,
// and rooms with doors. Floor "capture-fx-1" has a verified scale of 20 px/m;
// floor "capture-fx-2" is the same layout without a scale (manual mode).
import { newBuilding, newFloor, parseBuilding } from "../shared/building/schema.js";
import { buildGraph } from "../shared/building/graph.js";
import { traceBoundaryWalls } from "../shared/building/coverage.js";

export const CAPTURE_FIXTURE_ID = "synthetic-capture-fixture";
export const CAPTURE_FIXTURE_FLOORS = { scaled: "capture-fx-1", unscaled: "capture-fx-2" };
export const FIXTURE_PIXELS_PER_METRE = 20;

const rect = (x, y, r, b) => [{ x, y }, { x: r, y }, { x: r, y: b }, { x, y: b }];

function floor(id, label, level, scaled) {
  const f = newFloor(id, label, level), p = (s) => `${id}:${s}`,
    space = (key, lbl, kind, polygon) => ({ id: p(key), label: lbl, kind, polygon, confidence: 1 }),
    door = (key, a, b, ids) => ({ id: p(key), label: key, a, b, spaceIds: ids.map(p), confidence: 1 });
  f.width = 800; f.height = 600;
  f.geometry.source.width = 800; f.geometry.source.height = 600;
  f.geometry.source.name = "SYNTHETIC TEST FIXTURE";
  f.geometry.source.provenance = "Synthetic test geometry; not a real building";
  f.geometry.source.fictional = true;
  f.geometry.floorName = label;
  // Hallway A: west arm y 100–140 (2 m wide), bend at the east end going south
  // (x 560–600), and a side stem south at x 280–320 forming a T junction.
  const hallway = [
    { x: 100, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 500 }, { x: 560, y: 500 }, { x: 560, y: 140 },
    { x: 320, y: 140 }, { x: 320, y: 400 }, { x: 280, y: 400 }, { x: 280, y: 140 }, { x: 100, y: 140 },
  ];
  f.geometry.spaces = [
    space("hallway-a", "Hallway A", "corridor", hallway),
    space("r101", "Room 101", "room", rect(100, 20, 200, 100)),
    space("r102", "Room 102", "room", rect(200, 20, 300, 100)),
    space("r103", "Room 103", "room", rect(300, 20, 450, 100)),
    space("r104", "Room 104", "room", rect(450, 20, 600, 100)),
    space("r105", "Room 105", "room", rect(600, 200, 700, 320)),
    space("r106", "Room 106", "room", rect(600, 320, 700, 460)),
    space("r107", "Room 107", "room", rect(420, 200, 560, 320)),
    space("r108", "Room 108", "room", rect(160, 200, 280, 320)),
    space("r110", "Room 110", "room", rect(100, 140, 280, 200)),
  ];
  f.geometry.doors = [
    door("d101", { x: 140, y: 100 }, { x: 156, y: 100 }, ["r101", "hallway-a"]),
    door("d102", { x: 240, y: 100 }, { x: 256, y: 100 }, ["r102", "hallway-a"]),
    door("d103", { x: 360, y: 100 }, { x: 376, y: 100 }, ["r103", "hallway-a"]),
    door("d104", { x: 500, y: 100 }, { x: 516, y: 100 }, ["r104", "hallway-a"]),
    door("d105", { x: 600, y: 250 }, { x: 600, y: 266 }, ["r105", "hallway-a"]),
    door("d106", { x: 600, y: 380 }, { x: 600, y: 396 }, ["r106", "hallway-a"]),
    door("d107", { x: 560, y: 280 }, { x: 560, y: 296 }, ["r107", "hallway-a"]),
    door("d108", { x: 280, y: 240 }, { x: 280, y: 256 }, ["r108", "hallway-a"]),
    door("d110", { x: 200, y: 140 }, { x: 216, y: 140 }, ["r110", "hallway-a"]),
  ];
  f.geometry.walls = traceBoundaryWalls(f.geometry);
  f.geometry.scale = scaled
    ? { pixelsPerMetre: FIXTURE_PIXELS_PER_METRE, a: { x: 100, y: 120 }, b: { x: 600, y: 120 }, knownMetres: 500 / FIXTURE_PIXELS_PER_METRE }
    : null;
  f.revision = 1;
  f.geometryStatus = "reviewed";
  f.reviewer = "SYNTHETIC TEST FIXTURE";
  f.reviewNotes = "Synthetic geometry for capture-planning tests; no human review claimed.";
  f.geometry.review.status = "reviewed";
  return f;
}

let cached = null;
// The fixture building, built once per process (graph construction is the
// only cost). Callers must not mutate it.
export function captureFixture() {
  if (cached) return cached;
  const b = newBuilding();
  b.id = CAPTURE_FIXTURE_ID;
  b.name = "SYNTHETIC TEST FIXTURE: capture corridors (not a real building)";
  b.provenance = "SYNTHETIC TEST FIXTURE generated in memory by apps/pipeline/server/capture-fixture.js; not a real building.";
  b.updatedAt = "2026-10-17T00:00:00.000Z";
  b.floors = [floor(CAPTURE_FIXTURE_FLOORS.scaled, "Fixture floor (20 px/m)", 1, true), floor(CAPTURE_FIXTURE_FLOORS.unscaled, "Fixture floor (no scale)", 2, false)];
  let built = parseBuilding(b);
  for (const f of built.floors) built = buildGraph(built, f.id);
  cached = built;
  return cached;
}
