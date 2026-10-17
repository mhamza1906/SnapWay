import { performance } from "node:perf_hooks";
import { inspectRaster, inspectSvg, MAX_BYTES, sha256, VectorizationError } from "./assets.js";

export const VECTORIZER_ENDPOINT = "https://api.vectorizer.ai/api/v1/vectorize";

export function assertLiveConfigured(env = process.env) {
  if (env.VECTORIZER_LIVE_ENABLED !== "true")
    throw new VectorizationError(503, "VECTORIZER_DISABLED", "Live Vectorizer.AI calls are disabled. Use the explicitly labelled IA-4 mock for the demo.");
  if (!env.VECTORIZER_API_ID?.trim() || !env.VECTORIZER_API_SECRET?.trim())
    throw new VectorizationError(503, "VECTORIZER_NOT_CONFIGURED", "Vectorizer.AI API ID and secret are not configured.");
}

export async function vectorizeImage(bytes, { env = process.env, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  assertLiveConfigured(env);
  const image = await inspectRaster(bytes);
  const body = new FormData();
  body.append("image", new Blob([bytes], { type: image.mime }), image.mime === "image/png" ? "floor.png" : "floor.jpg");
  body.append("mode", "production");
  body.append("output.file_format", "svg");
  body.append("policy.retention_days", "0");
  const started = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let response, svgBytes;
  try {
    response = await fetchImpl(VECTORIZER_ENDPOINT, {
      method: "POST", body, signal, redirect: "error",
      headers: { Authorization: `Basic ${Buffer.from(`${env.VECTORIZER_API_ID.trim()}:${env.VECTORIZER_API_SECRET.trim()}`).toString("base64")}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Do not echo vendor text: it may contain credentials or request details.
      throw new VectorizationError(502, "VECTORIZER_UPSTREAM_ERROR", `Vectorizer.AI returned HTTP ${response.status}; no retry or mock fallback was performed.`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new VectorizationError(502, "VECTORIZER_OUTPUT_TOO_LARGE", "Vectorizer.AI output exceeded 15 MB.");
      chunks.push(chunk);
    }
    svgBytes = Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof VectorizationError) throw error;
    throw new VectorizationError(signal.aborted ? 504 : 502,
      signal.aborted ? "VECTORIZER_TIMEOUT" : "VECTORIZER_CONNECTION_ERROR",
      "Vectorizer.AI request did not complete. No retry was made; check usage before repeating the request.");
  }
  let dimensions;
  try { dimensions = await inspectSvg(svgBytes); }
  catch { throw new VectorizationError(502, "VECTORIZER_INVALID_OUTPUT", "Vectorizer.AI did not return a supported static SVG."); }
  const rawCredits = response.headers.get("X-Credits-Charged");
  const credits = rawCredits?.trim() ? Number(rawCredits) : NaN;
  return {
    svg: svgBytes.toString("utf8"), sha256: sha256(svgBytes), sourceSha256: sha256(bytes), ...dimensions,
    provider: "vectorizer.ai", mock: false, navigationReady: false,
    disclosure: "Vectorizer.AI raster tracing; semantic and route review still required.",
    metrics: { elapsedMs: Math.round(performance.now() - started), upstreamRequests: 1,
      creditsCharged: Number.isFinite(credits) && credits >= 0 ? credits : null, usd: null },
  };
}
