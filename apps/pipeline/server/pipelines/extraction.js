import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createProvider } from "../provider.js";
import { MapSchema } from "../../shared/map.js";
const inFlight = new Map();
export const hashBytes = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function cachedExtraction(
  source,
  provider = createProvider(),
  options = {},
) {
  const imageHash = hashBytes(
    Buffer.from(source.dataUrl.split(",")[1], "base64"),
  );
  const cacheKey = hashBytes(
    JSON.stringify({
      imageHash,
      width: source.width,
      height: source.height,
      provider: provider.name,
      model: provider.model,
      ...(provider.effort ? { effort: provider.effort } : {}),
      pipeline: "geometry-v2-2026-10-16",
      reasoning: "low",
      ...(Object.keys(options).length ? { options } : {}),
    }),
  );
  const path = `.local/cache/${cacheKey}.json`;
  try {
    const map = MapSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return { map: { ...map, source }, cacheKey, cached: true, imageHash };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (inFlight.has(cacheKey))
    return { ...(await inFlight.get(cacheKey)), cached: true };
  const promise = (async () => {
    const map = await provider.extract(source, options);
    await mkdir(".local/cache", { recursive: true });
    await writeFile(path + ".tmp", JSON.stringify(map));
    await rename(path + ".tmp", path);
    return { map, cacheKey, cached: false, imageHash };
  })();
  inFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(cacheKey);
  }
}
