/** Read-only export of existing Sam Ibrahim access/connector graph for the photo app. */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { edgeIssue } from "../apps/pipeline/shared/building/validation.js";
import { roomAvailability } from "../apps/pipeline/shared/building/routing.js";
import { roomDoorNodes } from "../apps/pipeline/shared/building/endpoints.js";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "apps/web/public/experiments");
const building = JSON.parse(
  readFileSync(join(root, "apps/pipeline/public/buildings/sam-ibrahim.json")),
);
const photoPlan = JSON.parse(
  readFileSync(join(target, "entrance-node19.json")),
);
const floorById = new Map(building.floors.map((floor) => [floor.id, floor]));
const contexts = new Map();
const usable = building.edges.filter(
  (edge) =>
    edge.status === "reviewed" &&
    !edge.restricted &&
    !edgeIssue(building, edge, { contexts }),
);
const norm = (floorId) => {
  const floor = floorById.get(floorId);
  return (
    building.routing.uncalibratedFloorCost /
    Math.hypot(floor.width, floor.height)
  );
};
const nodes = photoPlan.nodes.map((node) => ({ ...node, floorId: "L1" }));
const edges = photoPlan.edges.map((edge) => {
  const a = nodes.find((n) => n.id === edge.from),
    b = nodes.find((n) => n.id === edge.to);
  return {
    ...edge,
    floorId: "L1",
    traversal: "corridor",
    cost: Math.hypot(a.x - b.x, a.y - b.y) * norm("L1"),
  };
});
for (const node of building.nodes)
  nodes.push({
    id: node.id,
    label: node.label,
    floorId: node.floorId,
    kind: node.type,
    ...node.position,
    connectorId: node.connectorId,
  });
for (const edge of usable) {
  const vertical = ["stairs", "elevator"].includes(edge.traversal);
  const common = {
    floorId: edge.floorId,
    traversal: edge.traversal,
    connectorId: edge.connectorId,
    directed: edge.direction !== "both",
  };
  if (vertical) {
    const connector = building.connectors.find(
      (c) => c.id === edge.connectorId,
    );
    edges.push({
      ...common,
      from: edge.from,
      to: edge.to,
      connectorLabel: connector?.label ?? edge.traversal,
      cost:
        edge.traversal === "stairs"
          ? building.routing.stairsPenalty
          : building.routing.elevatorPenalty,
    });
  } else {
    const chain = [edge.from];
    for (let i = 1; i < edge.path.length - 1; i++) {
      const id = `${edge.id}:photo-route:${i}`;
      nodes.push({
        id,
        label: "Corridor bend",
        kind: "junction",
        floorId: edge.floorId,
        ...edge.path[i],
      });
      chain.push(id);
    }
    chain.push(edge.to);
    for (let i = 1; i < chain.length; i++) {
      const a = nodes.find((n) => n.id === chain[i - 1]),
        b = nodes.find((n) => n.id === chain[i]);
      edges.push({
        ...common,
        from: a.id,
        to: b.id,
        cost: Math.hypot(a.x - b.x, a.y - b.y) * norm(edge.floorId),
      });
    }
  }
}
// Old photo graph and source project share the same SVG frame. Join coincident vertices only.
for (const node of nodes.filter(
  (n) => n.floorId === "L1" && !photoPlan.nodes.some((old) => old.id === n.id),
)) {
  const old = photoPlan.nodes.find(
    (p) => Math.hypot(node.x - p.x, node.y - p.y) <= 0.75,
  );
  if (old)
    edges.push({
      from: old.id,
      to: node.id,
      floorId: "L1",
      traversal: "corridor",
      cost: Math.hypot(node.x - old.x, node.y - old.y) * norm("L1"),
    });
}
const reachable = new Set([photoPlan.entryId]),
  queue = [...reachable];
for (let i = 0; i < queue.length; i++)
  for (const edge of edges) {
    const next =
      edge.from === queue[i]
        ? edge.to
        : !edge.directed && edge.to === queue[i]
          ? edge.from
          : null;
    if (next && !reachable.has(next)) {
      reachable.add(next);
      queue.push(next);
    }
  }
const destinations = [];
for (const room of roomAvailability(building)) {
  const doors = roomDoorNodes(building, room.id);
  const connected = doors.filter((n) => reachable.has(n.id));
  const terminal = connected[0] ?? doors[0];
  const floor = floorById.get(room.floorId);
  const space = floor.geometry.spaces.find((s) => s.id === room.id);
  const point = terminal?.position ?? space.polygon[0];
  destinations.push({
    id: room.id,
    label: room.label,
    floorId: room.floorId,
    floorLabel: floor.label,
    kind: "room",
    ...point,
    terminalNodeId: terminal?.id ?? "",
    terminalNodeIds: connected.map((n) => n.id),
    available: room.ready && connected.length > 0,
    doorId: terminal?.doorId ?? "",
    accessNote:
      room.ready && connected.length
        ? "Saved source doorway; physical access is not field verified."
        : room.reason || "No connected route from the saved photo graph.",
  });
}
for (const node of building.nodes.filter((n) => n.connectorId)) {
  const floor = floorById.get(node.floorId),
    connector = building.connectors.find((c) => c.id === node.connectorId);
  destinations.push({
    id: node.id,
    label: connector?.label ?? node.label,
    floorId: node.floorId,
    floorLabel: floor.label,
    kind: connector?.type ?? "connector",
    ...node.position,
    terminalNodeId: node.id,
    terminalNodeIds: [node.id],
    available: reachable.has(node.id),
    doorId: "",
    accessNote: reachable.has(node.id)
      ? "Saved stair/elevator landing; served floors and operating access are unverified."
      : "No saved connected access route.",
  });
}
mkdirSync(join(target, "sam-floors"), { recursive: true });
const floors = building.floors.map((floor) => {
  const suffix = floor.id === "LB" ? "B" : floor.id.slice(1);
  copyFileSync(
    join(
      root,
      `experiments/sam-ibrahim-hardcoded/source/Level-${suffix}-original.svg`,
    ),
    join(target, `sam-floors/${floor.id}.svg`),
  );
  return {
    id: floor.id,
    label: floor.label,
    width: floor.width,
    height: floor.height,
    underlay: `/experiments/sam-floors/${floor.id}.svg`,
  };
});
writeFileSync(
  join(target, "photo-building-navigation.json"),
  JSON.stringify({
    ...photoPlan,
    nodes,
    edges,
    floors,
    destinations,
    photoReferenceFloorIds: ["L1"],
    provenance:
      "Read-only source graph export. No doorway, connector, access review or original photo ID changed.",
  }),
);
console.log(
  `${destinations.length} destinations on ${floors.length} floors; ${destinations.filter((d) => d.available).length} source-connected. ${nodes.length} vertices, ${edges.length} segments.`,
);
