# Chill Vibe IDE

[English](#english) | [简体中文](#zh-cn)

<a id="english"></a>

## English

Chill Vibe is a desktop app for running many AI coding agents across many projects in one window.
It drives the `codex`, `claude`, and `gemini` CLIs you already have installed, lays every project out as a column and every task as a chat card, and keeps long-running agents working while you are away.

It replaces the habit of opening five Cursor or VS Code windows and Alt-Tabbing between them.

### Download

- Grab the latest Windows zip from [Releases](https://github.com/maouzju/chill-vibe-IDE/releases/latest), unzip, and run `Chill Vibe.exe`.
- The app checks GitHub Releases and updates itself in place. Your data lives outside the app folder, so updating does not wipe it.
- Official builds are Windows-only today. Other platforms can run from source (see [Develop](#develop)).
- You need at least one of the `codex`, `claude`, or `gemini` CLIs on `PATH`. Settings shows the detected CLI versions and can update them.

### What It Does

**1. All projects on one board**

- One column per project, one card per task; cards stream side by side.
- Split panes and tabs inside a column, drag and drop everywhere, resizable columns and cards.
- Tuck a project into the top bar when you do not need it; the chip still shows whether its agents are running or have unread results.
- Session history per workspace, with search, restore, and archive.

**2. Any model, same conversation**

- Codex, Claude, and Gemini cards in the same board, each with its own model and reasoning-effort setting.
- Switch provider or model mid-conversation: context moves with the task, and switching back resumes the original native session.
- Fork a conversation from any message.
- Per-card context usage meter; the app runs `/compact` before your next message when the window is nearly full (threshold is configurable).
- Claude plan mode, Ultracode (multi-agent workflows), slash commands, and skills shared across providers.

**3. Agents that keep working without you**

- **Auto-urge**: when an agent stops early, the app sends a follow-up for you until a success keyword appears. A local Ollama model can judge completion instead of a keyword.
- **Wake timer**: write a message now, send it when other agents finish, when the tab on the left finishes, when chosen sessions finish, or after a set time.
- **Deferred send**: right-click send to queue a message for after the current turn.
- **Repeat loop**: rerun the first prompt in a new tab, N times or until you stop it.
- **Automation board**: a kanban of requirements with lanes; dropping an item into the running lane starts an agent. A built-in supervisor template reviews finished work, urges stalled agents, and moves items to done.
- **Admin mode**: a session can read and operate the other sessions in its workspace.
- **Mobile monitor**: scan a QR code to watch progress, send or stop work, start sessions, and switch models from your phone.
- **Recovery**: API errors, relay hiccups, and stalled streams are retried and resumed automatically. After an app restart or crash, interrupted sessions, sub-agents, and Workflow runs pick up where they left off.
- Completion sounds per agent, per workspace, or when everything is done.

**4. See what agents are doing**

- Commands, file edits, todos, reasoning, and questions show up as structured blocks in the chat instead of raw terminal output.
- A sub-agent panel shows each sub-agent's status and runtime; Workflow runs show their progress.
- Agent questions render as clickable choice cards.
- A stats card tracks token usage, cost, and activity by day.

**5. Guardrails**

- Destructive-command protection (on by default) blocks high-risk deletion and destructive Git operations for all providers.
- Optional: block writes outside the project folder, stop the session on attack-shaped output, isolate the Codex agent home.
- Opt-in tools for agents: browser control (Playwright MCP), Windows desktop control (Windows-MCP), and JEV quick judgments.

**6. Bring your own endpoint**

- Multiple API profiles per provider (base URL + key), drag to reorder, switch with one click.
- Or use your official subscription login instead of an API key.
- Local models through Ollama (one-click install from Settings) and custom cloud endpoints such as DeepSeek, attached to the Codex or Claude harness.
- New models on your endpoint are detected and offered once; the model menu is customizable.
- Custom system prompt, plus per-model prompt rules.

**7. Tool cards**

- Git: status, diff, staging, sync, and AI-written commits. Sync conflicts open a visible session that resolves them.
- Files, text editor, image viewer/editor, sticky notes, stats, automation board.
- Experimental and off by default: brainstorm, music, white noise, weather.

**8. Look and feel**

- Light, dark, system, or custom theme with your own base and accent colors.
- UI scale, font family, font size, and line height.
- English and Simplified Chinese.
- Close to tray, taskbar, or quit.

### How To Use

1. Add a column and point it at a project folder.
2. In Settings → API, add a profile (base URL + key) or choose subscription login.
3. Open a card, pick a model and reasoning effort, and send a prompt.
4. Open more cards or columns and run them in parallel.

### Develop

Requirements: Node.js 20+, pnpm, and at least one provider CLI on `PATH`.

```bash
pnpm install
pnpm dev                        # Electron dev runtime
pnpm build && pnpm start        # local production-mode run
pnpm electron:build             # zip package
pnpm electron:build:installer   # optional NSIS installer
```

Stack: React 19, TypeScript, Vite, Express 5, Electron, Zod, Playwright.

Verification:

- `pnpm test:quality` runs ESLint and the TypeScript checks.
- `pnpm test` runs the Node unit tests, isolated per file.
- `pnpm test:playwright` runs the default Playwright smoke suite in headless mode.
- `pnpm test:playwright:full` runs the full Playwright browser-flow regression suite in headless mode.
- `pnpm test:theme` runs the Playwright theme and board-layout regression checks through the repo harness in headless mode.
- `pnpm test:perf` runs the browser-performance smoke slice in headless mode: long-chat compaction logic, layout memoization safeguards, and the add-card freeze regression.
- `pnpm test:perf:electron` runs the hidden-window Electron responsiveness smoke for desktop-only performance issues.
- `pnpm test:electron` runs the hidden-window Electron runtime and release responsiveness suite once.
- `pnpm test:risk` runs lint, type checks, Node tests, the Playwright smoke suite, and Electron runtime checks.
- `pnpm test:release` runs resumable exact-tree release verification with per-stage logs, including a bounded 30-second multi-stream Electron chat performance gate after the production build.
- `pnpm test:full` remains a compatibility alias for `pnpm test:release`.
- `pnpm legal:check` checks that the third-party dependency inventory is current.

`localhost:5173` in dev is the Electron renderer dev server; Chill Vibe has no separate browser product. `pnpm dev:restart` restarts the dev runtime.

Contributors and coding agents must read [AGENTS.md](./AGENTS.md) first. See also [CONTRIBUTING.md](./CONTRIBUTING.md).

### Local Data

```text
Development:          <repo>/.chill-vibe/
Packaged desktop app: Electron userData/data
```

Set `CHILL_VIBE_DATA_DIR` to move it. If you run from a repo checkout, doing so keeps API keys and chat history out of your source tree.

Stored locally: layout, chat history, provider session IDs, API profiles (base URLs and keys), settings, and data for experimental features (music cookies, cached ambient audio).

### Security And Privacy

- The desktop app talks to its backend over Electron IPC; there is no browser-exposed HTTP API.
- Agents run local CLI tools in the workspace you choose and inherit your shell environment.
- State stays on your machine. The app does not upload it.
- The mobile monitor is off by default. When on, it listens on your LAN and its link token grants control of your sessions. Use it on trusted networks only and stop it afterwards.
- Browser control and desktop control are off by default. They act as you, in your logged-in browser and with your real mouse and keyboard.
- Experimental features call third-party services directly (weather, music, ambient audio downloads).

More: [SECURITY.md](./SECURITY.md), [PRIVACY.md](./PRIVACY.md)

### Docs

- [Why Chill Vibe works (Chinese product essay)](./docs/marketing/why-chill-vibe-works.md)
- [Design notes](./docs/design.md)
- [UI principles](./docs/ui-principles.md)
- [Feature specs](./docs/specs)
- [Contributor and agent rules](./AGENTS.md)

### Open Source Notes

- License: [MIT](./LICENSE)
- Third-party services and assets are listed in [THIRD_PARTY.md](./THIRD_PARTY.md); the generated dependency inventory is in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md). Packaged builds carry both under `resources/legal/`.
- Music and other experimental integrations are for local learning only. You are responsible for upstream terms, copyright, and local law.
- Ambient audio samples are downloaded on demand and cached locally, not bundled.
- If you expose any part of the app beyond your own machine, add your own authentication and network hardening first.

<a id="zh-cn"></a>

## 简体中文

Chill Vibe 是一个桌面应用，用来在一个窗口里同时跑多个项目的多个 AI 编程 Agent。
它直接驱动你本机装好的 `codex`、`claude`、`gemini` CLI：一个项目一列，一个任务一张聊天卡，长任务在你离开电脑时也能接着跑。

它要替掉的做法是：开五个 Cursor 或 VS Code 窗口，然后 Alt-Tab 来回切。

### 下载

- 到 [Releases](https://github.com/maouzju/chill-vibe-IDE/releases/latest) 下载最新的 Windows zip，解压后运行 `Chill Vibe.exe`。
- 应用会检查 GitHub Releases 并原地自动更新。数据不放在应用文件夹里，更新不会清掉。
- 官方包目前只有 Windows。其他平台可以从源码运行（见[开发](#开发)）。
- `PATH` 里至少要有 `codex`、`claude`、`gemini` 其中一个 CLI。设置里能看到检测到的 CLI 版本，也能直接更新。

### 能做什么

**1. 所有项目在一张看板上**

- 一个项目一列，一个任务一张卡，多张卡并排流式输出。
- 列内可分屏、开 tab，列和卡都能拖拽、调宽调高。
- 暂时不看的项目可以收到顶栏；收起后的小标签仍会显示它的 Agent 在不在跑、有没有未读结果。
- 每个工作区有历史会话，可搜索、恢复、归档。

**2. 模型随便换，对话不重来**

- Codex、Claude、Gemini 的卡可以放在同一张看板里，每张卡单独选模型和思考档位。
- 对话中途换 Provider 或模型：上下文跟着任务走，切回去时接上原来的原生会话。
- 可以从任意一条消息分叉出新会话。
- 每张卡显示上下文占用；快满时在下一条消息发出前自动先 `/compact`（阈值可调）。
- 支持 Claude 计划模式、Ultracode（多 Agent 工作流）、斜杠命令，Skill 可跨 Provider 复用。

**3. 不用守着的 Agent**

- **自动鞭策**：Agent 提前停下时自动替你追问，直到回复里出现成功触发词。也可以让本地 Ollama 模型来判断任务是否做完。
- **计划唤醒**：先把消息写好，等其他 Agent 完成、左侧 Tab 完成、指定会话完成，或到了指定时长再发出去。
- **延后发送**：右键点发送，消息排到当前这轮结束后再发。
- **循环重复**：任务完成后新开 Tab 重跑首条提示，可设次数，也可一直跑到手动取消。
- **自动化看板**：按泳道管理需求，把需求拖进执行泳道就会启动一个 Agent。内置的「看板监工」模板会检查交付、催促停滞的 Agent、把做完的移到已完成列。
- **超管模式**：让一个会话能查看和操作本工作区的其他会话。
- **手机监工**：扫码后在手机上看进度、发需求、停任务、新建会话、换模型。
- **断线续传**：API 报错、中转站抽风、输出卡住时自动重试并续上。应用重启或崩溃后，被打断的会话、子 Agent 和 Workflow 会从断点接着跑。
- 完成提示音：单个 Agent 完成、单个工作区完成、全部完成，三档可分别开关。

**4. 看得见 Agent 在干什么**

- 命令、文件改动、待办、思考过程、提问都以结构化块显示在聊天里，不用翻终端输出。
- 子 Agent 面板显示每个子 Agent 的状态和已运行时长，Workflow 显示进度。
- Agent 的提问渲染成可点选的选项卡。
- 统计卡按天查看 token 用量、费用和活跃情况。

**5. 防护**

- 破坏性命令防护默认开启，对所有 Provider 拦截高风险删除和破坏性 Git 操作。
- 可选：禁止修改项目文件夹外的文件、检测到疑似攻击形状时中断会话、Codex Agent 使用隔离主目录。
- 需要手动开启的 Agent 能力：操作浏览器（Playwright MCP）、操控 Windows 桌面（Windows-MCP）、JEV 快速判断。

**6. 用自己的接口**

- 每个 Provider 可配多套 API 配置（地址 + key），可拖拽排序，一键切换。
- 也可以不填 key，直接用官方会员登录。
- 本地模型走 Ollama（设置里一键安装），还可以接 DeepSeek 这类自定义云端接口，挂在 Codex 或 Claude 的运行框架上。
- 接口上出现新模型时会提示一次，可一键加入；模型下拉菜单可以自己增删。
- 可自定义系统提示词，并按模型配置提示词规则。

**7. 工具卡**

- Git：状态、差异、暂存、同步、AI 写提交信息。同步冲突会新开一个可见会话来解决。
- 文件树、文本编辑器、图片查看/编辑、便签、统计、自动化看板。
- 实验性功能，默认关闭：Brainstorm、音乐、白噪音、天气。

**8. 外观**

- 浅色、深色、跟随系统、自定义主题（背景色和主题色自选）。
- 界面缩放、字体、字号、行高可调。
- 界面语言：简体中文、English。
- 点关闭按钮时可选退出、最小化到任务栏或缩到系统托盘。

### 使用方式

1. 新增一列，选一个项目文件夹。
2. 在 设置 → API 里添加一套配置（地址 + key），或选择官方会员登录。
3. 打开一张卡，选模型和思考档位，发送需求。
4. 再开几张卡或几列，让它们同时跑。

### 开发

环境要求：Node.js 20+、pnpm，`PATH` 里至少有一个 Provider CLI。

```bash
pnpm install
pnpm dev                        # Electron 开发运行
pnpm build && pnpm start        # 本地生产模式运行
pnpm electron:build             # 打 zip 包
pnpm electron:build:installer   # 可选：NSIS 安装器
```

技术栈：React 19、TypeScript、Vite、Express 5、Electron、Zod、Playwright。

验证命令：

- `pnpm test:quality` 运行 ESLint 和 TypeScript 检查。
- `pnpm test` 运行 Node 单元测试，按文件隔离。
- `pnpm test:playwright` 运行默认 Playwright smoke 回归测试。
- `pnpm test:playwright:full` 运行完整的 Playwright 浏览器流程回归测试。
- `pnpm test:theme` 运行主题与看板布局的视觉回归检查。
- `pnpm test:perf` 运行浏览器性能 smoke；`pnpm test:perf:electron` 运行 Electron 桌面端响应性 smoke。
- `pnpm test:electron` 运行隐藏窗口的 Electron 运行时测试。
- `pnpm test:risk` 运行 lint、类型检查、Node 测试、Playwright smoke 套件和 Electron 运行时检查。
- `pnpm test:release` 按工作区精确指纹运行可恢复的发布校验，并为每个阶段保存日志；生产构建后还会运行有界的 30 秒 Electron 多流聊天性能门禁。
- `pnpm test:full` 保留为 `pnpm test:release` 的兼容别名。
- `pnpm legal:check` 检查第三方依赖清单是否最新。

开发时的 `localhost:5173` 是 Electron 的 renderer dev server，Chill Vibe 没有单独的浏览器版。`pnpm dev:restart` 重启开发运行时。

贡献者和编码 Agent 请先读 [AGENTS.md](./AGENTS.md)，另见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

### 本地数据

```text
开发态：        <repo>/.chill-vibe/
打包桌面应用：  Electron userData/data
```

可用 `CHILL_VIBE_DATA_DIR` 改位置。从仓库 checkout 直接运行时建议设置它，免得 API key 和聊天历史落在源码目录旁边。

本地保存的内容：布局、聊天历史、Provider 会话 ID、API 配置（地址和 key）、设置，以及实验性功能的数据（音乐登录 cookie、缓存的环境音频）。

### 安全与隐私

- 桌面应用通过 Electron IPC 访问后端，没有暴露给浏览器的 HTTP API。
- Agent 会在你指定的工作区里运行本地 CLI 工具，并继承当前 shell 的环境变量。
- 状态保存在你的机器上，应用不会上传。
- 手机监工默认关闭。开启后监听局域网，拿到链接里的令牌就能操作你的会话。只在可信网络里用，用完停掉。
- 操作浏览器和操控桌面默认关闭。开启后 Agent 以你的身份操作已登录的浏览器，动的是真实的鼠标键盘。
- 实验性功能会直接请求第三方服务（天气、音乐、环境音频下载）。

更多说明：[SECURITY.md](./SECURITY.md)、[PRIVACY.md](./PRIVACY.md)

### 文档

- [为什么 Chill Vibe 好用](./docs/marketing/why-chill-vibe-works.md)
- [设计说明](./docs/design.md)
- [UI 原则](./docs/ui-principles.md)
- [功能规格](./docs/specs)
- [贡献与 Agent 规则](./AGENTS.md)

### 开源说明

- 许可证：[MIT](./LICENSE)
- 用到的第三方服务和资源见 [THIRD_PARTY.md](./THIRD_PARTY.md)，生成的依赖清单见 [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)。打包后的应用把这两份带在 `resources/legal/` 下。
- 音乐等实验性集成仅供本地学习。上游服务条款、版权和当地法律是否允许，需要你自己确认。
- 环境音频样本按需下载并缓存在本地，不随仓库分发。
- 如果要把应用的任何部分暴露到本机之外，请先自行加上认证和网络加固。
