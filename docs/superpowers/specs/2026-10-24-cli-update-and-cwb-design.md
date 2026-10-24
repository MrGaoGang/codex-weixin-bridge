# CLI update 命令与 cwb 别名

## 目标

提供 `codex-weixin update` 和等价的 `cwb update` 命令，将已安装的桥接 npm 包更新到最新稳定版，并让服务在更新后运行。`cwb` 与 `codex-weixin` 使用同一 CLI 实现和参数。

## 方案与选择

- **复用现有 UpdateManager（选定）**：沿用 npm registry 校验、稳定版比较、目标 runtime 验证和跨平台安装流程。更新已存在时先停止服务，安装后以当前命令目录和环境重新启动；服务原本停止时也会在更新后启动。若已是最新版，不重复安装；已有服务继续运行，已停止的服务启动。
- **运行通用 `npm update`**：会更新依赖树而非确认桥接包自身最新稳定版，不能复用现有 runtime 验证与注册表回退逻辑，因此不选。

## 行为与约束

- `update` 检查 `@agent-dev-net/weixin-bridge` 的 npm latest 稳定版；不更新所有传递依赖，也不更新 Git 源码 checkout。
- 在停止服务前检查 runtime 类型与可用更新；源码运行时返回清晰的 Git 更新说明，不影响正在运行的服务。
- 有更新时通过 `stopService` 正常停止已有服务，再用 `UpdateManager.installLatest()` 更新并验证 runtime，最后用命令启动目录、`.env` 和进程环境启动服务。
- 安装失败时，若服务更新前正在运行，尽力使用安装目录中的当前文件重新启动；报告安装错误及恢复结果。npm 安装失败后不能保证旧版本文件完整，因此这是尽力恢复运行，不承诺回滚到旧版本。
- 命令帮助和中英文 README 均列出 `update` 与 `cwb`。
- npm `bin` 同时提供 `codex-weixin`、`cwb`，指向同一个入口。
