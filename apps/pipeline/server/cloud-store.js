// Optional cloud storage: buildings in Tiger Data (PostgreSQL) and uploaded plans
// in Cloudflare R2. Both are off unless their settings exist, and a storage
// failure never breaks the pipeline: callers warn and keep the local files.
// Tables live in their own schema so they never touch the Django API's tables.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BuildingSchema } from "../shared/building/schema.js";
import { buildingSummary } from "../shared/building/navigation-bundle.js";

export const SCHEMA = "snapway_pipeline";
const PLAN_TYPES = { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg" };

export function storageSettings(env = process.env) {
  return {
    database: !!env.DATABASE_URL,
    r2: !!(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET_NAME),
    bucket: env.R2_BUCKET_NAME || null,
  };
}

// libpq semantics, as approved for the Tiger Free-plan demo (docs/deployment.md):
// require = encrypted without verifying the server; verify-ca/verify-full verify.
// Plaintext modes are refused for a remote database.
export function poolConfig(url, env = process.env) {
  const parsed = new URL(url),
    mode = parsed.searchParams.get("sslmode") || env.PGSSLMODE || "verify-full";
  parsed.searchParams.delete("sslmode");
  parsed.searchParams.delete("sslrootcert");
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  let ssl;
  if (mode === "require") ssl = { rejectUnauthorized: false };
  else if (mode === "verify-full" || mode === "verify-ca") {
    const ca = env.PGSSLROOTCERT && env.PGSSLROOTCERT !== "system" ? readFileSync(env.PGSSLROOTCERT, "utf8") : undefined;
    ssl = { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
  } else if (local) ssl = false;
  else throw new Error(`sslmode=${mode} is not allowed for a remote database; use require or verify-full.`);
  return { connectionString: parsed.toString(), ssl, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 };
}

// Never echo connection strings or keys back to a client.
export const safeError = (e) =>
  /password must be a string/.test(String(e?.message))
    ? "Tiger Data needs a password: add PGPASSWORD to the env file (or put it in DATABASE_URL)."
    : String(e?.message || e)
    .replace(/postgres(ql)?:\/\/[^\s]+/gi, "postgres://…")
    .replace(/[A-Za-z0-9+/]{32,}/g, "…")
    .slice(0, 200);

const summarize = (building, sizeBytes, updatedAt) => {
  const spaces = building.floors.flatMap((f) => f.geometry.spaces);
  return {
    ...buildingSummary(building),
    rooms: spaces.filter((s) => !["corridor", "lobby"].includes(s.kind) && s.access !== "nonwalkable").length,
    regions: spaces.length,
    reviewedFloors: building.floors.filter((f) => f.geometryStatus === "reviewed").length,
    sizeBytes,
    modifiedAt: updatedAt,
  };
};

async function defaultDb(env) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool(poolConfig(env.DATABASE_URL, env));
  pool.on("error", (e) => console.warn(`Tiger Data connection error: ${safeError(e)}`));
  return pool;
}

async function defaultS3(env) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
}

