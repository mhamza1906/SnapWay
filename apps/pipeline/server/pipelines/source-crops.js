import sharp from "sharp";
import { VISION_MAX_EDGE } from "./vision-frame.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import {
  applyTransform,
  invertTransform,
} from "../../shared/building/preparation.js";

const decode = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64");
const documents = new Map(),
  mappings = new Map();
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[
        c
      ],
  );

function pdfDocument(asset) {
  if (!documents.has(asset.hash))
    documents.set(
      asset.hash,
      getDocument({
        data: new Uint8Array(decode(asset.dataUrl)),
        isEvalSupported: false,
        useSystemFonts: true,
      }).promise,
    );
  return documents.get(asset.hash);
}

async function renderPage(page, scale, rotation, rect) {
  const viewport = page.getViewport({ scale, rotation }),
    width = Math.max(1, Math.round(rect?.width ?? viewport.width)),
    height = Math.max(1, Math.round(rect?.height ?? viewport.height)),
    canvas = createCanvas(width, height),
    context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  await page.render({
    canvasContext: context,
    canvas,
    viewport,
    transform: rect ? [1, 0, 0, 1, -rect.x, -rect.y] : undefined,
  }).promise;
  return canvas.toBuffer("image/png");
}

// The normalized source image is a derivative of the original PDF page. Find
// the page rotation and scale that reproduce it, so detail crops can be
// re-rendered from the original vector page in the same image frame.
export async function pdfSourceMapping(building, source) {
  const original = building.assets[source.originalAssetId],
    normalized = building.assets[source.assetId];
  if (original?.mime !== "application/pdf" || !source.page || !normalized)
    return null;
  const key = `${original.hash}:${source.page}:${normalized.hash}`;
  if (mappings.has(key)) return mappings.get(key);
  const promise = (async () => {
    // Thin plan lines render darker at tiny scales, so compare a half-scale
    // render after both images are reduced identically.
    const page = await (await pdfDocument(original)).getPage(source.page),
      width = Math.min(400, source.width),
      height = Math.max(1, Math.round((width * source.height) / source.width)),
      target = await sharp(decode(normalized.dataUrl))
        .resize(width, height, { fit: "fill" })
        .greyscale()
        .raw()
        .toBuffer();
    let best = null;
    for (const rotation of [0, 90, 180, 270]) {
      const unit = page.getViewport({ scale: 1, rotation });
      if (
        Math.abs(unit.width / unit.height - source.width / source.height) >
        0.01 * (source.width / source.height)
      )
        continue;
      const thumb = await sharp(
          await renderPage(page, source.width / 2 / unit.width, rotation),
        )
          .resize(width, height, { fit: "fill" })
          .greyscale()
          .raw()
          .toBuffer(),
        score =
          thumb.reduce((n, v, i) => n + Math.abs(v - target[i]), 0) /
          thumb.length;
      if (!best || score < best.score)
        best = {
          page: source.page,
          rotation,
          scale: source.width / unit.width,
          score: Math.round(score * 100) / 100,
        };
    }
    return best && best.score < 12 ? best : null;
  })();
  mappings.set(key, promise);
  return promise;
}

export function cropSource(floor, rect, sourceId = null) {
  const visible = floor.sources.filter((s) => s.visible),
    centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  return (
    floor.sources.find((s) => s.id === sourceId) ||
    visible.find((s) => {
      const p = invertTransform(centre, s.transform);
      return p.x >= 0 && p.y >= 0 && p.x <= s.width && p.y <= s.height;
    }) ||
    visible[0] ||
    floor.sources[0]
  );
}

