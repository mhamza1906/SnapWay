import sharp from "sharp";

// Larger images are downscaled by the API before the model sees them, so the
// model answers in a smaller frame than the prompt states. Measured with
// claude-sonnet-5-5: a 2400 px page came back ~0.909× and a 2292 px page
// ~0.955×, both consistent with a ~2180 px effective long edge (the documented
// 2576 px did not hold), while 2097 px came back exact. Send every
// coordinate-bearing image already inside a conservative frame and state that
// frame exactly.
export const VISION_MAX_EDGE = 2048;
export const VISION_MAX_PIXELS = 3_400_000;

export function visionScale(width, height, { maxEdge = VISION_MAX_EDGE, maxPixels = VISION_MAX_PIXELS } = {}) {
  return Math.min(1, maxEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
}

export function pngSize(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]{0,64})/.exec(dataUrl || "");
  if (!m) return null;
  const head = Buffer.from(m[1], "base64");
  if (head.length < 24 || head.toString("ascii", 1, 4) !== "PNG") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

// Returns the image to send plus per-axis factors mapping source pixels to
// sent pixels (sent = source × kx, ky).
export async function fitVisionFrame(source, limits) {
  const k = visionScale(source.width, source.height, limits);
  if (k >= 1) return { ...source, kx: 1, ky: 1 };
  const width = Math.max(1, Math.floor(source.width * k)),
    height = Math.max(1, Math.floor(source.height * k)),
    data = Buffer.from(source.dataUrl.split(",")[1], "base64"),
    png = await sharp(data).resize(width, height, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
  return { ...source, width, height, dataUrl: "data:image/png;base64," + png.toString("base64"),
    kx: width / source.width, ky: height / source.height };
}
