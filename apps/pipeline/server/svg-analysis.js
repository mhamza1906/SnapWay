// Close reading of a vectorized floor plan (vectorizer.ai SVG) by Claude.
// Each shape gets an ID (p1, p2, …) so findings can cite exact shapes. Claude
// receives a compact copy of the SVG (every shape kept, coordinates rounded to
// the pixel, tiny corner arcs as straight lines, so nothing visible changes)
// plus the SVG rendered as an image, and returns a structured analysis.
// Development only (Claude via ANTHROPIC_API_KEY in .env.dev); no fallback.
import sharp from "sharp";
import { VISION_MAX_EDGE, VISION_MAX_PIXELS } from "./pipelines/vision-frame.js";

const ARGS = { M: 2, L: 2, A: 7, Q: 4, C: 6, Z: 0, H: 1, V: 1, S: 4, T: 2 };
const r = (v) => Math.round(Number(v));

// Rounds a path's coordinates; arcs become lines to their end point. Absolute
// commands only (vectorizer.ai writes M, L, A, Q, C, Z).
function compactPath(d) {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) || [], out = [];
  let cmd = null, last = null;
  for (let i = 0; i < tokens.length;) {
    if (/[A-Za-z]/.test(tokens[i])) { cmd = tokens[i++].toUpperCase(); if (cmd === "Z") { out.push("Z"); last = null; continue; } }
    const n = ARGS[cmd], args = tokens.slice(i, i + n).map(Number);
    i += n;
    if (!n || args.length < n) break;
    let part;
    if (cmd === "A") part = `L${r(args[5])} ${r(args[6])}`;
    else part = cmd + args.map(r).join(" ");
    const end = part.split(/[A-Z]/)[1].split(" ").slice(-2).join(" ");
    if ((part[0] === "L") && end === last) continue; // drop zero-length steps
    out.push(part);
    last = end;
    if (cmd === "M") cmd = "L";
  }
  return out.join("");
}

/** The compact SVG with IDs, and an inventory of its shapes. */
export function compactSvg(svg) {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1].trim().split(/\s+/).map(Number) || [0, 0, 0, 0];
  const shapes = [];
  let n = 0;
  const body = svg
    .replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/g, "")
    .replace(/<path([^>]*?)\/?>/g, (_, attrs) => {
      const id = `p${++n}`, d = compactPath(/\sd="([^"]*)"/.exec(attrs)?.[1] || ""),
        fill = /fill="([^"]+)"/.exec(attrs)?.[1] || null, stroke = /stroke="([^"]+)"/.exec(attrs)?.[1] || null,
        // After compaction every number is part of an x y pair.
        nums = (d.match(/-?\d+/g) || []).map(Number), xs = nums.filter((_, k) => k % 2 === 0), ys = nums.filter((_, k) => k % 2 === 1);
      shapes.push({ id, fill, stroke, bbox: xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null });
      return `<path id="${id}"${fill ? ` fill="${fill}"` : ""}${stroke ? ` stroke="${stroke}"` : ""} d="${d}"/>`;
    })
    .replace(/<(rect|ellipse)([^>]*?)\/?>/g, (_, tag, attrs) => {
      const id = `p${++n}`;
      shapes.push({ id, tag, fill: /fill="([^"]+)"/.exec(attrs)?.[1] || null, stroke: /stroke="([^"]+)"/.exec(attrs)?.[1] || null });
      return `<${tag} id="${id}"${attrs.replace(/(-?\d+\.\d+)/g, (v) => String(r(v))).replace(/\s*\/$/, "")}/>`;
    })
    .replace(/vector-effect="[^"]*"/g, "")
    .replace(/\n\s*/g, "\n");
  return { svg: body.trim(), shapes, width: viewBox[2], height: viewBox[3] };
}

