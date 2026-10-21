<h1 align="center">codex-weixin</h1>

<!-- release:start -->
[![npm version](https://img.shields.io/npm/v/%40agent-dev-net%2Fweixin-bridge)](https://www.npmjs.com/package/@agent-dev-net/weixin-bridge)

**npm: @agent-dev-net/weixin-bridge@0.0.13**

```bash
npm install -g @agent-dev-net/weixin-bridge@0.0.13
codex-weixin
```
<!-- release:end -->

<p align="center">
  <img src="docs/images/codex-weixin-logo.png" alt="codex-weixin logo" width="128" height="128" />
</p>

<p align="center">
  <a href="./README.md">中文</a> | <strong>English</strong>
</p>

<p align="center">
  <strong>Connect multiple personal WeChat accounts to a local OpenAI Codex installation.</strong>
</p>

`codex-weixin` is a cross-platform, local-only WeChat service dedicated to Codex. Starting it opens a Web management page where users scan a WeChat QR code, manage accounts and workspaces, and switch Codex sessions.

```text
Multiple WeChat accounts <-> codex-weixin <-> local Codex <-> allowed workspaces
```

It is not a general messaging gateway. The management page is never exposed to the LAN or public Internet.

## Feature status

Screenshots live under `docs/images/screenshots/`. The Web management screenshot is included; rows that require a phone view reserve stable filenames for later WeChat captures.

| Status | Feature | Details | Screenshot |
| --- | --- | --- | --- |
| ✅ | Local Web management | A page bound to `127.0.0.1` by default manages WeChat accounts, sessions, workspaces, and Codex settings. | [Web sessions](docs/images/screenshots/web-session-management.png) |
| ✅ | Multiple WeChat accounts | One service runs multiple accounts with local remarks and isolated authorization, attachments, and sessions; account removal can retain history. | [Web sessions](docs/images/screenshots/web-session-management.png) |
| ✅ | Browser QR connection | Shows waiting, scanned, connected, and expired QR states. | Pending: `docs/images/screenshots/wechat-qr-login.png` |
| ✅ | Session management | Grouped account tabs, Markdown history, continued Codex threads, and create, rename, activate, reset, and delete actions. | [Web sessions](docs/images/screenshots/web-session-management.png) |
| ✅ | Web text and attachments | Send text with up to 10 files (100 MiB total), with media playback, preview, and download in history. | Pending: `docs/images/screenshots/web-attachments.png` |
| ✅ | WeChat private-chat control | Supports regular messages plus `/status`, `/new`, `/resume`, `/bind`, `/model`, `/effort`, `/prompt start`, `/prompt done`, and `/stop`. | Pending: `docs/images/screenshots/wechat-chat.png` |
| ✅ | WeChat media input | Accepts transcribed voice, images, audio, video, and files up to 100 MiB each, with a direct notice when the limit is exceeded. | Pending: `docs/images/screenshots/wechat-media-input.png` |
| ✅ | File delivery to WeChat | Codex can return local images, videos, and files as native WeChat messages. | Pending: `docs/images/screenshots/wechat-media-output.png` |
| ✅ | Models and reasoning effort | Model-aware dropdowns loaded from app-server, including GPT-5.6 Sol, Terra, and Luna for IkunCoding. | Pending: `docs/images/screenshots/web-model-settings.png` |
| ✅ | Process progress | Enabled by default; Codex progress reaches WeChat immediately and appears in a collapsible Web timeline with elapsed time, while final answers stay intact. | Pending: `docs/images/screenshots/web-process-progress.png` |
| ✅ | Typing state and deduplication | Web typing state plus persistent sync cursors and message IDs prevent duplicate replies. | Pending: `docs/images/screenshots/wechat-typing.png` |
| ✅ | App-server first | New and resumed sessions prefer Codex app-server V2 and fall back to `codex exec` when unavailable. | Pending: `docs/images/screenshots/wechat-status.png` |
| ✅ | Web auto-update | Selects npm or npmmirror, updates the active npm runtime, verifies it, then restarts and reconnects. | Pending: `docs/images/screenshots/web-auto-update.png` |

## Web management preview

<p align="center">
  <img src="docs/images/screenshots/web-session-management.png" alt="codex-weixin Web session management" width="100%" />
</p>

## Requirements

- Node.js `>=22`
- Git
- An installed and authenticated Codex CLI

```bash
npm install -g @openai/codex
codex --version
codex
```

## Install and start

Install globally from npm:

```bash
npm install -g @agent-dev-net/weixin-bridge
codex-weixin
```

Or install from source:

```bash
git clone https://github.com/MrGaoGang/codex-weixin-bridge.git
cd codex-weixin-bridge
npm install
npm run build
npm install -g .
codex-weixin
```

The service opens [http://127.0.0.1:8787](http://127.0.0.1:8787). To run without a global install:

```bash
npm start
```

## First connection

1. Open Settings and confirm the default and allowed Codex workspaces.
2. Select Add WeChat, scan the QR code, and confirm in WeChat.
3. Send any message to the connected account.
4. Return to WeChat Accounts and allow the pending sender.
5. Send the message again to start a Codex turn.

Repeat the QR flow to add more accounts. Every account has its own monitor, sender authorization, inbound directory, and managed-session state. A failed account does not stop the others. Scanning the same WeChat account again after an expired login refreshes the existing credentials while preserving its local remark, authorization, and sessions instead of creating an empty duplicate. Account removal can retain history: credentials are deleted immediately, while a later scan by the same WeChat user restores the previous remark, authorization, and managed sessions.

## Session management

The Sessions page manages conversations created and used by this server. It does not scan or take ownership of every Codex conversation created in other terminals.

Selecting a session reads its user messages and final replies from Codex's own persisted thread. The controls below the chat title select a model, reasoning effort, and process-progress behavior for the current session or keep inheriting global settings; they share the same session configuration used by the WeChat `/model`, `/effort`, and `/stream` commands. Process progress is enabled by default, appears in a collapsible Web timeline with elapsed time, and leaves the final answer as one stable response. The Web composer can submit text and multiple files as one turn and continues that same thread, so context remains shared with later WeChat messages. Uploads are isolated by account and session under `~/.codex-weixin/inbound/`, with at most 10 files and 100 MiB total per turn.

The UI uses local remarks instead of treating internal IDs as account names. Expand “Account IDs” on an account card to inspect its iLink Bot ID and User ID; Codex thread IDs remain hidden from the regular UI. Each account can have a local remark edited from the WeChat Accounts page; the remark is reused by session tabs, with `WeChat Account 1` used only as a fallback. The current QR and messaging APIs do not expose WeChat nicknames, avatars, or a profile lookup endpoint, so the page uses a default icon.

- Each authorized WeChat account has one active session and may own multiple named sessions.
- Activate chooses which Codex thread receives the sender's next message.
- Reset clears the recorded thread so the next message starts fresh context.
- Delete removes only the bridge record, not Codex's own history files.
- `/new` creates a new managed session for the current sender.
- `/resume` lists this sender's sessions with recent prompt summaries, timestamps, and distinct `R1`, `R2` selection codes; `/resume R1` switches back to the selected Codex thread without confusing the code with a title such as `Session 6`.

## WeChat commands

```text
/help                         Show commands
/status                       Show session, workspace, thread, backend, effective model, and reasoning effort
/bind <absolute-path>          Bind to an allowed workspace
/new                          Create a new managed Codex session
/resume                       List historical sessions with recent prompt summaries
/resume R<number>             Continue a session by its distinct R selection code
/model                        Show the current and available models
/model <number|model|default>  Switch this session's model or restore inheritance
/effort                       Show reasoning efforts supported by the current model
/effort <number|level|default> Switch this session's effort or restore inheritance
/stream                       Show this session's process-progress setting
/stream <on|off|default>       Enable, disable, or restore global process progress
/prompt start                 Buffer multiple WeChat messages
/prompt done                  Submit the buffer as one Codex turn
/stop                         Interrupt the current Codex task
```

Regular messages enter the active session. Images, files, videos, and voice/audio without transcription are saved under the account's inbound directory and added to the prompt by local path. WeChat voice transcription is preferred when available.

## Sending local files

Codex can request local-file delivery in its final response:

````text
```codex-weixin-actions
{
  "send": [
    { "type": "image", "path": "/absolute/path/chart.png" },
    { "type": "video", "path": "/absolute/path/demo.mp4" },
    { "type": "file", "path": "/absolute/path/report.pdf" }
  ]
}
```
````

Only absolute local paths are accepted. Native outbound types are `image`, `video`, and `file`; audio is sent as a regular file. Remote URLs are not uploaded as local files.

## Codex backend

The default `codexBackend` is `auto`. On the first Codex message, the service starts one persistent `codex app-server --stdio` process and uses the current `initialize`, `thread/*`, and `turn/*` protocol. New and resumed conversations prefer app-server; startup, handshake, or request failures automatically fall back to `codex exec` or `codex exec resume`.

WeChat does not currently expose Codex approval prompts, so app-server uses `approvalPolicy: "never"` and operates only within the configured Codex sandbox instead of waiting for an approval that cannot be answered in WeChat. The management page can still pin the backend to `app-server` or `exec` for diagnostics.

## Models and reasoning effort

The Settings page loads available models and model-specific reasoning efforts from Codex app-server. Leaving a field on "Use Codex settings" preserves the Codex configuration; choosing and saving an explicit value applies it to later Web and WeChat turns.

Send `/model` or `/effort` in WeChat to get a numbered list, then switch by number or exact ID. A WeChat-side selection applies only to the active managed session, without affecting other accounts, senders, or sessions. `/model default` and `/effort default` restore inheritance from Web/Codex settings. Continuing that session from the Web page uses the same session overrides.

The IkunCoding provider also exposes `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. These options remain available after switching to another model in both the Web dropdown and WeChat `/model` list. Send `/status` in WeChat to inspect the effective model and reasoning effort.

## Local data

Service state and the default Codex workspace share this directory:

```text
~/.codex-weixin/
  accounts/                 One credential file per WeChat account
  retained-accounts.json    Recovery index for removed accounts; never stores tokens
  runtime/<account-id>/     Sender authorization and managed sessions
  inbound/<account-id>/     Inbound WeChat attachments
  config.json               Codex and workspace configuration
  logs/
```

Do not commit or share this directory. The management API never returns WeChat tokens to the browser.

## Startup settings

The server binds to `127.0.0.1` by default. Environment variables can configure its bind address, allowed hosts, port and state directory:

```text
CODEX_WEIXIN_HOST=127.0.0.1
CODEX_WEIXIN_PORT=8787
CODEX_WEIXIN_USERNAME=admin
CODEX_WEIXIN_PASSWORD=replace-with-your-password
CODEX_WEIXIN_STATE_DIR=/absolute/private/path
CODEX_WEIXIN_OPEN=0
```

### Ubuntu remote access

Use Node.js 22 or newer. In the project directory:

```bash
npm ci
npm run build
CODEX_WEIXIN_HOST=0.0.0.0 \
CODEX_WEIXIN_ALLOWED_HOSTS=YOUR_SERVER_IP \
CODEX_WEIXIN_PORT=8787 \
CODEX_WEIXIN_OPEN=0 npm start
```

Open `http://YOUR_SERVER_IP:8787`. Allowed hosts are comma-separated IPs or hostnames without schemes, ports or paths. A specific bind IP is automatically allowed. For public IPs mapped through NAT, bind to `0.0.0.0` and explicitly allow the public IP. `0.0.0.0` is a bind address, not a browser destination.

Allow TCP 8787 in the Ubuntu firewall and cloud security group only from trusted IPs. Set both `CODEX_WEIXIN_USERNAME` and `CODEX_WEIXIN_PASSWORD` to enable the browser login prompt. Unauthenticated or incorrect credentials receive `401` for pages, assets and all APIs. Setting only one variable or using an empty value prevents startup; leaving both unset preserves access without login. Usernames cannot contain colons, and credentials cannot contain control characters. Export variables before starting; `.env` files are not loaded automatically. HTTP Basic credentials are not encrypted over HTTP; use an HTTPS reverse proxy for public access. The temporary request token still protects mutations. Configure Codex CLI, credentials and workspaces on the server.

## Security model

- Only explicitly allowed hosts are accepted; remote mutations require a matching HTTP Origin and the temporary request token.
- Every mutating API call requires an in-memory page token.
- WeChat credentials never reach the management page.
- Unknown senders are denied until explicitly allowed.
- `/bind` accepts only absolute paths under the workspace allowlist.
- `danger-full-access` bypasses the Codex filesystem sandbox and must be enabled only when full-machine access is acceptable.
- Concurrent accounts share local compute resources and Codex quotas.

## Automatic npm publishing

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) publishes on every push to `main` and supports manual runs. It type-checks and tests, increments the higher of the local and npm `latest` stable versions by one patch, packs the triggering commit, publishes `@agent-dev-net/weixin-bridge` publicly, then commits version metadata and both README release sections to the latest `main`. The CLI command remains `codex-weixin`.

Runs are serialized with up to 100 pending runs. Bot commits use `GITHUB_TOKEN` and do not retrigger this workflow. After public version metadata and tarball availability are verified, the workflow creates a version tag and GitHub Release with generated notes and the npm `.tgz` archive. Placeholder versions and processing states do not count as verified publication. A failed publish does not update Git metadata; if publishing succeeds but the metadata push fails, the workflow fails visibly and the next release uses npm's version to avoid collisions.

Setup:

1. Ensure your npm account can publish under the `@agent-dev-net` scope. Owning this GitHub repository does not grant npm scope access.
2. For the first publish, add an Actions secret named `NPM_TOKEN` containing a granular npm token with package/scope write access and permission for non-interactive direct publishing.
3. Prefer [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) after creating the package: configure GitHub Actions with owner `MrGaoGang`, repository `codex-weixin-bridge`, workflow filename `publish.yml`, publishing allowed, and no environment. Set the Actions variable `NPM_AUTH_MODE=oidc`, then remove `NPM_TOKEN`. The default mode is `token`; an early check rejects missing tokens and verifies authentication before building.
4. Allow Actions to write repository contents. The workflow declares `contents: write`; branch protections/rulesets must also permit metadata commits to `main`.

Use `npm pack --dry-run` to inspect the package without publishing. Actual publishing starts only after this workflow is committed and pushed to GitHub.

## Development

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

The project is a clean-room independent implementation under the MIT License. Its iLink integration shape references `Tencent/openclaw-weixin`, along with public Codex/WeChat projects for app-server, media-transfer, and security-boundary practices. No AGPL source code was copied.

When started from a source checkout with `npm run dev` or `npm start`, the Web page checks for updates but does not install them; update the Git checkout and rebuild instead. Global installations and isolated `node_modules/@agent-dev-net/weixin-bridge` runtimes update the npm prefix that owns the active package and verify the target version and service entry before restarting. On Windows, the updater first releases any process working-directory lock inside the package tree so npm can replace it without `EBUSY`.

See [CHANGELOG.md](./CHANGELOG.md) for release history.
