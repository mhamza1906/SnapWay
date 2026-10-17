// Cross-platform launcher: `node server/start.js prod|dev`. Sets APP_ENV before
// settings load and runs from apps/pipeline, so runtime .local/ paths resolve
// the same way from any working directory (Windows included).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.argv[2] || process.env.APP_ENV || "prod";
process.env.APP_ENV = env;
process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));
await import("./index.js");
