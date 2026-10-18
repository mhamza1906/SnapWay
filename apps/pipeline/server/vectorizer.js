// vectorizer.ai: turns a raster floor plan into an SVG. Development only:
// credentials (VECTORIZER_API_ID, VECTORIZER_API_SECRET) live in the
// git-ignored .env.dev, and the call is refused when APP_ENV=prod. At most
// VECTORIZER_MAX_CALLS (default 50) requests are ever sent, counted in
// .local/vectorizer/usage.json before each request; results are cached by the
// image's SHA-256, so re-running on the same image costs nothing.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENDPOINT = "https://api.vectorizer.ai/api/v1/vectorize";
const MODES = new Set(["production", "preview", "test", "test_preview"]);

export class VectorizerError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * Counts one vectorizer.ai request against VECTORIZER_MAX_CALLS before it is
 * sent (so a crash can never exceed the cap) and refuses it in prod. Every
 * caller goes through here: the scripts and the /api/vectorization/live route.
 * `dir` holds usage.json; null skips counting (tests with their own env).
 */
export async function reserveVectorizerCall({ name = "plan.png", sha256: hash = "", mode = "production", env = process.env,
  dir = env.VECTORIZER_USAGE_DIR || (env === process.env ? ".local/vectorizer" : null) } = {}) {
  if (env.APP_ENV === "prod") throw new VectorizerError("vectorizer.ai is development-only; run with APP_ENV=dev.", "VECTORIZER_DEV_ONLY");
  const limit = Number(env.VECTORIZER_MAX_CALLS || 50);
  if (!dir) return { callsUsed: null, callsLimit: limit };
  await mkdir(dir, { recursive: true });
  const usageFile = join(dir, "usage.json"),
    usage = JSON.parse(await readFile(usageFile, "utf8").catch(() => '{"calls":0,"log":[]}'));
  if (usage.calls >= limit)
    throw new VectorizerError(`vectorizer.ai limit reached (${usage.calls}/${limit} calls). Raise VECTORIZER_MAX_CALLS in .env.dev to allow more.`, "VECTORIZER_LIMIT_REACHED");
  usage.calls += 1;
  usage.log.push({ at: new Date().toISOString(), name, mode, sha256: hash });
  await writeFile(usageFile, JSON.stringify(usage, null, 2));
  return { callsUsed: usage.calls, callsLimit: limit };
}

/** Returns { svg, cached, credits, callsUsed, callsLimit } for one image buffer. */
export async function vectorize(image, {
  name = "plan.png", mode = process.env.VECTORIZER_MODE || "production",
  dir = ".local/vectorizer", fetchImpl = fetch,
} = {}) {
  if (!MODES.has(mode)) throw new VectorizerError(`VECTORIZER_MODE must be one of ${[...MODES].join(", ")}.`);
  const id = process.env.VECTORIZER_API_ID, secret = process.env.VECTORIZER_API_SECRET;
  if (!id || !secret) throw new VectorizerError("Set VECTORIZER_API_ID and VECTORIZER_API_SECRET in .env.dev.");
  if (process.env.APP_ENV === "prod") throw new VectorizerError("vectorizer.ai is development-only; run with APP_ENV=dev.", "VECTORIZER_DEV_ONLY");
  const hash = createHash("sha256").update(image).digest("hex"), cacheFile = join(dir, `${hash}-${mode}.svg`);
  try {
    const usage = JSON.parse(await readFile(join(dir, "usage.json"), "utf8"));
    return { svg: await readFile(cacheFile, "utf8"), cached: true, credits: 0, callsUsed: usage.calls, callsLimit: Number(process.env.VECTORIZER_MAX_CALLS || 50) };
  } catch { /* not cached */ }
  const { callsUsed, callsLimit: limit } = await reserveVectorizerCall({ name, sha256: hash, mode, dir });
  const usage = { calls: callsUsed };
  const form = new FormData();
  form.append("image", new Blob([image]), name);
  form.append("mode", mode);
  form.append("output.file_format", "svg");
  const response = await fetchImpl(ENDPOINT, {
    method: "POST", body: form,
    headers: { Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64") },
  });
  if (!response.ok) {
    // vectorizer.ai errors are JSON { error: { message } }; never echo credentials.
    const detail = await response.json().catch(() => null);
    throw new VectorizerError(`vectorizer.ai failed (HTTP ${response.status})${detail?.error?.message ? `: ${detail.error.message}` : ""}.`);
  }
  const svg = await response.text();
  await writeFile(cacheFile, svg);
  return { svg, cached: false, credits: Number(response.headers.get("x-credits-charged") || 0), callsUsed: usage.calls, callsLimit: limit };
}
