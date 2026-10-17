// The Waterloo E2 regression building (about 16 MB) is not committed to SnapWay.
// Tests that need it are skipped with this reason unless the file is present
// at public/buildings/waterloo-e2.json.
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
export const WATERLOO = "public/buildings/waterloo-e2.json";
export const hasWaterloo = existsSync(WATERLOO);
export const waterlooText = () => (hasWaterloo ? readFileSync(WATERLOO, "utf8") : null);
export const wtest = (name, fn) =>
  test(name, { skip: hasWaterloo ? false : `needs the ${WATERLOO} regression fixture` }, fn);
