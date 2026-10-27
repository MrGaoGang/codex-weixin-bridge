import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BridgeService } from '../src/bridge/service.js';
import { defaultConfig } from '../src/state/config.js';
import { resolveStatePaths } from '../src/state/paths.js';
import { RuntimeStateStore } from '../src/state/runtime-state.js';
import { buildPrompt } from '../src/bridge/format.js';
import { buildTopicSummary, estimateContextTokens, isTopicCandidate, automaticSessionTextHistory } from '../src/bridge/automatic-session.js';
import { buildCodexExecArgs } from '../src/codex/exec-runner.js';

function fixture(t: { after(fn: () => Promise<void>): void }, mode: 'off' | 'topic' | 'context-length', classification = 'new', userMessageCount = 4) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-auto-session-'));
  const store = new RuntimeStateStore(resolveStatePaths(path.join(directory, 'state')));
  const source = store.createSession('alice', directory);
  store.setSessionThread(source.id, 'original-thread');
  store.updateSessionRuntime(source.id, { model: 'test-model', effort: 'low', streamReplies: false });
  const runs: Array<{ threadId?: string; prompt: string; model?: string }> = [];
  const isolated: Array<{ prompt: string; cwd: string; model?: string }> = [];
  let historyReads = 0;
  let failReply = false;
  const service = new BridgeService({
    config: { ...defaultConfig(directory), allowedSenderIds: ['alice'], automaticSessionMode: mode, automaticSessionContextTokens: 1 },
    stateStore: store,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        if (failReply && input.text === 'done') throw new Error('send failed');
      }
    } as never,
    runner: {
      async getHistory() { historyReads += 1; return Array.from({ length: userMessageCount }, (_, index) => ({ id: `old-${index}`, role: 'user', text: 'Earlier software discussion' })); },
      async run(input: { threadId?: string; prompt: string; model?: string }) {
        runs.push(input);
        return { text: 'done', raw: '', threadId: input.threadId ?? 'new-thread' };
      },
      async runIsolated(input: { prompt: string; cwd: string; model?: string }) {
        isolated.push(input);
        if (classification === 'error') throw new Error('classifier unavailable');
        return { text: JSON.stringify({ decision: classification }) };
      }
    } as never
  });
  t.after(async () => { await service.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const send = (text: string) => service.handleMessage({ id: String(Date.now()), senderId: 'alice', text, attachments: [], raw: {} });
  return { store, source, runs, isolated, send, historyReads: () => historyReads, failReply: (value: boolean) => { failReply = value; } };
}

test('automatic management defaults off and does not read history', async (t) => {
  assert.equal(defaultConfig().automaticSessionMode, 'off');
  assert.equal(defaultConfig().automaticSessionContextTokens, 500000);
  const f = fixture(t, 'off');
  await f.send('A different topic');
  assert.equal(f.historyReads(), 0);
  assert.equal(f.runs[0].threadId, 'original-thread');
  assert.equal(f.store.listSessions().length, 1);
});

test('context split waits for confirmation and preserves queued messages and model overrides', async (t) => {
  const f = fixture(t, 'context-length');
  await f.send('first message');
  await f.send('second message');
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.listSessions().length, 1);
  await f.send('确认');
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].threadId, undefined);
  assert.match(f.runs[0].prompt, /first message/);
  assert.match(f.runs[0].prompt, /second message/);
  assert.equal(f.runs[0].model, 'test-model');
  assert.equal(f.store.getActiveSession('alice')?.threadId, 'new-thread');
  assert.equal(f.store.getSession(f.source.id)?.threadId, 'original-thread');
  assert.equal(f.store.getPendingSessionSplit('alice'), undefined);
});

test('rejecting a context split keeps the original thread and suppresses repeated threshold prompts', async (t) => {
  const f = fixture(t, 'context-length');
  await f.send('first message');
  await f.send('取消');
  await f.send('continue original conversation');
  assert.equal(f.runs.length, 2);
  assert.ok(f.runs.every((run) => run.threadId === 'original-thread'));
  assert.equal(f.store.getPendingSessionSplit('alice'), undefined);
  assert.equal(f.store.listSessions().length, 1);
});

test('topic decisions use isolated execution and do not create a session before confirmation', async (t) => {
  const f = fixture(t, 'topic');
  await f.send('另外，询问一个完全不同的话题');
  assert.equal(f.isolated.length, 1);
  assert.equal(f.isolated[0].cwd, os.tmpdir());
  assert.equal(f.isolated[0].model, 'test-model');
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.listSessions().length, 1);
  await f.send('确认');
  assert.equal(f.store.listSessions().length, 2);
});

test('a failed reply after a completed pending task does not execute the task again', async (t) => {
  const f = fixture(t, 'context-length');
  await f.send('perform a task');
  f.failReply(true);
  await assert.rejects(f.send('确认'), /send failed/);
  assert.equal(f.runs.length, 1);
  assert.equal(f.store.getPendingSessionSplit('alice')?.processedItemCount, 1);
  f.failReply(false);
  await f.send('确认');
  assert.equal(f.runs.length, 1);
  assert.equal(f.store.getPendingSessionSplit('alice'), undefined);
});

