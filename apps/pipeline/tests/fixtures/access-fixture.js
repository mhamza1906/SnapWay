import sharp from "sharp";
import { createHash } from "node:crypto";
import { newBuilding, newFloor, parseBuilding } from "../../shared/building/schema.js";
import { buildGraph } from "../../shared/building/graph.js";
import { traceBoundaryWalls } from "../../shared/building/coverage.js";

export const rect = (x, y, r, b) => [
  { x, y },
  { x: r, y },
  { x: r, y: b },
  { x, y: b },
];
const space = (id, label, kind, polygon, extra = {}) => ({
  id,
  label,
  kind,
  polygon,
  confidence: 1,
  ...extra,
});
const door = (id, a, b, spaceIds) => ({
  id,
  label: id,
  a,
  b,
  spaceIds,
  confidence: 1,
});

// Synthetic access fixture (not a real building): rooms around a corridor,
// an unknown room B with no opening, a concave room E, a non-walkable void F,
// a decomposed corridor piece and a suite D. Source pixels draw the walls.
export async function accessFixture({ transform = [1, 0, 0, 1, 0, 0] } = {}) {
  const b = newBuilding();
  b.id = "access-fixture";
  b.name = "Synthetic access fixture";
  b.provenance = "Synthetic test fixture; not a real building";
  const f = newFloor("fx", "Fixture floor", 1);
  f.width = 400;
  f.height = 300;
  f.geometry.source.width = 400;
  f.geometry.source.height = 300;
  f.geometry.spaces = [
    space("fx:corridor", "Corridor", "corridor", rect(0, 100, 400, 140)),
    space("fx:a", "101", "room", rect(0, 0, 100, 100)),
    space("fx:b", "102", "room", rect(100, 0, 200, 100), { access: "unknown" }),
    space("fx:c", "103", "room", rect(200, 0, 300, 100)),
    space("fx:d", "104 / 104X", "room", rect(300, 0, 400, 100)),
    space("fx:e", "105", "room", [
      { x: 0, y: 140 },
      { x: 150, y: 140 },
      { x: 150, y: 200 },
      { x: 80, y: 200 },
      { x: 80, y: 260 },
      { x: 0, y: 260 },
    ]),
    space("fx:f", "Void", "room", rect(150, 140, 250, 260), {
      access: "nonwalkable",
    }),
    space("fx:corridor-2", "Corridor piece", "corridor", rect(250, 140, 400, 180)),
  ];
  f.geometry.doors = [
    door("fx:door-a", { x: 40, y: 100 }, { x: 50, y: 100 }, ["fx:a", "fx:corridor"]),
    door("fx:door-c", { x: 240, y: 100 }, { x: 250, y: 100 }, ["fx:c", "fx:corridor"]),
    door("fx:door-d", { x: 340, y: 100 }, { x: 350, y: 100 }, ["fx:d", "fx:corridor"]),
    door("fx:door-e", { x: 20, y: 140 }, { x: 30, y: 140 }, ["fx:e", "fx:corridor"]),
    door(
      "fx:join",
      { x: 250, y: 140 },
      { x: 400, y: 140 },
      ["fx:corridor", "fx:corridor-2"],
    ),
  ];
  f.geometry.walls = traceBoundaryWalls(f.geometry);
  // Draw the source: walls in black, with a door arc drawn in B's wall at
  // x 140–150 so a positive visual exists for the agent fixture.
  const lines = f.geometry.walls
    .map(
      (w) =>
        `<line x1="${w.points[0].x}" y1="${w.points[0].y}" x2="${w.points[1].x}" y2="${w.points[1].y}" stroke="black" stroke-width="2"/>`,
    )
    .join("");
  const png = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="white"/>${lines}<path d="M140 100 A10 10 0 0 1 150 90" fill="none" stroke="black"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const hash = createHash("sha256").update(png).digest("hex");
  b.assets["fx-plan"] = {
    id: "fx-plan",
    name: "Fixture plan",
    mime: "image/png",
    dataUrl: "data:image/png;base64," + png.toString("base64"),
    hash,
    provenance: "Synthetic test image",
  };
  f.sources = [
    {
      id: "fx-source",
      assetId: "fx-plan",
      originalAssetId: "fx-plan",
      name: "Fixture plan",
      width: 400,
      height: 300,
      page: null,
      hash,
      transform,
      sectionId: "fx-section",
      geometryIds: [],
      alignment: "reviewed",
      landmarks: [],
      notes: "Synthetic",
      visible: true,
      coverage: null,
    },
  ];
  f.geometryStatus = "reviewed";
  f.reviewer = "Fixture";
  f.geometry.review.status = "reviewed";
  b.floors = [f];
  return buildGraph(parseBuilding(b), "fx");
}
