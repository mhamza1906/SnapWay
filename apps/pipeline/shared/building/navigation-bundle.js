// A navigation bundle is an ordinary version-2 building with editor-only
// payloads removed: geometry revision history, snapshots, coverage
// inventories and source PDF/plan assets. Geometry (including each floor's
// normalized plan image), access evidence, nodes, edges, connectors, routing
// settings and reference photos with their image assets are unchanged, so the
// shared routing code returns identical routes and the bundle still parses
// with BuildingSchema.
export const NAVIGATION_BUNDLE_VERSION = "nav-bundle-v1-2026-10-16";

export function navigationBundle(building) {
  const photoAssets = new Set(building.photos.map((p) => p.assetId));
  return {
    ...building,
    assets: Object.fromEntries(
      Object.entries(building.assets).filter(([id]) => photoAssets.has(id)),
    ),
    floors: building.floors.map((f) => ({
      ...f,
      history: [],
      snapshots: [],
      sources: f.sources.map((s) => ({ ...s, coverage: null })),
    })),
  };
}

export function buildingSummary(building) {
  return {
    id: building.id,
    name: building.name,
    provenance: building.provenance,
    updatedAt: building.updatedAt,
    floors: [...building.floors]
      .sort((a, b) => a.level - b.level)
      .map((f) => ({ id: f.id, label: f.label, level: f.level })),
    photos: building.photos.filter((p) => p.status === "reviewed").length,
    testPhotos: building.photos.filter((p) => p.kind === "test").length,
  };
}
