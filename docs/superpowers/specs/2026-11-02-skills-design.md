# Skills 管理

用户确认：直接修改本机 Codex Skill 配置，微信与 Web 共用。

左侧增加 Skills 入口，全部、可用、禁用三个 tab 带数量。每行显示名称、说明、来源、路径和启用开关。沿用现有界面风格；支持刷新、加载、空列表、读取错误和保存错误。

通过现有 app-server 连接调用 skills/list（默认及允许工作目录，forceReload），按路径去重；通过 skills/config/write 持久化开关。使用原生协议比自行扫描/编辑 TOML 更可靠，bridge 私有禁用列表则不符合用户选择。更新接口只接受当前列表中的路径，复用 Host、登录、Origin、请求令牌保护。列表读取失败必须显式报告，不能冒充空列表。
