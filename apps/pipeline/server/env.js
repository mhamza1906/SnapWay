// One private local file for the entire repo. Production receives process env
// from systemd; it does not need a separate provider-specific credential file.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

export const environmentFile = fileURLToPath(new URL("../../../local/.env", import.meta.url));
config({ path: environmentFile, override: false });

export const APP_ENVS = ["dev", "prod"];
// The launcher/process wins; APP_ENV selects provider policy, never a file.
const appEnv = process.env.APP_ENV || "prod";
if (!APP_ENVS.includes(appEnv))
  throw new Error(`APP_ENV must be dev or prod (got "${appEnv}").`);
process.env.APP_ENV = appEnv;
