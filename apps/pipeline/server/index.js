import "./env.js";
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { MapSchema, Point } from "../shared/map.js";
import { createProvider } from "./provider.js";
import { cachedExtraction } from "./pipelines/extraction.js";
import { preparePlan } from "./pipelines/preparation.js";
import { BuildingSchema, FloorSchema } from "../shared/building/schema.js";
import { renderSourceCrop } from "./pipelines/source-crops.js";
import { runAccessJob } from "./pipelines/doorways.js";
import { validateBuilding } from "../shared/building/validation.js";
import { runCoveragePipeline } from "./pipelines/coverage.js";
import { renderDesign, suggestDesign } from "./pipelines/design.js";
import { PresentationSchema } from "../shared/building/design.js";
import { z } from "zod";
import { startMapJob, getMapJob, resumeMapJob, cancelMapJob, applyMapJob } from "./map-jobs.js";
import { libraryEntries, libraryEntry, saveCopy } from "./building-library.js";
import { authoringRouter } from "./authoring-routes.js";
const coverageJobs = new Map(),
  accessJobs = new Map();
const app = express(),
  port = Number(process.env.PORT) || 5175;
// Browser requests are accepted only from this service and the SnapWay Angular
// dev server (which proxies /pipeline/** here). Add others explicitly.
const allowedOrigins = new Set([
  "http://localhost:" + port, "http://127.0.0.1:" + port,
  ...(process.env.PIPELINE_ALLOWED_ORIGINS ?? "http://localhost:4200,http://127.0.0.1:4200").split(",").map((o) => o.trim()).filter(Boolean),
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin))
    return res
      .status(403)
      .json({ error: "Only local app requests are accepted." });
  next();
});
app.use(express.json({ limit: "150mb" }));
// SnapWay Angular authoring screens (see docs/pipeline/api.md).
app.use("/api/authoring", authoringRouter());
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});
app.get("/api/health", (_, res) => {
  const provider = createProvider();
  res.json({
    ok: true,
    environment: process.env.APP_ENV,
    provider: provider.name,
    configured: provider.configured,
    model: provider.model,
    ...(provider.effort ? { effort: provider.effort } : {}),
  });
});
app.post("/api/normalize", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file || !["image/png", "image/jpeg"].includes(req.file.mimetype))
      return res
        .status(400)
        .json({ error: "Upload a PNG or JPEG (up to 15 MB)." });
    const input = sharp(req.file.buffer, { limitInputPixels: 40_000_000 });
    const meta = await input.metadata();
    if (!["png", "jpeg"].includes(meta.format))
      throw new Error("The file must contain a real PNG or JPEG image.");
    const { data, info } = await input
      .rotate()
      .resize({
        width: 2400,
        height: 2400,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    res.json({
      name: req.file.originalname,
      width: info.width,
      height: info.height,
      originalWidth: meta.width,
      originalHeight: meta.height,
      dataUrl: "data:image/png;base64," + data.toString("base64"),
      normalized: true,
      provenance:
        "User upload; EXIF orientation applied; resized to at most 2400 px.",
      fictional: false,
    });
  } catch (e) {
    next(e);
  }
});
app.post("/api/extract", async (req, res, next) => {
  try {
    const source = MapSchema.shape.source.parse(req.body.source);
    if (!source.dataUrl.startsWith("data:image/png;"))
      throw new Error("Normalize the image before extraction.");
    const { map } = await cachedExtraction(source);
    await mkdir(".local/extractions", { recursive: true });
    await writeFile(
      `.local/extractions/${map.id}.json`,
      JSON.stringify(map, null, 2),
    );
    res.json(map);
  } catch (e) {
    next(e);
  }
});
app.put("/api/project", async (req, res, next) => {
  try {
    const map = MapSchema.parse(req.body);
    await mkdir(".local", { recursive: true });
    await writeFile(".local/project.tmp", JSON.stringify(map, null, 2));
    const { rename } = await import("node:fs/promises");
    await rename(".local/project.tmp", ".local/project.json");
    res.json({ saved: true });
  } catch (e) {
    next(e);
  }
});
app.get("/api/project", async (_, res, next) => {
  try {
    res.json(
      MapSchema.parse(
        JSON.parse(await readFile(".local/project.json", "utf8")),
      ),
    );
  } catch (e) {
    if (e.code === "ENOENT")
      return res
        .status(404)
        .json({ error: "No saved project yet. Save a map first." });
    next(e);
  }
});
app.post("/api/plans", upload.single("image"), async (req, res, next) => {
  try {
    if (!req.file) throw new Error("Choose a plan file.");
    res.json(
      await preparePlan(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      ),
    );
  } catch (e) {
    next(e);
  }
});
app.post("/api/extraction", async (req, res, next) => {
  try {
    res.json(
      await cachedExtraction(MapSchema.shape.source.parse(req.body.source)),
    );
  } catch (e) {
    next(e);
  }
});
app.post("/api/map-jobs", async (req, res, next) => {
  try { res.status(202).json(await startMapJob(BuildingSchema.parse(req.body.building), req.body.options)); }
  catch (e) { next(e); }
});
app.get("/api/map-jobs/:id", async (req, res, next) => {
  try { res.json(await getMapJob(req.params.id)); }
  catch (e) { if (e.code === "ENOENT") return res.status(404).json({ error: "Mapping job not found." }); next(e); }
});
const missingJob = (e, res) => e.code === "ENOENT" && res.status(404).json({ error: "Mapping job not found." });
app.post("/api/map-jobs/:id/resume", async (req, res, next) => {
  try { res.status(202).json(await resumeMapJob(req.params.id, req.body?.options || {})); }
  catch (e) { missingJob(e, res) || next(e); }
});
app.post("/api/map-jobs/:id/cancel", async (req, res, next) => {
  try { res.json(await cancelMapJob(req.params.id)); } catch (e) { missingJob(e, res) || next(e); }
});
app.post("/api/map-jobs/:id/apply", async (req, res, next) => {
  try { res.json(await applyMapJob(req.params.id, BuildingSchema.parse(req.body.building))); } catch (e) { missingJob(e, res) || next(e); }
});
app.post("/api/coverage", async (req, res, next) => {
  try {
    const source = MapSchema.shape.source.parse(req.body.source),
      baseMap = req.body.baseMap ? MapSchema.parse(req.body.baseMap) : null;
    const id = crypto.randomUUID(),
      state = {
        id,
        status: "running",
        progress: {
          stage: "queued",
          completed: 0,
          total: 0,
          message: "Coverage scan queued",
        },
      };
    coverageJobs.set(id, state);
    res.status(202).json({ id });
    runCoveragePipeline(source, {
      baseMap,
      progress: (p) => (state.progress = p),
    })
      .then((result) => {
        state.status = "complete";
        state.result = result;
      })
      .catch((e) => {
        state.status = "failed";
        state.error = e.message;
      });
  } catch (e) {
    next(e);
  }
});
app.get("/api/coverage/:id", (req, res) => {
  const job = coverageJobs.get(req.params.id);
  if (!job)
    return res.status(404).json({
      error:
        "Coverage job is unavailable. Re-run the scan; completed tiles reuse their cache.",
    });
  res.json(job);
});
app.put("/api/building", async (req, res, next) => {
  try {
    const b = BuildingSchema.parse(req.body);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await mkdir("output/backups", { recursive: true });
    for (const [file, label] of [[".local/building.json", "building"]]) {
      try { await copyFile(file, `output/backups/${label}-before-save-${stamp}.json`); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    await mkdir(".local", { recursive: true });
    await writeFile(".local/building.tmp", JSON.stringify(b));
    const { rename } = await import("node:fs/promises");
    await rename(".local/building.tmp", ".local/building.json");
    await writeFile(
      ".local/building-validation.json",
      JSON.stringify(
        {
          buildingId: b.id,
          at: new Date().toISOString(),
          issues: validateBuilding(b),
        },
        null,
        2,
      ),
    );
    res.json({ saved: true });
  } catch (e) {
    next(e);
  }
});
app.get("/api/building", async (req, res, next) => {
  try {
    res.json(
      BuildingSchema.parse(
        JSON.parse(await readFile(".local/building.json", "utf8")),
      ),
    );
  } catch (e) {
    if (e.code === "ENOENT")
      return res.status(404).json({ error: "No building saved yet." });
    next(e);
  }
});
// Every building on this machine: published, saved project, saved copies and
// pipeline exports. Opening one loads it into the editor without saving.
app.get("/api/buildings", async (_, res, next) => {
  try {
    res.json({ buildings: (await libraryEntries()).map((e) => e.summary) });
  } catch (e) {
    next(e);
  }
});
app.get("/api/buildings/:key", async (req, res, next) => {
  try {
    const entry = await libraryEntry(req.params.key);
    if (!entry) return res.status(404).json({ error: "Unknown building." });
    res.json(entry.building);
  } catch (e) {
    next(e);
  }
});
app.post("/api/buildings/copies", async (req, res, next) => {
  try {
    res.json(await saveCopy(req.body));
  } catch (e) {
    if (e.name === "ZodError") return res.status(400).json({ error: "That building does not pass the schema; fix validation errors first." });
    next(e);
  }
});
app.post("/api/design/render", async (req, res, next) => {
  try {
    const b = BuildingSchema.parse(req.body.building),
      floorId = z.string().parse(req.body.floorId),
      style = PresentationSchema.parse(
        req.body.presentation ||
          b.floors.find((f) => f.id === floorId)?.presentation,
      );
    res.json(await renderDesign(b, floorId, style));
  } catch (e) {
    next(e);
  }
});
app.post("/api/design/suggest", async (req, res, next) => {
  try {
    const b = BuildingSchema.parse(req.body.building),
      floorId = z.string().parse(req.body.floorId),
      prompt = z.string().trim().min(3).max(2000).parse(req.body.prompt);
    res.json(await suggestDesign(b, floorId, prompt));
  } catch (e) {
    next(e);
  }
});
// Source crops for access evidence: the client sends one floor and its assets.
app.post("/api/access/crop", async (req, res, next) => {
  try {
    const floor = FloorSchema.parse(req.body.floor),
      assets = BuildingSchema.shape.assets.parse(req.body.assets),
      scale = z.enum(["detail", "context"]).parse(req.body.scale || "detail"),
      space = req.body.spaceId
        ? floor.geometry.spaces.find((s) => s.id === req.body.spaceId)
        : null;
    if (req.body.spaceId && !space) throw new Error("Unknown region.");
    const segments = z
      .array(z.object({ a: Point, b: Point }))
      .max(12)
      .parse(req.body.segments || []);
    const pts = [...(space?.polygon || []), ...segments.flatMap((s) => [s.a, s.b])];
    if (!pts.length) throw new Error("Choose a region or opening to inspect.");
    const xs = pts.map((p) => p.x),
      ys = pts.map((p) => p.y),
      pad = scale === "detail" ? 14 : 60;
    const crop = await renderSourceCrop({ floors: [floor], assets }, floor.id, {
      rect: {
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        width: Math.max(...xs) - Math.min(...xs) + pad * 2,
        height: Math.max(...ys) - Math.min(...ys) + pad * 2,
      },
      zoom: scale === "detail" ? 8 : 3.5,
      maxPixels: 1_600_000,
      overlay: {
        polygons: space
          ? [{ points: space.polygon, stroke: "#d13c1f", fillOpacity: 0, dashed: true }]
          : [],
        segments: segments.map((s) => ({ ...s, stroke: "#c2185b" })),
      },
    });
    res.json({ dataUrl: crop.dataUrl, metadata: crop.metadata });
  } catch (e) {
    next(e);
  }
});
app.post("/api/access/investigate", async (req, res, next) => {
  try {
    const building = BuildingSchema.parse(req.body.building),
      floorId = z.string().parse(req.body.floorId),
      spaceIds = z.array(z.string()).min(1).max(40).parse(req.body.spaceIds),
      floor = building.floors.find((f) => f.id === floorId);
    if (!floor) throw new Error("Unknown floor.");
    for (const id of spaceIds)
      if (!floor.geometry.spaces.some((s) => s.id === id))
        throw new Error(`Unknown region ${id}.`);
    const provider = createProvider();
    if (!provider.configured)
      throw new Error("Configure the server image provider before investigating doorways.");
    const id = crypto.randomUUID(),
      controller = new AbortController(),
      state = {
        id,
        status: "running",
        provider: provider.name,
        model: provider.model,
        progress: { completed: 0, total: spaceIds.length, message: "Queued" },
      };
    accessJobs.set(id, { state, controller });
    res.status(202).json({ id });
    runAccessJob(building, floorId, spaceIds, {
      provider,
      signal: controller.signal,
      progress: (p) =>
        (state.progress = {
          completed: p.completed,
          total: p.total,
          message: p.message,
        }),
    })
      .then((result) => {
        state.status = controller.signal.aborted ? "cancelled" : "complete";
        state.result = result;
      })
      .catch((e) => {
        state.status = controller.signal.aborted ? "cancelled" : "failed";
        state.error = e.message;
      });
  } catch (e) {
    next(e);
  }
});
app.get("/api/access/:id", (req, res) => {
  const job = accessJobs.get(req.params.id);
  if (!job)
    return res.status(404).json({
      error: "Doorway job is unavailable. Re-run it; completed regions reuse their cache.",
    });
  res.json(job.state);
});
app.post("/api/access/:id/cancel", (req, res) => {
  const job = accessJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown doorway job." });
  job.controller.abort();
  res.json({ cancelled: true });
});
app.use("/api", (_, res) =>
  res.status(404).json({ error: "Unknown API route" }),
);
app.use((err, req, res, next) => {
  res.status(400).json({
    error:
      err.name === "ZodError"
        ? "Invalid project schema: " +
          err.issues
            .slice(0, 3)
            .map((i) => i.path.join(".") + " " + i.message)
            .join("; ")
        : err.message === "File too large"
          ? "Image exceeds 15 MB."
          : err.message || "Request failed",
  });
});
// Fail at startup, not on the first request, if the provider settings are invalid
// (for example prod without AI_PROVIDER=vertex). No provider call is made here.
try {
  createProvider();
} catch (e) {
  console.error(`Pipeline provider settings are invalid for APP_ENV=${process.env.APP_ENV}: ${e.message}`);
  process.exit(1);
}
app.listen(port, "127.0.0.1", () =>
  console.log(`SnapWay map-authoring pipeline (${process.env.APP_ENV}): http://127.0.0.1:${port}`),
);
