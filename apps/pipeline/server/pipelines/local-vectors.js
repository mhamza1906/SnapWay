import { getDocument, OPS, Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfSourceMapping } from "./source-crops.js";
import { distance } from "../../shared/map.js";

export const VECTOR_VERSION = "pdfjs6-lines-v1";
const point = (x, y, t) => { const p = [x, y]; Util.applyTransform(p, t); return { x: p[0], y: p[1] }; };
// PDF.js 6 DrawOPS. Curves are counted, never converted into wall segments:
// glyph outlines and door arcs must not silently become structural walls.
export function vectorLines(operators, viewportTransform) {
  let transform = viewportTransform, cursor = null, start = null, curves = 0, paths = 0;
  const stack = [], segments = [];
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i], args = operators.argsArray[i];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push(transform);
      if (op === OPS.paintFormXObjectBegin && args[0]) transform = Util.transform(transform, args[0]);
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) transform = stack.pop() || viewportTransform;
    else if (op === OPS.transform) transform = Util.transform(transform, args);
    else if (op === OPS.constructPath) {
      paths++;
      const data = args[1]?.[0];
      if (!data || typeof data.length !== "number") continue;
      cursor = start = null;
      const line = (end) => {
        if (cursor && distance(cursor, end) >= 3) segments.push({ a: cursor, b: end });
        cursor = end;
      };
      for (let k = 0; k < data.length;) {
        const cmd = data[k++];
        if (cmd === 0) cursor = start = point(data[k++], data[k++], transform);
        else if (cmd === 1) line(point(data[k++], data[k++], transform));
        else if (cmd === 2 || cmd === 3) {
          curves++; k += cmd === 2 ? 4 : 2;
          cursor = point(data[k++], data[k++], transform);
        } else if (cmd === 4) { if (start) line(start); }
        else break; // Unsupported representation: fail closed, never guess.
      }
    }
  }
  const unique = new Map();
  for (const s of segments) {
    const key = [s.a, s.b].map(p => `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`).sort().join(";");
    unique.set(key, s);
  }
  return { paths, curves, segments: [...unique.values()] };
}
export async function extractLocalVectors(building, source) {
  const started = Date.now(), asset = building.assets[source.originalAssetId];
  const mapping = await pdfSourceMapping(building, source);
  if (!mapping || asset?.mime !== "application/pdf") return {
    version: VECTOR_VERSION, renderer: "normalized-raster", segments: [], labels: [], paths: 0,
    elapsedMs: Date.now() - started, notes: ["Raster source: semantics require vision; no vector walls assumed."],
  };
  const task = getDocument({ data: new Uint8Array(Buffer.from(asset.dataUrl.split(",")[1], "base64")), isEvalSupported: false });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(source.page), viewport = page.getViewport(mapping);
    const [ops, text] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
    const geometry = vectorLines(ops, viewport.transform);
    const labels = text.items.filter(x => x.str?.trim()).map(x => ({
      text: x.str, position: point(x.transform[4], x.transform[5], viewport.transform),
    }));
    return { version: VECTOR_VERSION, renderer: "pdf-vector", ...geometry, labels,
      mapping, elapsedMs: Date.now() - started,
      notes: ["Linework is evidence for alignment, not proof of a wall or doorway.",
        ...(!labels.length ? ["Labels are vector outlines; vision is needed to read them."] : [])] };
  } finally { await task.destroy(); }
}
export function tileVectorHints(vectors, crop, scale = 1, limit = 180) {
  return vectors.segments.filter(s => [s.a, s.b].every(p =>
    p.x >= crop.x && p.x <= crop.x + crop.width && p.y >= crop.y && p.y <= crop.y + crop.height))
    .sort((a, b) => distance(b.a, b.b) - distance(a.a, a.b)).slice(0, limit)
    .map(s => Object.fromEntries(Object.entries(s).map(([k, p]) => [k, {
      x: Math.round((p.x - crop.x) * scale * 10) / 10,
      y: Math.round((p.y - crop.y) * scale * 10) / 10,
    }])));
}
