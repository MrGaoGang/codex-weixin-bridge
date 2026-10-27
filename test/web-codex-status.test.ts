import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = fs.readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('async function loadCodexStatus()'), source.indexOf('\nasync function checkForUpdate()'));

test('background detection announces loading and preserves current model and effort edits', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => { resolve = done; });
  const state: any = { config: {}, codexChecking: false };
  const nodes: any = { '#modelInput': { value: 'edited-model' }, '#effortInput': { value: 'high' }, '#effectiveModelValue': {}, '#effectiveEffortValue': {} };
  let selected: unknown[] = [];
  const context = vm.createContext({ state, AbortController, setTimeout, clearTimeout,
    api: async () => pending, renderMetrics() {},
    document: { querySelector: (key: string) => nodes[key] },
    renderModelOptions: (...values: unknown[]) => { selected = values; },
    selectedSession() {}, renderSessionRuntimeControls() {}, toast() {} });
  vm.runInContext(fn, context);
  const work = vm.runInContext('loadCodexStatus()', context);
  assert.equal(state.codexChecking, true);
  resolve({ codex: { ready: true }, codexRuntime: { model: 'runtime-model' }, codexModels: [] });
  await work;
  assert.equal(state.codexChecking, false);
  assert.equal(state.codex.ready, true);
  assert.deepEqual(selected, ['edited-model', 'high']);
});
