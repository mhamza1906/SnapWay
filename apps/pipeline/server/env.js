// Loads server settings for APP_ENV (prod by default, or dev): first
// .env.<APP_ENV>, then shared .env. Values already in the process environment
// win, and the environment file wins over shared .env. Prod never reads
// .env.dev, so development credentials stay out of production.
import { config } from "dotenv";

export const APP_ENVS = ["dev", "prod"];
// SnapWay default is prod (Gemini on Vertex AI). Only Arjun runs dev (Claude).
const appEnv = process.env.APP_ENV || "prod";
if (!APP_ENVS.includes(appEnv))
  throw new Error(`APP_ENV must be dev or prod (got "${appEnv}").`);
process.env.APP_ENV = appEnv;
config({ path: [`.env.${appEnv}`, ".env"] });