test('topic summaries exclude bridge instructions and attachment paths; isolated arguments cannot resume a thread', () => {
  const text = buildPrompt('讨论天气', [{ kind: 'image', label: 'photo.jpg', path: '/private/photos/photo.jpg' }]);
  const summary = buildTopicSummary([{ id: 'one', role: 'user', text }]);
  assert.match(summary, /讨论天气/);
  assert.doesNotMatch(summary, /WeChat bridge rule|private\/photos/);
  assert.ok(buildCodexExecArgs({ prompt: 'classify', cwd: os.tmpdir(), ephemeral: true, sandbox: 'read-only' }).includes('--ephemeral'));
  assert.throws(() => buildCodexExecArgs({ prompt: 'classify', cwd: os.tmpdir(), ephemeral: true, threadId: 'original' }), /cannot resume/);
});


test('an expired split returns the held message to the original thread and ignores a late confirmation', async (t) => {
  const f = fixture(t, 'context-length');
  await f.send('held message');
  const pending = f.store.getPendingSessionSplit('alice')!;
  pending.expiresAt = Date.now() - 1;
  f.store.setPendingSessionSplit(pending);
  await f.send('确认');
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].threadId, 'original-thread');
  assert.equal(f.store.listSessions().length, 1);
  assert.equal(f.store.getPendingSessionSplit('alice'), undefined);
});

for (const decision of ['uncertain', 'error']) {
  test(`classifier ${decision} continues the incoming message in the original session`, async (t) => {
    const f = fixture(t, 'topic', decision);
    await f.send('另外，询问一个完全不同的话题');
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0].threadId, 'original-thread');
    assert.equal(f.store.listSessions().length, 1);
    assert.equal(f.store.getPendingSessionSplit('alice'), undefined);
  });
}

test('confirmation is scoped to the sender and pending batches survive a state reload', async (t) => {
  const f = fixture(t, 'off');
  const bob = f.store.createSession('bob', f.source.workspace);
  f.store.setPendingSessionSplit({ senderId: 'bob', sourceSessionId: bob.id, reason: 'topic', items: [{ kind: 'text', text: 'Bobs held prompt' }], expiresAt: Date.now() + 600000 });
  await f.send('确认');
  assert.equal(f.store.getActiveSession('alice')?.id, f.source.id);
  assert.equal(f.store.listSessions().length, 2);
  assert.equal(f.store.getPendingSessionSplit('bob')?.items.length, 1);
  const reloaded = new RuntimeStateStore(resolveStatePaths(path.join(f.source.workspace, 'state')));
  assert.equal(reloaded.getPendingSessionSplit('bob')?.sourceSessionId, bob.id);
});

for (const historyCount of [0, 1, 3, 4]) {
  test(`topic classification requires five user messages including incoming (history: ${historyCount})`, async (t) => {
    const f = fixture(t, 'topic', 'new', historyCount);
    await f.send('另外，询问一个完全不同的话题');
    assert.equal(f.isolated.length, historyCount >= 4 ? 1 : 0);
    assert.equal(f.runs.length, historyCount >= 4 ? 0 : 1);
  });
}

for (const kind of ['image', 'video', 'file', 'audio'] as const) {
  test(`${kind} attachments do not contribute to context estimates or topic summaries`, () => {
    const attachment = { kind, label: 'unrelated-attachment', path: '/private/attachment' };
    const history = [{ id: 'media', role: 'user', text: buildPrompt('', [attachment]) }];
    assert.equal(estimateContextTokens(history, [attachment]), 0);
    assert.equal(estimateContextTokens([{ ...history[0], text: buildPrompt('天气', [attachment]) }], [attachment]), 2);
    assert.equal(buildTopicSummary(history), '');
    assert.equal(isTopicCandidate(history, '询问完全不同的事情'), false);
  });
}

test('attachment-only history does not count toward the five user text messages', () => {
  const attachment = { kind: 'image' as const, label: 'photo', path: '/private/photo' };
  const history = Array.from({ length: 10 }, (_, index) => ({ id: String(index), role: 'user', text: buildPrompt('', [attachment]) }));
  history.push({ id: 'text', role: 'user', text: buildPrompt('用户文字', [attachment]) });
  assert.deepEqual(automaticSessionTextHistory(history).map((item) => item.text), ['用户文字']);
});

const explicitTopicSwitches = ['新话题', '新会话', '新对话', '新聊天', '换个会话', '换个对话', '另开会话', '另起话题', '重新开始'];
for (const message of explicitTopicSwitches) {
  test(`explicit switch phrase enters classification and still requires confirmation: ${message}`, async (t) => {
    const f = fixture(t, 'topic');
    await f.send(message);
    assert.equal(f.isolated.length, 1);
    assert.equal(f.runs.length, 0);
    assert.equal(f.store.listSessions().length, 1);
    assert.ok(f.store.getPendingSessionSplit('alice'));
  });
}

test('explicit topic phrases still respect the five-message gate and disabled mode', async (t) => {
  for (const message of ['新话题', '新会话']) {
    for (const mode of ['off', 'topic'] as const) {
      const f = fixture(t, mode, 'new', 3);
      await f.send(message);
      assert.equal(f.isolated.length, 0);
      assert.equal(f.runs.length, 1);
    }
  }
});

test('short continuation messages still skip topic classification', () => {
  const history = [{ id: 'old', role: 'user', text: '修改网站界面' }];
  for (const message of ['好的', '继续', '确认', '取消']) assert.equal(isTopicCandidate(history, message), false);
});
