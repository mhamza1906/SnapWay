// Image generation on Vertex AI with Gemini image models: Nano Banana 2.1 by
// default; Nano Banana Pro and the others are selectable with
// VERTEX_IMAGE_MODEL. Used only to redraw a photographed or scanned plan as a
// clean floor plan; the original is always kept as evidence. Credentials stay
// on the server; there is no provider fallback.
import { vertexEndpoint } from "./vertex.js";

// Nano Banana 2.1: close to Pro on floor plans at about a third of the price.
export const DEFAULT_IMAGE_MODEL = "gemini-nano-banana-2.1";
export const IMAGE_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const DECLINED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"]);

// Closest supported aspect ratio to width:height.
export function nearestAspect(width, height) {
  const target = Math.log(width / height);
  return IMAGE_ASPECTS.reduce((best, a) => {
    const [w, h] = a.split(":").map(Number);
    return Math.abs(Math.log(w / h) - target) < Math.abs(Math.log(best.split(":")[0] / best.split(":")[1]) - target) ? a : best;
  }, "1:1");
}

export class VertexImageModel {
  constructor({
    apiKey = process.env.VERTEX_API_KEY,
    project = process.env.VERTEX_PROJECT,
    location = process.env.VERTEX_IMAGE_LOCATION || process.env.VERTEX_LOCATION || "global",
    model = process.env.VERTEX_IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
    imageSize = process.env.VERTEX_IMAGE_SIZE || "2K",
    fetchImpl = fetch,
  } = {}) {
    if (!["1K", "2K", "4K"].includes(imageSize)) throw new Error("VERTEX_IMAGE_SIZE must be 1K, 2K or 4K.");
    Object.assign(this, { name: "Vertex AI image", apiKey, project, location, model, imageSize, fetch: fetchImpl });
  }
  get configured() {
    return !!(this.apiKey && this.project);
  }
  /**
   * prompt: instructions; images: data URLs (PNG/JPEG/WebP) sent as references.
   * Returns { dataUrl, mimeType, model, usage, text }.
   */
  async generate({ prompt, images = [], aspectRatio = null, signal, timeout = 240000 }) {
    if (!this.configured)
      throw new Error("Clean-plan images need VERTEX_API_KEY and VERTEX_PROJECT in the server env file.");
    const parts = [{ text: prompt }, ...images.map((url) => {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (!match) throw new Error("Image generation needs embedded PNG, JPEG or WebP references.");
      return { inlineData: { mimeType: match[1], data: match[2] } };
    })];
    const request = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { imageSize: this.imageSize, ...(aspectRatio ? { aspectRatio } : {}) },
      },
    };
    const deadline = AbortSignal.timeout(timeout);
    const response = await this.fetch(vertexEndpoint(this), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) {
      // Never echo upstream bodies or credential-bearing headers.
      const error = new Error(`Vertex AI image request failed (HTTP ${response.status}). Check model access (${this.model}), location and quota.`);
      error.status = response.status;
      error.headers = response.headers;
      throw error;
    }
    const data = await response.json(), candidate = data.candidates?.[0];
    if (data.promptFeedback?.blockReason || DECLINED.has(candidate?.finishReason))
      throw new Error("Vertex AI declined to generate this image.");
    const out = (candidate?.content?.parts || []).filter((p) => !p.thought),
      image = out.find((p) => p.inlineData?.data);
    if (!image) throw new Error(`Vertex AI returned no image (${candidate?.finishReason || "unknown reason"}).`);
    const u = data.usageMetadata || {};
    return {
      dataUrl: `data:${image.inlineData.mimeType};base64,${image.inlineData.data}`,
      mimeType: image.inlineData.mimeType,
      model: data.modelVersion || this.model,
      text: out.filter((p) => typeof p.text === "string").map((p) => p.text).join("").slice(0, 2000),
      usage: { input_tokens: u.promptTokenCount || 0, output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
        total_tokens: u.totalTokenCount || 0 },
    };
  }
}
