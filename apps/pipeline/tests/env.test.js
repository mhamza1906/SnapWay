import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("env resolves from module location, ignores legacy files and preserves process overrides", async () => {
  const folder = await mkdtemp(join(tmpdir(), "snapway-env-"));
  try {
    await writeFile(join(folder, ".env.prod"), "LEGACY_ENV_SENTINEL=read-incorrectly\n");
    const module = new URL("../server/env.js", import.meta.url).href;
    const code = `const {environmentFile}=await import(${JSON.stringify(module)});
      console.log(JSON.stringify({path:environmentFile,port:process.env.PORT,
        legacy:process.env.LEGACY_ENV_SENTINEL??null,policy:process.env.APP_ENV}));`;
    const env = { ...process.env, PORT: "5199", APP_ENV: "dev" };
    delete env.LEGACY_ENV_SENTINEL;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: folder, encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, "Environment loader should start without network access");
    const data = JSON.parse(result.stdout.trim());
    assert.match(data.path.replaceAll("\\", "/"), /\/local\/\.env$/);
    assert.equal(data.port, "5199");
    assert.equal(data.legacy, null);
    assert.equal(data.policy, "dev");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
