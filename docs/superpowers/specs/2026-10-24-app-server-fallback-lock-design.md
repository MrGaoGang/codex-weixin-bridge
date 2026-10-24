# app-server 回退时释放线程锁

## 目标

修复自动后端在 app-server 对受管线程报错后，立即由 `codex exec resume` 打开同一线程而触发 `already has an active writer` 的问题。回退仍应保留原线程和连续会话能力。

## 方案

- **保守停止回退**：遇到线程锁冲突时直接返回错误。实现简单，但消息仍失败，需要用户手动换会话或重试。
- **关闭 app-server 后回退（选定）**：app-server 运行失败后，若没有其他活跃 turn，则关闭当前 app-server 子进程并等待退出，再由 exec 恢复原线程。保留自动回退与会话连续性；代价是失败中的 turn 会被终止。
- **新建线程回退**：把请求放到新的 Codex 线程，避免争锁，但会中断原会话上下文，不符合现有连续会话行为。

## 约束与验收

- 对所有会从 app-server 回退到 exec 的路径生效，包括 `auto` 及 `exec` 配置下请求流式输出的情况；明确配置 `app-server` 时仍将错误交给调用方。
- exec 恢复旧线程前，必须确认 app-server 子进程已退出，避免仅发出关闭信号就产生竞态。
- 若其他 session/account 的 app-server turn 正在运行，不关闭共享进程；将本次 app-server 错误交给调用方，避免中断其他 turn。用户重试时，待共享 runner 空闲后再自动回退。
- 服务后续请求仍可重新启动 app-server。
- 测试覆盖：app-server 持有线程期间触发失败，exec 回退只在 app-server 退出后运行；现有不可用时的回退及 app-server 专用模式继续有效。
- 不改线程状态格式、用户命令或消息协议。
