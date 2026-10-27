import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
const fn = source.slice(source.indexOf("async function waitForUpdatedService("), source.indexOf("\nfunction resetUpdateDialog("));
function setup(fetch: (url: string, options: any) => Promise<any>, fastTimeout = false) {
  let now = 0;
  const state: Record<string, string> = {};
  const context = vm.createContext({ state, fetch, AbortController, setTimeout: fastTimeout ? (callback: () => void) => setTimeout(callback, 5) : setTimeout, clearTimeout,
    Date: { now: () => now }, UPDATE_RECONNECT_TIMEOUT_MS: 3000,
    delay: async () => { now += 1000; }, setUpdateProgress: () => {} });
  vm.runInContext(fn, context);
  return { state, run: () => vm.runInContext('waitForUpdatedService("2.0.0", "old")', context) };
}

test("update polling uses bounded lightweight requests and waits for the new process", async () => {
  let calls = 0;
  const f = setup(async (url, options) => {
    assert.equal(url, "/api/runtime-status");
    assert.ok(options.signal);
    assert.equal(options.cache, "no-store");
    calls += 1;
    if (calls === 1) throw new Error("restart connection refused");
    return { ok: true, json: async () => ({ version: "2.0.0", requestToken: calls === 2 ? "old" : "new" }) };
  });
  assert.equal(await f.run(), "ready");
  assert.equal(calls, 3);
  assert.equal(f.state.requestToken, "new");
});
test("expired login after restart requests a login reload", async () => {
  const f = setup(async () => ({ status: 401 }));
  assert.equal(await f.run(), "login");
});
test("unavailable service ends with a useful timeout instead of polling forever", async () => {
  const f = setup(async () => { throw new Error("offline"); });
  await assert.rejects(f.run(), /手动重启/);
});

test("a hung polling request is aborted and the next request can detect completion", async () => {
  let calls = 0;
  const f = setup(async (_url, options) => {
    calls += 1;
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("request timed out")), { once: true });
      });
    }
    return { ok: true, json: async () => ({ version: "2.0.0", requestToken: "new" }) };
  }, true);
  assert.equal(await f.run(), "ready");
  assert.equal(calls, 2);
});
