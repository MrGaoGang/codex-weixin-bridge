# app-server 回退释放线程锁实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** app-server 失败后，exec 恢复同一受管线程前先释放 app-server 的线程写入锁。

**Architecture:** `AppServerCodexRunner` 增加可等待子进程退出的关闭方法。`HybridCodexRunner` 在自动回退前 await 该方法，再用新实例替换已关闭的 runner；这样后续请求仍可启动 app-server。

**Tech Stack:** TypeScript、Node.js child processes、`node:test`。

**Spec:** `docs/superpowers/specs/2026-10-24-app-server-fallback-lock-design.md`

## Global Constraints

- 任何实际从 app-server 回退到 exec 的路径都先关闭并等待进程退出，包括 `auto` 和 `exec` 配置下的流式请求；`app-server` 后端继续抛出原错误。
- exec 恢复原线程前必须等待 app-server 子进程退出。
- 若其他 app-server run 正在执行，不关闭共享进程并直接抛出本次原始错误，保留其他 run。
- 后续请求仍可重新启动 app-server。
- 不改线程状态格式、用户命令或消息协议。

## Review Focus

- app-server 已在失败时自行退出：关闭流程应完成，不可永久等待。测试：关闭方法也覆盖子进程已经退出的情况。
- app-server 的 turn 仍未完成便触发回退：关闭需终止该进程后才启动 exec。测试：exec fixture 确认 app-server PID 已退出后才完成。
- 后续请求复用 Hybrid runner：确认 runner 被替换后可以再次启动。测试：回退后再次调用 app-server 成功。
- `app-server` 专用模式不得执行 exec。测试：原 app-server 错误直接抛出且没有 exec 标记。
- 初始化失败时也需保证锁释放后再回退。测试：close promise 在 app-server 启动时绑定，即使当前 child 已清空也继续等待。
- 一个 session 失败时其他 session 正在运行：不能中断它。测试：失败请求返回 app-server 错误，hold turn 完成后重试才回退。

---

### Task 1: 顺序关闭 app-server 并自动回退

**Files:**
- Modify: `src/codex/app-server-runner.ts`
- Modify: `src/codex/runner.ts`
- Modify: `test/codex-app-server.test.ts`
- Create: `test/fixtures/fake-codex-lock-conflict.mjs`

**Interfaces:**
- `AppServerCodexRunner.closeAndWait(): Promise<boolean>`：活跃 run 非零时返回 `false` 且不关闭；空闲时关闭 runner、等待已启动子进程的 `close` 事件并返回 `true`。
- `HybridCodexRunner` 持有可替换的 app-server runner；私有 factory 创建 runner 时沿用相同配置。

- [x] **Step 1: 写失败测试**

在 `test/codex-app-server.test.ts` 新增 `auto backend waits for app-server exit before exec fallback resumes the thread`，以及 `a failed turn does not close app-server while another turn is active`。fake app-server 对指定线程在 `turn/start` 返回错误并记录自身 PID；fake exec 确认该 PID 已退出后才返回成功。断言单独失败时 fallback 等待进程退出，存在其他活跃 turn 时先保留进程、完成其余 turn 后重试再回退。

- [x] **Step 2: 确认测试按预期失败**

运行：`node --test --import tsx test/codex-app-server.test.ts`

预期：新测试失败，显示 exec 在 app-server 子进程退出前尝试恢复线程。

- [x] **Step 3: 增加等待关闭接口**

在 `src/codex/app-server-runner.ts` 记录活跃 `run` 数，并于 spawn 时保存 child 的 `close` promise。实现 `closeAndWait(): Promise<boolean>`：活跃 `run` 非零时返回 `false`；空闲时调用现有 `close()`，再等待 close promise 并返回 `true`；未启动过子进程时立即返回 `true`。

- [x] **Step 4: 自动回退前关闭并替换 runner**

在 `src/codex/runner.ts` 将 app-server runner 改为可替换字段，抽取沿用构造参数的私有 factory。所有实际回退路径先 await 当前 runner 的 `closeAndWait()`；返回 `false` 时重抛原错误，返回 `true` 时替换为新 runner 并调用 exec。`app-server` 专用路径保持直接抛错。

- [x] **Step 5: 验证回退回归测试**

运行：`node --test --import tsx test/codex-app-server.test.ts`

预期：新顺序及并发保护测试、既有 auto fallback、app-server 专用模式和生命周期测试均通过。

- [x] **Step 6: 验证项目测试与类型检查**

运行：`npm test` 和 `npm run typecheck`

预期：所有测试和 TypeScript 类型检查通过。
