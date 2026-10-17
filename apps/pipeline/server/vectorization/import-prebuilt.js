import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { openAssetStore } from "./assets.js";

let store;
try {
  const { values } = parseArgs({ options: {
    floor: { type: "string" }, label: { type: "string" }, svg: { type: "string" }, source: { type: "string" },
    replace: { type: "boolean", default: false },
  } });
  if (!values.floor || !values.label || !values.svg || !values.source)
    throw new Error('Usage: npm run import-prebuilt -- --floor ia-4 --label "IA floor 4" --source input.png --svg exported.svg [--replace]');
  const [source, svg] = await Promise.all([readFile(values.source), readFile(values.svg)]);
  store = openAssetStore();
  const { svg: omitted, ...metadata } = await store.importFigma({ floorId: values.floor, label: values.label, source, svg, replace: values.replace });
  console.log(JSON.stringify(metadata, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store?.close();
}
