// Tiger Data / R2 storage with in-memory stand-ins: no network, no credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCloudStore, poolConfig, safeError, storageSettings, SCHEMA } from "../server/cloud-store.js";
import { libraryEntries, libraryEntry } from "../server/building-library.js";
import { BuildingSchema } from "../shared/building/schema.js";

const building = JSON.parse(readFileSync("public/buildings/routing-fixture.json", "utf8"));
const ENV = {
  DATABASE_URL: "postgres://user@db.example.test:5432/tsdb?sslmode=require",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "id",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET_NAME: "bucket",
};

// Minimal SQL stand-in for the statements cloud-store issues.
function fakeDb() {
  const rows = new Map(),
    statements = [];
  return {
    rows,
    statements,
    async query(text, values = []) {
      statements.push(text.trim().split(/\s+/).slice(0, 3).join(" "));
      if (/^CREATE/.test(text.trim())) return { rows: [] };
      if (/^INSERT/.test(text.trim())) {
        const [id, name, json, summary, sha256, size] = values,
          updated = rows.has(id);
        rows.set(id, { id, name, building: JSON.parse(json), summary: JSON.parse(summary), sha256, size_bytes: size, updated_at: new Date() });
        return { rows: [{ updated, updated_at: new Date() }] };
      }
      if (/^SELECT id, summary/.test(text.trim())) return { rows: [...rows.values()] };
      if (/^SELECT building/.test(text.trim())) return { rows: rows.has(values[0]) ? [rows.get(values[0])] : [] };
      if (/^SELECT count/.test(text.trim())) return { rows: [{ n: rows.size }] };
      if (/^SELECT to_regclass/.test(text.trim())) return { rows: [{ present: statements.some((s) => s.startsWith("CREATE TABLE")) }] };
      throw new Error("unexpected SQL " + text);
    },
  };
}

function fakeS3() {
  const objects = new Map();
  return {
    objects,
    async send(command) {
      const name = command.constructor.name,
        { Key } = command.input;
      if (name === "HeadObjectCommand") {
        if (!objects.has(Key)) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        return {};
      }
      if (name === "PutObjectCommand") return objects.set(Key, command.input), {};
      if (name === "HeadBucketCommand") return {};
      throw new Error("unexpected command " + name);
    },
  };
}

test("storage is off without settings", async () => {
  assert.deepEqual(storageSettings({}), { database: false, r2: false, bucket: null });
  const store = createCloudStore({ env: {} });
  await assert.rejects(store.saveBuilding(building), /not configured/);
  await assert.rejects(store.uploadPlan(Buffer.from("x"), "image/png"), /not configured/);
  assert.deepEqual(await store.check(), { database: { configured: false }, r2: { configured: false } });
});

test("TLS follows libpq modes and refuses plaintext to a remote host", () => {
  const require = poolConfig(ENV.DATABASE_URL, {});
  assert.deepEqual(require.ssl, { rejectUnauthorized: false });
  assert.ok(!require.connectionString.includes("sslmode"));
  assert.equal(poolConfig("postgres://u@db.example.test/tsdb?sslmode=verify-full", {}).ssl.rejectUnauthorized, true);
  assert.equal(poolConfig("postgres://u@db.example.test/tsdb", {}).ssl.rejectUnauthorized, true);
  assert.throws(() => poolConfig("postgres://u@db.example.test/tsdb?sslmode=disable", {}), /not allowed/);
  assert.equal(poolConfig("postgres://u@localhost/tsdb?sslmode=disable", {}).ssl, false);
});

test("errors never echo connection strings or keys", () => {
  const message = safeError(new Error("failed postgres://someuser:pw@host:1/db with 0123456789abcdef0123456789abcdef01234567"));
  assert.ok(!message.includes("pw@host"));
  assert.ok(!message.includes("0123456789abcdef0123456789abcdef01234567"));
  assert.match(safeError(new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string")), /PGPASSWORD/);
});

test("saves, lists and reopens a building in its own schema", async () => {
  const db = fakeDb(),
    store = createCloudStore({ env: ENV, db });
  const first = await store.saveBuilding(building);
  assert.equal(first.key, "cloud-" + building.id);
  assert.equal(first.updated, false);
  assert.equal((await store.saveBuilding(building)).updated, true);
  assert.ok(db.statements.includes(`CREATE SCHEMA IF`));
  assert.equal(db.statements.filter((s) => s.startsWith("CREATE")).length, 2, "schema created once");
  const [listed] = await store.listBuildings();
  assert.equal(listed.key, first.key);
  assert.equal(listed.summary.name, building.name);
  assert.ok(listed.summary.regions > 0);
  assert.deepEqual(await store.getBuilding(building.id), BuildingSchema.parse(building));
  assert.equal(await store.getBuilding("missing"), null);
  assert.deepEqual((await store.check()).database, { configured: true, ok: true, schema: SCHEMA, tableCreated: true, buildings: 1 });
});

test("a check never creates the schema", async () => {
  const db = fakeDb(),
    store = createCloudStore({ env: ENV, db });
  assert.deepEqual((await store.check()).database, { configured: true, ok: true, schema: SCHEMA, tableCreated: false, buildings: 0 });
  assert.ok(db.statements.every((s) => !s.startsWith("CREATE")));
});

test("rejects an invalid building before touching the database", async () => {
  const db = fakeDb(),
    store = createCloudStore({ env: ENV, db });
  await assert.rejects(store.saveBuilding({ id: "x" }), (e) => e.name === "ZodError");
  assert.equal(db.statements.length, 0);
});

test("plans are stored once in R2 by content hash", async () => {
  const s3 = fakeS3(),
    store = createCloudStore({ env: ENV, s3 }),
    bytes = Buffer.from("%PDF-1.7 test");
  const first = await store.uploadPlan(bytes, "application/pdf");
  assert.match(first.key, /^plans\/[0-9a-f]{64}\.pdf$/);
  assert.equal(first.uploaded, true);
  assert.equal(s3.objects.get(first.key).Bucket, "bucket");
  assert.equal((await store.uploadPlan(bytes, "application/pdf")).uploaded, false);
  assert.equal(s3.objects.size, 1);
});

test("the library lists Tiger Data buildings and survives an outage", async () => {
  const db = fakeDb(),
    store = createCloudStore({ env: ENV, db });
  await store.saveBuilding(building);
  const cloud = (await libraryEntries({ store })).filter((e) => e.source === "cloud");
  assert.equal(cloud.length, 1);
  assert.equal(cloud[0].summary.sourceLabel, "Tiger Data");
  assert.equal((await libraryEntry(cloud[0].key, { store })).building.id, building.id);

  const broken = createCloudStore({
    env: ENV,
    db: { query: async () => Promise.reject(new Error("connect ETIMEDOUT")) },
  });
  const entries = await libraryEntries({ store: broken });
  assert.ok(entries.every((e) => e.source !== "cloud"));
  assert.ok(entries.length > 0, "local files still listed");
});