/** The SVG rendered to a PNG data URL that fits Claude's vision frame. */
export async function renderSvg(svg, width, height) {
  const scale = Math.min(VISION_MAX_EDGE / Math.max(width, height), Math.sqrt(VISION_MAX_PIXELS / (width * height)));
  const w = Math.floor(width * scale), h = Math.floor(height * scale),
    png = await sharp(Buffer.from(svg), { density: 72 * scale }).resize(w, h, { fit: "fill" }).flatten({ background: "#ffffff" }).png().toBuffer();
  return { dataUrl: `data:image/png;base64,${png.toString("base64")}`, width: w, height: h, scale };
}

// The reply's shape. It is given to Claude in the prompt and checked here
// (strict structured output rejects a schema this large as a grammar).
const nums = (description) => ({ type: "array", items: { type: "number" }, description });
const box = nums("Bounding box [x, y, width, height] in SVG units.");
const point = nums("Point [x, y] in SVG units.");
const ids = { type: "array", items: { type: "string" }, description: "Shape IDs (p1, p2, …); up to about 30, the most telling first." };
const str = (description) => ({ type: "string", description });
const list = (properties, required) => ({ type: "array", items: { type: "object", properties, required } });
export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    floorLabel: str(""),
    overview: str("What this floor is and how it is laid out, in a few sentences."),
    colourRoles: list({ colour: str(""), usage: str("stroke or fill"), role: str(""), evidence: str("") }, ["colour", "usage", "role", "evidence"]),
    outline: { type: "object", properties: { description: str(""), closed: { type: "boolean" }, bbox: box, shapeIds: ids, gaps: str("Each gap in the exterior outline: where, how wide, likely cause.") }, required: ["description", "closed", "bbox", "shapeIds", "gaps"] },
    corridors: list({ name: str(""), description: str("Where it runs and what it connects."), bbox: box, shapeIds: ids }, ["name", "description", "bbox", "shapeIds"]),
    rooms: list({
      label: str("Printed name as best it can be read, or 'unlabelled'."),
      labelConfidence: str("clear, partial, guessed or none"),
      kind: str("room, lecture-hall, stair, elevator, washroom, storage, shaft, service, void, outdoor or other"),
      bbox: box, shapeIds: ids, enclosed: { type: "boolean" }, notes: str("") }, ["label", "labelConfidence", "kind", "bbox", "shapeIds", "enclosed", "notes"]),
    doorways: list({ at: point, between: str("The two spaces it joins, by name."), evidence: str("Gap width, door swing, shape IDs.") }, ["at", "between", "evidence"]),
    walls: { type: "object", properties: { description: str(""), strokeColours: { type: "array", items: { type: "string" } }, problems: str("Each wall problem: where (x, y), what, shape IDs.") }, required: ["description", "strokeColours", "problems"] },
    noise: list({ kind: str("leader-line, fire-equipment, text-glyphs, glare-or-shadow, furniture-or-seating, outside-building, board-background or other"), description: str(""), shapeIds: ids, removal: str("How to recognise these shapes reliably (colour, size, shape).") }, ["kind", "description", "shapeIds", "removal"]),
    textLabels: list({ text: str(""), at: point, legibility: str("clear, partial or garbled") }, ["text", "at", "legibility"]),
    vectorizationIssues: list({ issue: str(""), severity: str("low, medium or high"), shapeIds: ids }, ["issue", "severity", "shapeIds"]),
    uncertainties: { type: "array", items: { type: "string" } },
    recommendations: { type: "array", items: { type: "string" } },
  },
  required: ["floorLabel", "overview", "colourRoles", "outline", "corridors", "rooms", "doorways", "walls", "noise", "textLabels", "vectorizationIssues", "uncertainties", "recommendations"],
};

