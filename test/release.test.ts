import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nextVersion, updateReadme } from "../scripts/release.mjs";

test("release increments the highest local or published stable version", () => {
  assert.equal(nextVersion("0.0.1", undefined), "0.0.2");
  assert.equal(nextVersion("0.0.1", "0.0.9"), "0.0.10");
  assert.equal(nextVersion("1.2.0", "0.9.9"), "1.2.1");
  assert.throws(() => nextVersion("1.0.0-beta.1", undefined), /stable/);
});

test("release updates the managed README section and preserves other content and CRLF", () => {
  const input = "before\r\n<!-- release:start -->\r\nold\r\n<!-- release:end -->\r\nafter\r\n";
  const result = updateReadme(input, "@agent-dev-net/weixin-bridge", "0.0.2");
  assert.match(result, /npm install -g @agent-dev-net\/weixin-bridge@0\.0\.2/);
  assert.ok(result.startsWith("before\r\n"));
  assert.ok(result.endsWith("after\r\n"));
  assert.equal(updateReadme(result, "@agent-dev-net/weixin-bridge", "0.0.2"), result);
  assert.throws(() => updateReadme("no markers", "name", "0.0.2"), /markers/);
});


test("release CLI synchronizes package, lockfile and both READMEs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@agent-dev-net/weixin-bridge", version: "0.0.1" }));
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
    name: "old", version: "0.0.1", packages: { "": { name: "old", version: "0.0.1" } }
  }));
  for (const name of ["README.md", "README.en.md"]) {
    fs.writeFileSync(path.join(root, name), "intro\n<!-- release:start -->\n<!-- release:end -->\n");
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/release.mjs", import.meta.url)), "--set", "0.0.8"], {
    cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" }
  });
  assert.equal(result.status, 0, result.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.version, "0.0.8");
  assert.equal(lock.version, "0.0.8");
  assert.deepEqual(lock.packages[""], { name: "@agent-dev-net/weixin-bridge", version: "0.0.8" });
  for (const name of ["README.md", "README.en.md"]) {
    assert.match(fs.readFileSync(path.join(root, name), "utf8"), /npm install -g @agent-dev-net\/weixin-bridge@0\.0\.8/);
  }
});

test("publication verification waits for real package metadata and a downloadable tarball", async () => {
  const { waitForPublication } = await import("../scripts/verify-publication.mjs");
  let attempts = 0;
  await waitForPublication("@agent-dev-net/weixin-bridge", "0.0.2", {
    attempts: 3, delayMs: 0,
    fetch: async (_url: string, options?: RequestInit) => {
      if (options?.method === "HEAD") return new Response(null, { status: 200 });
      attempts++;
      if (attempts === 1) return new Response(null, { status: 404 });
      if (attempts === 2) return Response.json({ version: "0.0.0-stage", stub: true });
      return Response.json({ name: "@agent-dev-net/weixin-bridge", version: "0.0.2", dist: {
        tarball: "https://registry.npmjs.org/@agent-dev-net/weixin-bridge/-/weixin-bridge-0.0.2.tgz"
      } });
    }
  });
  assert.equal(attempts, 3);
});

test("publication verification fails when registry only exposes a placeholder", async () => {
  const { waitForPublication } = await import("../scripts/verify-publication.mjs");
  await assert.rejects(waitForPublication("@agent-dev-net/weixin-bridge", "0.0.2", {
    attempts: 2, delayMs: 0,
    fetch: async () => Response.json({ name: "@agent-dev-net/weixin-bridge", version: "0.0.0-stage", stub: true })
  }), /not publicly available/);
});
