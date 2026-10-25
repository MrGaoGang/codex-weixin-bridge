import assert from "node:assert/strict";
import test from "node:test";

import { parseServerCommand, serverHelpText } from "../src/server/arguments.js";

test("server arguments do not start the service for help", () => {
  assert.equal(parseServerCommand([]), "start");
  assert.equal(parseServerCommand(["restart"]), "restart");
  assert.equal(parseServerCommand(["--help"]), "help");
  assert.equal(parseServerCommand(["-h"]), "help");
  assert.match(serverHelpText(), /without starting the service/);
  assert.match(serverHelpText(), /restart/);
});

test("server arguments reject unknown values", () => {
  assert.throws(() => parseServerCommand(["--unknown"]), /Unknown argument/);
});
