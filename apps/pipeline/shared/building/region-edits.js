import { SPACE_KINDS, applyAccessDecisions, regionLabel, spaceRole } from "./access.js";

// Developer region edits: rename, mark or unmark a stair, set the kind, merge
// regions. Each runs through the shared access transaction (validation, wall
// cleanup, graph rebuild, evidence records). Only a named person's edit is
// recorded as human-reviewed; an unnamed edit is agent-inspected, like
// defineAsRoom.
const editor = (reviewer = "") => {
  const name = typeof reviewer === "string" ? reviewer.trim() : "";
  return { reviewer: name || "Unnamed editor action", reviewStatus: name ? "human-reviewed" : "agent-inspected" };
};
function regionOf(building, floorId, spaceId) {
  const floor = building.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  const space = floor.geometry.spaces.find((s) => s.id === spaceId);
  if (!space) throw new Error("Unknown region.");
  return space;
}

export function renameSpace(building, floorId, spaceId, label, reviewer = "") {
  const space = regionOf(building, floorId, spaceId),
    name = regionLabel(label);
  if (name === space.label) return building;
  return applyAccessDecisions(building, floorId, [{ op: "rename-space", spaceId, label: name }], {
    ...editor(reviewer), reason: `${space.label} renamed to ${name}`,
  }).building;
}

// `stair` true marks the region as a walkable stair (kind lobby, use stair);
// false makes it a room again. Asking for the current state changes nothing.
export function setSpaceStair(building, floorId, spaceId, stair, reviewer = "") {
  if (typeof stair !== "boolean") throw new Error("Say whether the region is a stair (stair: true or false).");
  const space = regionOf(building, floorId, spaceId);
  if ((space.use === "stair") === stair) return building;
  return applyAccessDecisions(building, floorId, [{ op: "set-space-use", spaceId, use: stair ? "stair" : null }], {
    ...editor(reviewer), reason: stair ? `${space.label} marked as a stair` : `${space.label} unmarked as a stair`,
  }).building;
}

// Sets a region's role (see SPACE_KINDS in access.js): "room", "hall-room" (a
// room that also works as a hall), "corridor", "lobby", "stair" or "closed"
// (cannot be entered; its doorways are kept, unused). Any role but "closed"
// re-opens a closed or non-walkable region with its doors. A stair given any
// other role is no longer a stair. Asking for the current role changes nothing.
export function setSpaceKind(building, floorId, spaceId, kind, reviewer = "") {
  if (!SPACE_KINDS.includes(kind))
    throw new Error(`Choose a region kind: ${SPACE_KINDS.slice(0, -1).join(", ")} or ${SPACE_KINDS.at(-1)}.`);
  const space = regionOf(building, floorId, spaceId);
  if (spaceRole(space) === kind) return building;
  return applyAccessDecisions(building, floorId, [{ op: "set-space-kind", spaceId, kind }], {
    ...editor(reviewer), reason: kind === "closed" ? `${space.label} closed` : `${space.label} set to ${kind}`,
  }).building;
}

// Merges regions into the first ID. `stair`: true makes the result a stair,
// false a non-stair; omitted keeps a stair only if every region was one.
export function mergeSpaces(building, floorId, spaceIds, { label, stair, reviewer = "" } = {}) {
  if (!building.floors.some((f) => f.id === floorId)) throw new Error("Unknown floor.");
  if (stair !== undefined && typeof stair !== "boolean") throw new Error("stair must be true or false.");
  if (label !== undefined && label !== null && typeof label !== "string") throw new Error("The merged region's name must be text.");
  const use = stair === undefined ? undefined : stair ? "stair" : null,
    result = applyAccessDecisions(building, floorId, [{ op: "merge-spaces", spaceIds, label, use }], {
      ...editor(reviewer), reason: `Merged ${Array.isArray(spaceIds) ? spaceIds.length : 0} regions`,
    });
  return { building: result.building, spaceId: spaceIds[0] };
}
