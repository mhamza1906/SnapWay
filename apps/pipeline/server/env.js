// One private local file for the entire repo. Production receives process env
// from systemd; it does not need a separate provider-specific credential file.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

export const environmentFile = fileURLToPath(new URL("../../../local/.env", import.meta.url));
config({ path: environmentFile, override: false, quiet: true });

export const APP_ENVS = ["dev", "prod"];
// The launcher/process wins; APP_ENV selects provider policy, never a file.
const appEnv = process.env.APP_ENV || "prod";
if (!APP_ENVS.includes(appEnv))
  throw new Error(`APP_ENV must be dev or prod (got "${appEnv}").`);
process.env.APP_ENV = appEnv;
// Until `python scripts/env_contract.py migrate` consolidates them into
// local/.env, the older per-app files still fill in missing values (never
// overriding local/.env or the process): apps/pipeline/.env.<APP_ENV>, then .env.
config({ path: [fileURLToPath(new URL(`../.env.${appEnv}`, import.meta.url)), fileURLToPath(new URL("../.env", import.meta.url))], override: false, quiet: true });
