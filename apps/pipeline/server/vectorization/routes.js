import { Router } from "express";
import multer from "multer";
import { performance } from "node:perf_hooks";
import { DISCLOSURE, MOCK_FLOOR, MAX_BYTES, openAssetStore, validateFloorId, VectorizationError } from "./assets.js";
import { assertLiveConfigured, vectorizeImage } from "./provider.js";

// Store is lazy: existing pipeline endpoints need no demo DB or fixture.
export function vectorizationRouter({ store, env = process.env, fetchImpl } = {}) {
  const router = Router();
  const assets = () => store ??= openAssetStore();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 1, fieldSize: 128 } });
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/status", (req, res) => {
    const floors = assets().list();
    res.json({ liveEnabled: env.VECTORIZER_LIVE_ENABLED === "true",
      credentialsConfigured: Boolean(env.VECTORIZER_API_ID?.trim() && env.VECTORIZER_API_SECRET?.trim()),
      mockFloorId: MOCK_FLOOR, mockStatus: floors.some(f => f.floorId === MOCK_FLOOR) ? "asset-ready" : "pending-asset",
      disclosure: DISCLOSURE, floors });
  });
  router.post("/mock", (req, res) => {
    const started = performance.now();
    if (req.body?.floorId !== MOCK_FLOOR)
      throw new VectorizationError(422, "MOCK_FLOOR_UNSUPPORTED", "The demo mock supports only ia-4. IA-1 belongs to the separate prebuilt demo route.");
    const asset = assets().get(MOCK_FLOOR);
    if (!asset) throw new VectorizationError(503, "DEMO_ASSET_PENDING", "IA-4 SVG has not been imported. No placeholder or IA-1 substitution is returned.");
    if (req.body.sourceSha256 !== undefined && req.body.sourceSha256 !== asset.sourceSha256)
      throw new VectorizationError(409, "SOURCE_MISMATCH", "The submitted source hash does not match the prebuilt IA-4 source.");
    res.json({ ...asset, provider: "prebuilt-figma", mock: true, disclosure: DISCLOSURE,
      metrics: { elapsedMs: Math.round(performance.now() - started), upstreamRequests: 0, creditsCharged: 0, usd: 0 } });
  });
  router.get("/prebuilt/:floorId", (req, res) => {
    const asset = assets().get(validateFloorId(req.params.floorId));
    if (!asset) throw new VectorizationError(404, "ASSET_NOT_FOUND", "No prebuilt SVG exists for this floor.");
    res.json({ ...asset, provider: "prebuilt-figma", prebuilt: true,
      disclosure: "Manually exported Figma presentation asset; navigation acceptance is pending." });
  });
  router.post("/live", (req, res, next) => {
    try { assertLiveConfigured(env); next(); } catch (error) { next(error); }
  }, upload.single("image"), async (req, res) => {
    const floorId = validateFloorId(req.body?.floorId);
    const result = await vectorizeImage(req.file?.buffer, { env, fetchImpl });
    res.json({ floorId, ...result });
  });
  router.use((error, req, res, next) => {
    if (error instanceof VectorizationError)
      return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error instanceof multer.MulterError)
      return res.status(400).json({ error: { code: "INVALID_UPLOAD", message: "Upload one image (up to 15 MB) and one floorId field." } });
    res.status(500).json({ error: { code: "VECTORIZATION_INTERNAL_ERROR", message: "Vectorization failed; no automatic fallback was performed." } });
  });
  return router;
}