// `db` needs query(text, values); `s3` needs send(command). Both are injectable for tests.
export function createCloudStore({ env = process.env, db, s3 } = {}) {
  const settings = storageSettings(env);
  let dbPromise, s3Promise, schemaReady;
  const database = () => {
    if (!settings.database) throw Object.assign(new Error("Tiger Data is not configured (DATABASE_URL)."), { status: 503 });
    return (dbPromise ??= db ? Promise.resolve(db) : defaultDb(env));
  };
  const bucket = () => {
    if (!settings.r2) throw Object.assign(new Error("R2 is not configured (R2_* settings)."), { status: 503 });
    return (s3Promise ??= s3 ? Promise.resolve(s3) : defaultS3(env));
  };
  const ready = async () => {
    const client = await database();
    schemaReady ??= (async () => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.buildings (
        id text PRIMARY KEY,
        name text NOT NULL,
        building jsonb NOT NULL,
        summary jsonb NOT NULL,
        sha256 text NOT NULL,
        size_bytes integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now())`);
    })().catch((e) => {
      schemaReady = undefined;
      throw e;
    });
    await schemaReady;
    return client;
  };

  return {
    settings,

    // Upserts by building id: saving the same building again updates its row.
    async saveBuilding(input) {
      const building = BuildingSchema.parse(input),
        text = JSON.stringify(building),
        sizeBytes = Buffer.byteLength(text),
        sha256 = createHash("sha256").update(text).digest("hex"),
        summary = summarize(building, sizeBytes, new Date().toISOString());
      const client = await ready();
      const { rows } = await client.query(
        `INSERT INTO ${SCHEMA}.buildings (id, name, building, summary, sha256, size_bytes)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, building = EXCLUDED.building,
           summary = EXCLUDED.summary, sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes,
           updated_at = now()
         RETURNING (xmax <> 0) AS updated, updated_at`,
        [building.id, building.name || building.id, text, JSON.stringify(summary), sha256, sizeBytes],
      );
      return { key: "cloud-" + building.id, sha256, updated: !!rows[0]?.updated, updatedAt: rows[0]?.updated_at };
    },

    // Summaries only; the building JSON is fetched when one is opened.
    async listBuildings() {
      const client = await ready();
      const { rows } = await client.query(
        `SELECT id, summary, size_bytes, updated_at FROM ${SCHEMA}.buildings ORDER BY updated_at DESC LIMIT 200`,
      );
      return rows.map((r) => ({
        key: "cloud-" + r.id,
        summary: { ...r.summary, sizeBytes: r.size_bytes, modifiedAt: new Date(r.updated_at).toISOString() },
      }));
    },

    async getBuilding(id) {
      const client = await ready();
      const { rows } = await client.query(`SELECT building FROM ${SCHEMA}.buildings WHERE id = $1`, [id]);
      return rows[0] ? BuildingSchema.parse(rows[0].building) : null;
    },

    // Content-addressed: the same file is stored once.
    async uploadPlan(buffer, mimetype) {
      const client = await bucket(),
        { HeadObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3"),
        sha256 = createHash("sha256").update(buffer).digest("hex"),
        key = `plans/${sha256}${PLAN_TYPES[mimetype] || ""}`;
      try {
        await client.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: key }));
        return { key, sha256, uploaded: false };
      } catch (e) {
        if (e?.$metadata?.httpStatusCode !== 404 && e?.name !== "NotFound") throw e;
      }
      await client.send(
        new PutObjectCommand({ Bucket: settings.bucket, Key: key, Body: buffer, ContentType: mimetype || "application/octet-stream" }),
      );
      return { key, sha256, uploaded: true };
    },

    // Connects for real and changes nothing; reports reachability without secrets.
    async check() {
      const out = { database: { configured: settings.database }, r2: { configured: settings.r2 } };
      if (settings.database)
        try {
          // Read-only: the schema is created on the first save, not by a check.
          const client = await database();
          const { rows } = await client.query(`SELECT to_regclass('${SCHEMA}.buildings') IS NOT NULL AS present`);
          const buildings = rows[0]?.present
            ? (await client.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.buildings`)).rows[0].n
            : 0;
          out.database = { configured: true, ok: true, schema: SCHEMA, tableCreated: !!rows[0]?.present, buildings };
        } catch (e) {
          out.database = { configured: true, ok: false, error: safeError(e) };
        }
      if (settings.r2)
        try {
          const { HeadBucketCommand } = await import("@aws-sdk/client-s3");
          await (await bucket()).send(new HeadBucketCommand({ Bucket: settings.bucket }));
          out.r2 = { configured: true, ok: true, bucket: settings.bucket };
        } catch (e) {
          out.r2 = { configured: true, ok: false, error: safeError(e) };
        }
      return out;
    },
  };
}

let shared;
export const cloudStore = () => (shared ??= createCloudStore());