export const ANALYSIS_PROMPT = (label, c, image) => [
  `You are analysing one floor of a building${label ? ` (${label})` : ""} for an indoor-navigation map. The floor plan was photographed on a wall board and converted from a raster image to SVG by vectorizer.ai.`,
  `Below is that SVG (viewBox 0 0 ${c.width} ${c.height}): every shape is kept and has an ID (p1…p${c.shapes.length}); coordinates are rounded to whole units and tiny corner arcs are written as straight lines. The attached image is the same SVG rendered at ${image.width}×${image.height} px (${image.scale.toFixed(3)} px per SVG unit). Report every coordinate in SVG units, not image pixels.`,
  "Analyse it really closely, shape by shape and region by region. Use the shape data for exact geometry and the image to read what you see. Work out:",
  "- what each stroke and fill colour means (walls, corridor fill, stairs, lifts, fire symbols, leader lines, board background, glare…);",
  "- the building's exterior outline and any gaps in it;",
  "- every corridor and circulation area, and what it connects;",
  "- every room or enclosed space, including small unlabelled ones, stairs and lifts, with its printed name read as well as possible (text became glyph shapes, so read it from the image) and whether it is fully enclosed;",
  "- every doorway (wall gaps or door swings) and the two spaces it joins;",
  "- wall problems (breaks, double lines, walls merged with other shapes);",
  "- everything that is not floor-plan geometry (leader lines, fire-equipment symbols, text glyphs, glare, seating, the board around the plan) and how to recognise it;",
  "- vectorization artefacts, what you are unsure of, and concrete recommendations.",
  "Be exhaustive and precise; never invent rooms, names or doorways you cannot see. Cite shape IDs for every feature.",
].join("\n");

/**
 * Streams one analysis from Claude. Returns { analysis, usage, model }.
 * `svg` is the vectorizer.ai SVG text.
 */
export async function analyzeSvg(svg, {
  label = "", apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL, effort = process.env.ANTHROPIC_EFFORT || "high",
  maxTokens = 64000, fetchImpl = fetch,
} = {}) {
  if (!apiKey || !model) throw new Error("SVG analysis needs ANTHROPIC_API_KEY and ANTHROPIC_MODEL (run with APP_ENV=dev).");
  const compact = compactSvg(svg), image = await renderSvg(svg, compact.width, compact.height);
  const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: maxTokens, stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort },
      messages: [{ role: "user", content: [
        { type: "text", text: ANALYSIS_PROMPT(label, compact, image) },
        { type: "image", source: { type: "base64", media_type: "image/png", data: image.dataUrl.split(",")[1] } },
        { type: "text", text: `<svg_source>\n${compact.svg}\n</svg_source>` },
        { type: "text", text: `Reply with only one JSON object (no prose, no code fence) that matches this JSON Schema:\n${JSON.stringify(ANALYSIS_SCHEMA)}` },
      ] }],
    }),
  });
  if (!response.ok) {
    // Never echo request headers; the error body carries only type and message.
    const body = await response.json().catch(() => null);
    throw new Error(`Claude analysis failed (HTTP ${response.status})${body?.error?.message ? `: ${body.error.message}` : ""}.`);
  }
  // Server-sent events: collect the text deltas of the final answer.
  const decoder = new TextDecoder();
  let buffer = "", text = "", usage = {}, stop = null, servedModel = model;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = event.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
      if (!data) continue;
      const e = JSON.parse(data);
      if (e.type === "message_start") { usage = { ...e.message.usage }; servedModel = e.message.model; }
      else if (e.type === "content_block_delta" && e.delta.type === "text_delta") text += e.delta.text;
      else if (e.type === "message_delta") { usage = { ...usage, ...e.usage }; stop = e.delta.stop_reason; }
      else if (e.type === "error") throw new Error(`Claude analysis failed: ${e.error?.message || "stream error"}.`);
    }
  }
  if (stop === "max_tokens") throw new Error("Claude ran out of output tokens before finishing the analysis.");
  if (stop === "refusal") throw new Error("Claude declined to analyse this image.");
  let analysis;
  try { analysis = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { throw new Error("Claude's analysis was not valid JSON."); }
  const missing = ANALYSIS_SCHEMA.required.filter((k) => !(k in analysis));
  if (missing.length) throw new Error(`Claude's analysis is missing: ${missing.join(", ")}.`);
  for (const k of ["colourRoles", "corridors", "rooms", "doorways", "noise", "textLabels", "vectorizationIssues", "uncertainties", "recommendations"])
    if (!Array.isArray(analysis[k])) throw new Error(`Claude's analysis field ${k} is not a list.`);
  return { analysis, usage, model: servedModel, shapes: compact.shapes.length };
}
