import sharp from "sharp";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { hashBytes } from "./extraction.js";
export async function preparePlan(buffer, name, mime) {
  const hash = hashBytes(buffer),
    original = {
      id: "asset-" + hash,
      name,
      mime,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
      hash,
      provenance: "Original user upload; preserved byte-for-byte",
    };
  const images = [];
  if (mime === "application/pdf") {
    const task = getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const doc = await task.promise;
    try {
      if (doc.numPages > 20)
        throw new Error("Import up to 20 PDF pages at a time.");
      for (let page = 1; page <= doc.numPages; page++) {
        const p = await doc.getPage(page),
          base = p.getViewport({ scale: 1 }),
          viewport = p.getViewport({
            scale: 2400 / Math.max(base.width, base.height),
          }),
          canvas = createCanvas(
            Math.ceil(viewport.width),
            Math.ceil(viewport.height),
          );
        await p.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
          canvas,
        }).promise;
        images.push({ buffer: canvas.toBuffer("image/png"), page });
      }
    } finally {
      await task.destroy();
    }
  } else if (["image/png", "image/jpeg"].includes(mime)) {
    images.push({ buffer, page: null });
  } else throw new Error("Choose a PDF, PNG, or JPEG.");
  const assets = { [original.id]: original },
    sources = [];
  for (const image of images) {
    const { data, info } = await sharp(image.buffer, {
        limitInputPixels: 40_000_000,
      })
        .rotate()
        .resize({
          width: 2400,
          height: 2400,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png()
        .toBuffer({ resolveWithObject: true }),
      h = hashBytes(data),
      id = "asset-" + h;
    assets[id] = {
      id,
      name: `${name}${image.page ? " · page " + image.page : ""}.png`,
      mime: "image/png",
      dataUrl: "data:image/png;base64," + data.toString("base64"),
      hash: h,
      provenance: "Normalized source image; original retained",
    };
    sources.push({
      id: "source-" + h.slice(0, 12),
      assetId: id,
      originalAssetId: original.id,
      name: `${name}${image.page ? " · page " + image.page : ""}`,
      width: info.width,
      height: info.height,
      page: image.page,
      hash: h,
      transform: [1, 0, 0, 1, 0, 0],
      sectionId: "unassigned-" + h.slice(0, 12),
      alignment: "draft",
      landmarks: [],
      notes: "Assign to a floor and confirm alignment.",
      visible: true,
    });
  }
  return { assets, sources };
}
