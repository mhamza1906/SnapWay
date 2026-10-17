import { z } from "zod";
import { Point, distance } from "../map.js";

// Doorway verification records live beside floor geometry. They describe why
// an opening exists (or why access is unresolved) without changing MapSchema.
export const ACCESS_VERSION = "access-v1-2026-10-16";
const id = z.string().min(1).max(150),
  Rect = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  }),
  Segment = z.object({ a: Point, b: Point }),
  Failure = z.object({ code: z.string(), message: z.string() });
export const OPENING_TYPES = [
  "door",
  "double-door",
  "open-passage",
  "decomposition-join",
  "exterior-door",
];
export const CropEvidenceSchema = z.object({
  scale: z.string(),
  sourceId: id,
  sourceHash: z.string(),
  assetHash: z.string(),
  originalAssetHash: z.string().nullable(),
  renderer: z.enum(["pdf-vector", "normalized-raster"]),
  page: z.number().int().nullable(),
  rotation: z.number(),
  sourceRect: Rect,
  floorRect: Rect,
  transform: z.tuple([
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
  pixelsPerSourcePixel: z.number().positive(),
  file: z.string().nullable().default(null),
});
export const EvidenceSchema = z.object({
  // assumed: placed by rule (nearest hallway edge midpoint), not observed.
  method: z.enum(["ai-agent", "direct-visual-inspection", "manual", "assumed"]),
  description: z.string().max(3000),
  provider: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  promptVersion: z.string().nullable().default(null),
  schemaVersion: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  crops: z.array(CropEvidenceSchema).default([]),
  verifier: z
    .object({
      verdict: z.enum(["supported", "not-supported", "uncertain"]),
      observed: z.string().max(2000),
      provider: z.string(),
      model: z.string(),
    })
    .nullable()
    .default(null),
});
export const AccessRecordSchema = z.object({
  id,
  kind: z.enum(["opening", "unresolved", "classification", "rejected-door"]),
  status: z.enum(["proposed", "accepted", "rejected", "unresolved"]),
  spaceId: id,
  doorId: id.nullable().default(null),
  openingType: z.enum(OPENING_TYPES).nullable().default(null),
  adjacentIds: z.array(id).max(2).default([]),
  segment: Segment.nullable().default(null),
  label: z.string().max(200).nullable().default(null),
  change: z
    .object({
      from: z.object({
        kind: z.string(),
        access: z.string().nullable(),
        label: z.string(),
      }),
      to: z.object({
        kind: z.string(),
        access: z.string().nullable(),
        label: z.string(),
      }),
    })
    .nullable()
    .default(null),
  reason: z.string().max(3000),
  attemptedChecks: z.array(z.string().max(500)).default([]),
  evidence: EvidenceSchema,
  validation: z
    .object({
      passed: z.boolean(),
      checkedAt: z.string(),
      geometryRevision: z.number().int(),
      failures: z.array(Failure),
      routeCheck: z
        .object({ passed: z.boolean(), message: z.string() })
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null),
  review: z.object({
    status: z.enum([
      "unreviewed",
      "agent-inspected",
      "human-reviewed",
      "rejected",
    ]),
    reviewer: z.string(),
    at: z.string().nullable(),
    notes: z.string(),
  }),
  geometryRevision: z.number().int(),
  createdAt: z.string(),
  version: z.string(),
  jobId: z.string().nullable().default(null),
});
export const AccessSchema = z
  .object({
    version: z.string().default(ACCESS_VERSION),
    records: z.array(AccessRecordSchema).default([]),
  })
  .default({});

const records = (floor) => floor.access?.records || [];
const sameSegment = (s, d) =>
  (distance(s.a, d.a) < 0.5 && distance(s.b, d.b) < 0.5) ||
  (distance(s.a, d.b) < 0.5 && distance(s.b, d.a) < 0.5);
const sameIds = (a, z) =>
  a.length === z.length && a.every((id) => z.includes(id));

export function doorRecord(floor, doorId) {
  return records(floor).findLast(
    (r) => r.doorId === doorId && ["opening", "rejected-door"].includes(r.kind),
  );
}
// legacy: door predates per-opening evidence and passed floor geometry review.
export function doorAccessState(floor, door) {
  const record = doorRecord(floor, door.id);
  if (!record) return { state: "legacy", record: null, reason: "" };
  if (record.status === "rejected" || record.kind === "rejected-door")
    return {
      state: "rejected",
      record,
      reason: "Opening rejected after source comparison",
    };
  if (record.status !== "accepted")
    return {
      state: "stale",
      record,
      reason: "Opening is still a proposal and has not been accepted",
    };
  if (
    !record.segment ||
    !sameSegment(record.segment, door) ||
    !sameIds(record.adjacentIds, door.spaceIds)
  )
    return {
      state: "stale",
      record,
      reason: "Door geometry changed after its evidence was recorded",
    };
  if (!record.validation?.passed)
    return {
      state: "stale",
      record,
      reason: "Opening has not passed deterministic validation",
    };
  if (record.evidence.method === "assumed")
    return { state: "assumed", record, reason: "Doorway assumed at the hallway edge midpoint; not observed in the source" };
  return { state: "verified", record, reason: "" };
}
export const usableDoor = (state) => state === "verified" || state === "legacy" || state === "assumed";

export function spaceAccessState(floor, space) {
  if (space.access === "nonwalkable")
    return { status: "nonwalkable", doors: [], reason: "Non-walkable region" };
  const doors = floor.geometry.doors
      .filter((d) => d.spaceIds.includes(space.id))
      .map((door) => ({ door, ...doorAccessState(floor, door) })),
    usable = doors.filter((d) => usableDoor(d.state)),
    findings = records(floor).filter(
      (r) => r.kind === "unresolved" && r.spaceId === space.id,
    ),
    // A reviewed finding outranks a later unreviewed automated one.
    unresolved =
      findings.findLast((r) => r.review.status !== "unreviewed") ||
      findings.at(-1);
  if (space.access === "unknown") {
    if (usable.some((d) => d.state === "verified" || d.state === "assumed"))
      return {
        status: "stale-unknown",
        doors,
        reason: "A verified opening exists; reconcile the access flag",
      };
    return unresolved?.status === "unresolved"
      ? {
          status: "unresolved",
          doors,
          record: unresolved,
          reason: unresolved.reason,
        }
      : {
          status: "unknown",
          doors,
          reason: doors.length
            ? "Opening has no accepted source evidence"
            : "No doorway found yet",
        };
  }
  if (!usable.length)
    return {
      status: "missing",
      doors,
      reason: doors.length
        ? "Only stale or rejected openings remain"
        : "No opening",
    };
  return {
    status: usable.some((d) => d.state === "verified") ? "verified"
      : usable.some((d) => d.state === "legacy") ? "legacy" : "assumed",
    doors,
    reason: usable.some((d) => d.state !== "assumed") ? "" : "Only an assumed doorway; confirm or move it",
  };
}
// Clears unknown only for validated evidence and flags falsely normal rooms.
export function reconcileAccessFlags(geometry, floor) {
  const view = { ...floor, geometry },
    changes = [];
  for (const s of geometry.spaces) {
    const state = spaceAccessState(view, s).status;
    if (state === "stale-unknown") {
      delete s.access;
      changes.push({ spaceId: s.id, from: "unknown", to: "known" });
    } else if (state === "missing") {
      s.access = "unknown";
      changes.push({ spaceId: s.id, from: "known", to: "unknown" });
    }
  }
  return changes;
}
// A doorway node is usable for routing only if its door is not rejected or
// detached from its recorded evidence.
export function doorNodeProblem(floor, doorId) {
  const door = floor.geometry.doors.find((d) => d.id === doorId);
  if (!door) return null;
  if (door.spaceIds.some(id => regionNeedsSemanticReview(floor, id)))
    return "Linked region needs original-source classification";
  const { state, reason } = doorAccessState(floor, door);
  return usableDoor(state) ? null : reason;
}
export function regionNeedsSemanticReview(floor, spaceId) {
  const record = records(floor).findLast(r => r.spaceId === spaceId && r.kind === "classification");
  return record?.status === "proposed" && record.review.status === "agent-inspected" && record.evidence.verifier?.verdict === "uncertain";
}
