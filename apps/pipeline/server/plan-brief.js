// Plan brief: before the image model redraws a floor, Gemini 4 Argon (on
// Vertex AI by default; VERTEX_BRIEF_MODEL, reasoning effort high) reads the
// ORIGINAL plan and decides how it must be redrawn. In the redraw, flat light
// grey means corridor and every other enclosed area is a white room, so the
// reader decides the corridors first: when the original shades them grey, those
// grey areas are the corridors (and nothing else is made grey); when it does
// not, it works out each corridor in detail and has the image model draw it
// grey. It also reads named rooms, unlabelled enclosed spaces such as stair
// cores without a name (drawn as rooms, so the map author can mark them
// later), labelled stairs and lifts, voids, easy-to-miss walls, doorways and
// clutter to remove. Credentials stay on the server; there is no fallback.
import { z } from "zod";
import { vertexEndpoint } from "./vertex.js";

export const DEFAULT_BRIEF_MODEL = "gemini-4-argon";
export const BRIEF_VERSION = "plan-brief-v3-2026-10-17";
/** The one fill the redraw uses for corridors; raster segmentation reads it. */
export const CIRCULATION_GREY = "#D8D8D8";

export const BRIEF_PROMPT = (label) => [
  `You are the plan reader for an indoor-mapping pipeline. Study this original ${label ? `floor plan (${label})` : "floor plan"} carefully and decide how an image model must redraw it as a clean, flat, top-down plan. You do the thinking; the image model only follows your instructions.`,
  "How the redraw is used: a program reads it. Solid black lines are walls and separate regions; gaps in walls are door openings;",
  `every area filled flat light grey (${CIRCULATION_GREY}) is a CORRIDOR (walkable circulation: corridors, hallways, halls, lobbies, atria, concourses, passages); every other enclosed area is white and becomes a room. Text inside a region names it.`,
  "CORRIDORS FIRST. Decide whether this original shades its corridors grey (or with another tint):",
  "- If it does (greyInOriginal = true), the grey areas ARE the corridors. List every grey area in `corridors`, located relative to named rooms, including the large open ones and the narrow passages, and tell the image model to fill exactly those areas with the grey and nothing else.",
  "- If it does not (greyInOriginal = false), work out in detail which areas are corridors from the plan itself: the connected open floor that links room doors, entrances, stairs and lifts, long passages between rows of rooms, open halls and lobbies. List each one in `corridors` with where it starts and ends and which rooms open onto it, and tell the image model to fill each with the grey.",
  "A plan always has corridors connecting its rooms; do not leave the floor as only rooms.",
  "THE BUILDING ONLY. Find the building's exterior wall. Everything outside it must be removed from the redraw: landscaping, planting and trees, canopies and roof outlines drawn in thin lines, paving patterns, site and property lines, dashed outlines, neighbouring structures and north arrows. Glazed exterior walls drawn as thin lines are still the building edge: tell the image model to draw them as solid walls so the outline is closed. List what to remove under `remove` and describe the exterior outline under `walls`.",
  "Then read the rest:",
  "Rooms with printed names, exactly as printed.",
  "Unlabelled enclosed spaces, including stair cores or ramps drawn with treads but no name, closets, shafts and service rooms: drawn as closed white rooms with their walls, so each becomes its own region; say where each is.",
  "Labelled stairs and lifts (white rooms keeping their names; drop yellow/colour fills).",
  "Voids and areas that are not floor (open to below, outside courts): keep their outline closed, white.",
  "Walls that matter: the exterior outline, curved or angled walls, thin partitions between small rooms, walls hidden under shading or symbols.",
  "Doorways: where rooms open onto corridors (door swings or gaps), so the redraw keeps a gap there and closes walls elsewhere.",
  "Everything to remove: fire-equipment symbols, red/blue leader lines, 'you are here' marks, legends, glare, furniture and seat-row clutter that is not a wall.",
  "Then write `instructions`: direct, specific instructions to the image model for THIS floor, starting with exactly which areas to fill grey as corridors. Do not invent anything that is not in the original.",
].join(" ");

