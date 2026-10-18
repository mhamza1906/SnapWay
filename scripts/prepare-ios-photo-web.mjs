/** Xcode packaging hook: never run tests; never ship stale web assets after Cmd+R. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "apps/web");
const output = join(web, "dist/snapway-visitor/browser");
const cache = join(web, ".angular/ios-photo-web.sha256");
const hash = createHash("sha256");
function fingerprint(path) {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) fingerprint(join(path, name));
  } else {
    hash.update(path.slice(web.length));
    hash.update(readFileSync(path));
  }
}
for (const name of [
  "src",
  "public",
  "angular.json",
  "tsconfig.json",
  "tsconfig.app.json",
  "capacitor.config.ts",
  "package-lock.json",
])
  fingerprint(join(web, name));
const digest = hash.digest("hex");
if (
  !existsSync(join(output, "index.html")) ||
  !existsSync(cache) ||
  readFileSync(cache, "utf8") !== digest
) {
  console.log("Refreshing photo-checkpoint screen for this Xcode run…");
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/@angular/cli/bin/ng.js",
      "build",
      "--configuration",
      "visitor",
    ],
    { cwd: web, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, digest);
}
// Runs after Resources so an older Capacitor public folder cannot overwrite this version.
const destination = process.argv[2];
if (!destination || !destination.endsWith(".app/public"))
  throw new Error("Expected Xcode app resource public directory.");
mkdirSync(destination, { recursive: true });
for (const name of readdirSync(destination))
  rmSync(join(destination, name), { recursive: true, force: true });
for (const name of readdirSync(output))
  cpSync(join(output, name), join(destination, name), { recursive: true });
// Mark the installed bundle so future debugging can distinguish the old AR UI.
writeFileSync(
  join(destination, "photo-checkpoint-version.json"),
  JSON.stringify({ mode: "single-photo-named-destination", source: digest }),
);
console.log("Packaged single-photo navigation. ARKit is not started.");
