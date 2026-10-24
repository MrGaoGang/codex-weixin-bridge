import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseServerCommand, serverHelpText } from "../src/server/arguments.js";

test("server arguments do not start the service for help", () => {
  assert.equal(parseServerCommand([]), "start");
  assert.equal(parseServerCommand(["restart"]), "restart");
  assert.equal(parseServerCommand(["stop"]), "stop");
  assert.equal(parseServerCommand(["update"]), "update");
  assert.equal(parseServerCommand(["--foreground"]), "foreground");
  assert.equal(parseServerCommand(["--help"]), "help");
  assert.equal(parseServerCommand(["-h"]), "help");
  assert.match(serverHelpText(), /without starting the service/);
  assert.match(serverHelpText(), /restart/);
  assert.match(serverHelpText(), /update/);
  assert.match(serverHelpText(), /cwb/);
});

test("server arguments reject unknown values", () => {
  assert.throws(() => parseServerCommand(["--unknown"]), /Unknown argument/);
});

test("codex-weixin and cwb npm bins use the same CLI entry", () => {
  const packageJson = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    bin: Record<string, string>;
  };
  assert.equal(packageJson.bin["codex-weixin"], "dist/server/index.js");
  assert.equal(packageJson.bin.cwb, packageJson.bin["codex-weixin"]);
});