const text = (max) => z.string().trim().max(max);
const list = (max, n) => z.array(text(max)).max(n).default([]);
export const BriefSchema = z.object({
  greyInOriginal: z.boolean(),
  circulationInInput: text(300),
  corridors: list(400, 60),
  rooms: list(120, 150),
  unlabelledSpaces: list(300, 80),
  stairsAndLifts: list(120, 40),
  voids: list(200, 20),
  walls: list(300, 40),
  doorways: list(300, 80),
  remove: list(200, 40),
  instructions: text(3000),
});
// Vertex response schema (OpenAPI subset; no maxItems).
const strings = (description) => ({ type: "ARRAY", items: { type: "STRING" }, description });
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    greyInOriginal: { type: "BOOLEAN", description: "True when the original shades its corridors grey (or another tint)." },
    circulationInInput: { type: "STRING", description: "How corridors appear in this original: the shading, or how you identified them." },
    corridors: strings("Every corridor, hall, lobby, atrium or passage, located relative to named rooms (start, end, rooms opening onto it)."),
    rooms: strings("Printed room names, exactly as printed."),
    unlabelledSpaces: strings("Unnamed enclosed spaces (unlabelled stairs or ramps with treads, closets, shafts, service rooms) and where they are."),
    stairsAndLifts: strings("Labelled stairs and lifts."),
    voids: strings("Voids or non-floor areas (open to below, courts)."),
    walls: strings("Walls that must be kept, especially easy-to-miss ones."),
    doorways: strings("Where rooms open onto corridors."),
    remove: strings("Things to remove."),
    instructions: { type: "STRING", description: "Direct instructions to the image model for this floor, corridors first." },
  },
  required: ["greyInOriginal", "circulationInInput", "corridors", "rooms", "unlabelledSpaces", "stairsAndLifts", "voids", "walls", "doorways", "remove", "instructions"],
};
export const BRIEF_EFFORTS = { low: "LOW", medium: "MEDIUM", high: "HIGH" };

export class PlanBriefModel {
  constructor({
    apiKey = process.env.VERTEX_API_KEY,
    project = process.env.VERTEX_PROJECT,
    location = process.env.VERTEX_BRIEF_LOCATION || process.env.VERTEX_LOCATION || "global",
    model = process.env.VERTEX_BRIEF_MODEL || DEFAULT_BRIEF_MODEL,
    // Reasoning effort for the plan reader; high by default.
    effort = process.env.VERTEX_BRIEF_EFFORT || "high",
    fetchImpl = fetch,
  } = {}) {
    if (!BRIEF_EFFORTS[effort]) throw new Error("VERTEX_BRIEF_EFFORT must be low, medium or high.");
    Object.assign(this, { name: "Vertex AI plan brief", apiKey, project, location, model, effort, fetch: fetchImpl });
  }
  get configured() {
    return !!(this.apiKey && this.project);
  }
  /** dataUrl: the original plan (PNG/JPEG/WebP). Returns { brief, model, usage }. */
  async brief({ dataUrl, label = "", signal, timeout = 300000 }) {
    if (!this.configured) throw new Error("Plan briefs need VERTEX_API_KEY and VERTEX_PROJECT in the server env file.");
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) throw new Error("The plan brief needs an embedded PNG, JPEG or WebP image.");
    const deadline = AbortSignal.timeout(timeout);
    const response = await this.fetch(vertexEndpoint(this), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: BRIEF_PROMPT(label) }, { inlineData: { mimeType: match[1], data: match[2] } }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: BRIEF_EFFORTS[this.effort] } },
      }),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      // Never echo upstream bodies or credential-bearing headers.
      const error = new Error(`Vertex AI plan brief failed (HTTP ${response.status}). Check model access (${this.model}), location and quota.`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json(),
      raw = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error("The plan brief was not valid JSON."); }
    const u = data.usageMetadata || {};
    return {
      brief: BriefSchema.parse(parsed),
      model: data.modelVersion || this.model,
      usage: { input_tokens: u.promptTokenCount || 0, output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), total_tokens: u.totalTokenCount || 0 },
    };
  }
}

/** The brief as text for the image model's prompt, corridors first. */
export function briefText(brief) {
  const line = (title, items) => (items.length ? `${title}: ${items.join("; ")}.` : "");
  return [
    "Instructions from the plan reader who studied the original:",
    brief.greyInOriginal
      ? `CORRIDORS: the original shades its corridors (${brief.circulationInInput}). Fill exactly those shaded areas with flat grey ${CIRCULATION_GREY}, and nothing else.`
      : `CORRIDORS: the original does not shade them; the plan reader identified them (${brief.circulationInInput}). Fill each of these with flat grey ${CIRCULATION_GREY}.`,
    line("Corridor areas", brief.corridors),
    line("Rooms (white, keep their names)", brief.rooms),
    line("Unlabelled enclosed spaces (draw each as a closed white room with its walls)", brief.unlabelledSpaces),
    line("Stairs and lifts (white rooms, keep their names, no colour fill)", brief.stairsAndLifts),
    line("Voids (keep the outline closed, white)", brief.voids),
    line("Walls to keep", brief.walls),
    line("Doorways onto corridors (keep a gap)", brief.doorways),
    line("Remove", brief.remove),
    brief.instructions,
  ].filter(Boolean).join(" ");
}
