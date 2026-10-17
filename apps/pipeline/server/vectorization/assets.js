import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

export const MOCK_FLOOR = "ia-4";
export const DISCLOSURE = "存在自动化的可商业化的 API 服务，但我们没付款，此次只做效果演示。当前结果为手工通过 Figma 预构建的 IA 四楼矢量图，并非现场 API 生成。";
export const MAX_BYTES = 15 * 1024 * 1024;
export const defaultDatabase = fileURLToPath(new URL("../../.local/vectorization/assets.sqlite", import.meta.url));
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export class VectorizationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function validateFloorId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
    throw new VectorizationError(400, "INVALID_FLOOR", "Supply a lowercase floorId, e.g. ia-4.");
  return value;
}

export async function inspectRaster(bytes) {
  try {
    if (!bytes?.length || bytes.length > MAX_BYTES) throw new Error();
    const meta = await sharp(bytes, { limitInputPixels: 33_554_432 }).metadata();
    if (!["png", "jpeg"].includes(meta.format) || (meta.pages ?? 1) !== 1) throw new Error();
    return { width: meta.width, height: meta.height, mime: `image/${meta.format}` };
  } catch {
    throw new VectorizationError(400, "INVALID_IMAGE", "Supply one PNG or JPEG image, at most 15 MB and 33,554,432 pixels.");
  }
}

// A static tracing asset boundary, not a general-purpose HTML/SVG sanitizer.
// Consumers must display SVG as an image, never insert untrusted markup as HTML.
export async function inspectSvg(bytes) {
  try {
    if (!bytes?.length || bytes.length > MAX_BYTES) throw new Error();
    const svg = Buffer.from(bytes).toString("utf8");
    if (!/<svg[\s>]/i.test(svg) || /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<(?:[\w-]+:)?(?:script|foreignObject|image|iframe|object|embed|animate\w*|set|style)\b|\s(?:[\w-]+:)?href\s*=|\son[\w-]+\s*=|url\s*\(/i.test(svg)) throw new Error();
    const meta = await sharp(bytes, { limitInputPixels: 33_554_432 }).metadata();
    if (meta.format !== "svg" || !meta.width || !meta.height) throw new Error();
    return { width: meta.width, height: meta.height };
  } catch {
    throw new VectorizationError(422, "INVALID_SVG", "Expected a static, self-contained SVG trace (no scripts, images or external references).");
  }
}

export function openAssetStore(path = defaultDatabase) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS prebuilt_floors (
    floor_id TEXT PRIMARY KEY, label TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    svg_sha256 TEXT NOT NULL, svg BLOB NOT NULL, width INTEGER NOT NULL,
    height INTEGER NOT NULL, imported_at TEXT NOT NULL, provenance TEXT NOT NULL
  )`);
  const metadata = (row) => row && ({
    floorId: row.floor_id, label: row.label, sourceSha256: row.source_sha256,
    sha256: row.svg_sha256, width: row.width, height: row.height,
    importedAt: row.imported_at, provenance: JSON.parse(row.provenance),
    navigationReady: false,
  });
  return {
    close: () => db.close(),
    list: () => db.prepare("SELECT floor_id,label,source_sha256,svg_sha256,width,height,imported_at,provenance FROM prebuilt_floors ORDER BY floor_id").all().map(metadata),
    get(floorId) {
      const row = db.prepare("SELECT * FROM prebuilt_floors WHERE floor_id = ?").get(floorId);
      if (!row) return null;
      const bytes = Buffer.from(row.svg);
      if (sha256(bytes) !== row.svg_sha256)
        throw new VectorizationError(500, "ASSET_INTEGRITY_ERROR", "Stored SVG hash does not match its recorded hash.");
      return { ...metadata(row), svg: bytes.toString("utf8") };
    },
    async importFigma({ floorId, label, source, svg, replace = false }) {
      validateFloorId(floorId);
      if (typeof label !== "string" || !label.trim() || label.length > 100)
        throw new VectorizationError(400, "INVALID_LABEL", "Supply a floor label (1–100 characters).");
      await inspectRaster(source);
      const dimensions = await inspectSvg(svg);
      const sourceHash = sha256(source), svgHash = sha256(svg);
      const old = this.get(floorId);
      if (old && old.sha256 === svgHash && old.sourceSha256 === sourceHash && old.label === label) return old;
      if (old && !replace)
        throw new VectorizationError(409, "ASSET_EXISTS", "Floor already exists; inspect it before importing with --replace.");
      db.prepare(`INSERT OR REPLACE INTO prebuilt_floors VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(floorId, label, sourceHash, svgHash, svg, dimensions.width, dimensions.height,
          new Date().toISOString(), JSON.stringify({ method: "manual-figma-export", floorIdentity: "operator-declared", semanticReview: "pending", routeReview: "pending" }));
      return this.get(floorId);
    },
  };
}