// Returns an authoritative source crop for a floor-space rectangle. The crop
// stays in the source image frame; metadata records the inverse alignment so
// overlays and evidence can be mapped back to floor coordinates.
export async function renderSourceCrop(
  building,
  floorId,
  {
    rect,
    zoom = 4,
    sourceId = null,
    overlay = null,
    maxPixels = 2_400_000,
    vector = true,
  },
) {
  const floor = building.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error("Unknown floor.");
  const source = cropSource(floor, rect, sourceId);
  if (!source) throw new Error("This floor has no source plan.");
  const normalized = building.assets[source.assetId];
  if (!normalized) throw new Error("Source image asset is missing.");
  const corners = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height },
      { x: rect.x, y: rect.y + rect.height },
    ].map((p) => invertTransform(p, source.transform)),
    left = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x)))),
    top = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y)))),
    right = Math.min(source.width, Math.ceil(Math.max(...corners.map((p) => p.x)))),
    bottom = Math.min(
      source.height,
      Math.ceil(Math.max(...corners.map((p) => p.y))),
    );
  if (right - left < 1 || bottom - top < 1)
    throw new Error("Crop lies outside the source image.");
  const sourceRect = {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    },
    k = Math.max(
      0.25,
      Math.min(
        zoom,
        Math.sqrt(maxPixels / (sourceRect.width * sourceRect.height)),
        // Stay inside the vision model's native frame so crop pixels and grid labels remain exact.
        VISION_MAX_EDGE / Math.max(sourceRect.width, sourceRect.height),
      ),
    ),
    width = Math.round(sourceRect.width * k),
    height = Math.round(sourceRect.height * k);
  const mapping = vector ? await pdfSourceMapping(building, source) : null;
  let image;
  if (mapping) {
    const page = await (
      await pdfDocument(building.assets[source.originalAssetId])
    ).getPage(mapping.page);
    image = await renderPage(page, mapping.scale * k, mapping.rotation, {
      x: sourceRect.x * k,
      y: sourceRect.y * k,
      width,
      height,
    });
  } else
    image = await sharp(decode(normalized.dataUrl))
      .extract({
        left: sourceRect.x,
        top: sourceRect.y,
        width: sourceRect.width,
        height: sourceRect.height,
      })
      .resize(width, height, { fit: "fill", kernel: "lanczos3" })
      .png()
      .toBuffer();
  const toCrop = (p) => {
    const s = invertTransform(p, source.transform);
    return { x: (s.x - sourceRect.x) * k, y: (s.y - sourceRect.y) * k };
  };
  if (overlay) {
    const stroke = Math.max(1.5, k * 0.45),
      font = Math.max(11, Math.min(22, k * 3));
    // Optional floor-coordinate grid so a reader can quote floor pixels.
    const grid = [];
    if (overlay.grid) {
      const step = overlay.grid,
        r = rect,
        tick = Math.max(9, Math.min(14, k * 2.2));
      for (let x = Math.ceil(r.x / step) * step; x <= r.x + r.width; x += step) {
        const a = toCrop({ x, y: r.y }),
          z = toCrop({ x, y: r.y + r.height });
        grid.push(
          `<line x1="${a.x}" y1="${a.y}" x2="${z.x}" y2="${z.y}" stroke="#1976d2" stroke-opacity=".35" stroke-width="1"/><text x="${a.x + 2}" y="${tick + 1}" font-family="Arial" font-size="${tick}" fill="#0d47a1" stroke="white" stroke-width="3" paint-order="stroke">x${x}</text>`,
        );
      }
      for (let y = Math.ceil(r.y / step) * step; y <= r.y + r.height; y += step) {
        const a = toCrop({ x: r.x, y }),
          z = toCrop({ x: r.x + r.width, y });
        grid.push(
          `<line x1="${a.x}" y1="${a.y}" x2="${z.x}" y2="${z.y}" stroke="#1976d2" stroke-opacity=".35" stroke-width="1"/><text x="2" y="${a.y - 2}" font-family="Arial" font-size="${tick}" fill="#0d47a1" stroke="white" stroke-width="3" paint-order="stroke">y${y}</text>`,
        );
      }
    }
    const parts = [
      ...grid,
      ...(overlay.polygons || []).map((g) => {
        const ps = g.points.map(toCrop);
        return `<polygon points="${ps.map((p) => `${p.x},${p.y}`).join(" ")}" fill="${g.fill || "none"}" fill-opacity="${g.fillOpacity ?? 0.12}" stroke="${g.stroke || "#d13c1f"}" stroke-width="${stroke}" stroke-dasharray="${g.dashed ? `${stroke * 3} ${stroke * 2}` : "none"}"/>`;
      }),
      ...(overlay.segments || []).map((g) => {
        const a = toCrop(g.a),
          z = toCrop(g.b);
        return `<line x1="${a.x}" y1="${a.y}" x2="${z.x}" y2="${z.y}" stroke="${g.stroke || "#1565d8"}" stroke-width="${stroke * 2.2}" stroke-linecap="round" opacity=".85"/>`;
      }),
      ...(overlay.labels || []).map((g) => {
        const p = toCrop(g.position);
        return `<text x="${p.x}" y="${p.y}" font-family="Arial, sans-serif" font-size="${font}" font-weight="700" fill="${g.color || "#d13c1f"}" stroke="white" stroke-width="3" paint-order="stroke" text-anchor="middle">${esc(g.text)}</text>`;
      }),
    ];
    image = await sharp(image)
      .composite([
        {
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`,
          ),
        },
      ])
      .png()
      .toBuffer();
  }
  return {
    png: image,
    dataUrl: "data:image/png;base64," + image.toString("base64"),
    metadata: {
      floorId,
      sourceId: source.id,
      sourceHash: source.hash,
      assetHash: normalized.hash,
      originalAssetHash: building.assets[source.originalAssetId]?.hash || null,
      renderer: mapping ? "pdf-vector" : "normalized-raster",
      page: mapping?.page ?? source.page ?? null,
      rotation: mapping?.rotation ?? 0,
      pdfScale: mapping ? mapping.scale * k : null,
      pdfMatchScore: mapping?.score ?? null,
      floorRect: rect,
      sourceRect,
      pixelsPerSourcePixel: Math.round(k * 1000) / 1000,
      transform: source.transform,
      width,
      height,
      floorToCrop: "crop = (inverse(source.transform)·floor − sourceRect.xy) × pixelsPerSourcePixel",
    },
    toCrop,
    toFloor: (p) =>
      applyTransform(
        { x: p.x / k + sourceRect.x, y: p.y / k + sourceRect.y },
        source.transform,
      ),
  };
}
