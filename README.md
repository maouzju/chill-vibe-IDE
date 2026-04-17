# Chill Vibe IDE

[English](#english) | [简体中文](#zh-cn)

<a id="english"></a>

## English

### Overview

Chill Vibe is an IDE for parallel vibe coding across multiple projects.
It is built for solo developers working across multiple projects, and for workflows that frequently interact with AI knowledge bases, information-retrieval systems, and other chat-first tools.
Chill Vibe keeps multiple workspaces running side-by-side in the same view so agent chats across projects stay visible, comparable, and actionable.

### Design Philosophy

Chill Vibe is intentionally opinionated:

- simple by default
- AI-first interaction instead of IDE ceremony
- minimal setup and straightforward configuration
- no permission theater unless it solves a real problem
- no pre-AI legacy baggage unless it clearly earns its place

The goal is not to simulate a traditional IDE with an AI tab attached.
The goal is to make AI chat the primary working surface, with low-friction configuration and room to scale across multiple projects at once.

### Product Direction

Chill Vibe is aiming at a lighter alternative to VS Code for AI-heavy workflows:

- faster to open
- easier to run multiple workspaces side-by-side in one view
- easier to see several projects at once
- better for comparing parallel agent chats and runs across projects
- less panel switching, less nesting, less UI weight

The real competitor is not another AI IDE — it's opening multiple Cursor or VS Code windows and Alt-Tabbing between them. Chill Vibe replaces that with a single view where every project lives side by side.

Current scope is still intentionally narrower than a full traditional IDE. The project is focused on workspace lanes, chat threads, streaming output, local state recovery, and lightweight tool cards such as Git, Files, Editor, Sticky Notes, and ambience tools rather than a full file-edit-debug toolchain.

### Current Features

- board-style multi-column workspace layout
- multiple chat cards per workspace
- local Codex CLI and Claude CLI integration
- streaming output over SSE
- resumable sessions
- drag and drop for columns and cards
- resizable chat cards
- light and dark themes
- local persistence for layout, settings, and session metadata
- Electron desktop runtime with built-in release checks and zip-based handoff builds
- experimental extras: git agent tools, weather overlay, white noise, music, sticky notes

### Tech Stack

- React 19
- TypeScript
- Vite
- Express 5
- Electron
- Zod
- Playwright

### Requirements

- Node.js 20 or newer
- pnpm
- local `codex` CLI and/or local `claude` CLI available on `PATH`

### Quick Start

```bash
pnpm install
pnpm dev
```

Default runtime:

- Electron desktop app

Local production-mode desktop run:

```bash
pnpm build
pnpm start
```

Default desktop package build (zip payload):

```bash
pnpm electron:build
```

Optional installer build:

```bash
pnpm electron:build:installer
```

### How It Works

1. Pick a provider for a column: `Codex` or `Claude`.
2. Set an absolute workspace path for that column.
3. Optionally set a default model for the column.
4. Create one or more cards in that workspace.
5. Send prompts directly from each card and compare results side-by-side.

### Local Data

Application data is stored locally.

Default locations:

```text
Development: <repo>/.chill-vibe/
Packaged desktop app: Electron userData/data
```

In development, Chill Vibe defaults to `.chill-vibe/` under the current repo.
In packaged desktop builds, Chill Vibe defaults to the app's OS-managed Electron `userData` directory instead of the app folder, so replacing or updating the unpacked zip build does not wipe local state.
Set `CHILL_VIBE_DATA_DIR` if you want app state to live somewhere else.

This local data can include:

- workspace layout
- card sizing
- chat history
- provider session IDs
- provider profile settings, including configured base URLs and API keys
- UI settings
- experimental feature data such as music session cookies, playback stats, white-noise scenes, and cached ambient audio

### Security And Privacy

Chill Vibe is designed for local use by default.

- The desktop app talks to its local backend through Electron IPC rather than a browser-exposed HTTP API.
- Chat requests can launch local CLI tools inside the workspace you choose.
- Spawned provider processes inherit your current shell environment.
- State is stored on your machine and is not uploaded by the app itself.
- Some experimental features make direct third-party network requests, such as provider CLIs, weather lookups, music integrations, and on-demand ambient audio downloads.

Read more:

- [SECURITY.md](./SECURITY.md)
- [PRIVACY.md](./PRIVACY.md)

### Scripts

```bash
pnpm dev
pnpm dev:client
pnpm dev:restart
pnpm build
pnpm start
pnpm electron:dev
pnpm electron:build
pnpm electron:build:zip
pnpm electron:build:installer
pnpm electron:build:portable
pnpm legal:generate
pnpm legal:check
pnpm lint
pnpm check
pnpm test
pnpm test:quality
pnpm test:playwright
pnpm test:playwright:full
pnpm test:theme
pnpm test:perf
pnpm test:perf:electron
pnpm test:electron
pnpm test:risk
pnpm test:full
pnpm verify
```

### Verification

- `pnpm legal:check` verifies that the generated third-party dependency inventory is current.
- `pnpm test:quality` runs ESLint and TypeScript checks.
- `pnpm test` runs the automated unit test suite.
- `pnpm test:playwright` runs the default Playwright smoke suite in headless mode.
- `pnpm test:playwright:full` runs the full Playwright browser-flow regression suite in headless mode.
- `pnpm test:theme` runs the Playwright theme and board-layout regression checks through the repo harness in headless mode.
- `pnpm test:perf` runs the browser-performance smoke slice in headless mode: long-chat compaction logic, layout memoization safeguards, and the add-card freeze regression.
- `pnpm test:perf:electron` runs the hidden-window Electron responsiveness smoke for desktop-only performance issues.
- `pnpm test:electron` runs the hidden-window Electron runtime suite.
- `pnpm test:risk` runs lint, type checks, Node tests, the Playwright smoke suite, and Electron runtime checks.
- `pnpm test:full` runs the legal inventory check, lint, type checks, Node tests, the full Playwright suite, Electron runtime checks, and the production build.
- `pnpm verify` runs `pnpm test:full`, including the legal inventory check.

Electron dev note:

- `localhost:5173` is the renderer dev server used by Electron development. It does not mean Chill Vibe ships a separate browser runtime.
- `pnpm dev:restart` restarts the Electron dev runtime for this repo.

### Docs

- [Project plan](./docs/project-plan.md)
- [Design notes](./docs/design.md)
- [Contributor and agent rules](./AGENTS.md)
- [Third-party notes](./THIRD_PARTY.md)
- [Generated dependency inventory](./THIRD_PARTY_LICENSES.md)

### Open Source Notes

- License: [MIT](./LICENSE)
- This repository is suitable for local-first development workflows and experimentation.
- Third-party services and externally hosted sample assets used by optional features are documented in [THIRD_PARTY.md](./THIRD_PARTY.md).
- The generated npm dependency inventory lives in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) and packaged desktop builds carry the legal docs under `resources/legal/`.
- Experimental integrations such as music are provided for local learning and experimentation only. You are responsible for complying with upstream service terms, copyright rules, and local law.
- Sample-based ambient audio is downloaded on demand from third-party sources and cached locally instead of being bundled in this repository.
- If you run Chill Vibe from a repository checkout, consider setting `CHILL_VIBE_DATA_DIR` so API keys, cookies, and chat history are not saved beside your source tree.
- If you plan to expose the server beyond localhost, add your own authentication and network hardening first.

<a id="zh-cn"></a>

## 简体中文

### 项目简介

Chill Vibe 是一个解决并行 vibe coding 多个项目的 IDE。
适合个人开发者 vibe coding 多项目，以及频繁与 AI 知识库、信息获取工作流交互的工作。
Chill Vibe 让多个工作区直接在同一个视图里并排运行，让多个项目的 agent 聊天始终保持可见、可比较、可操作。

### 设计哲学

Chill Vibe 有意保持明确取舍：

- 默认简单
- AI 交互优先，而不是 IDE 仪式感优先
- 配置尽量少，而且要直观
- 没必要就不要装模作样地搞权限戏法
- 没必要就不要背上 AI 时代之前遗留下来的功能包袱

它的目标不是做一个“挂了 AI 标签的传统 IDE”。
它想做的是让 AI 聊天成为主工作界面，同时保持低摩擦配置，并且能自然扩展到多个项目并行运行。

### 产品方向

Chill Vibe 的目标，是成为 AI 高密度工作流里比 VS Code 更轻的一种选择：

- 打开更快
- 更容易在同一视图里并排运行多个工作区
- 更容易同时查看多个项目
- 更适合比较跨项目的并行 agent 聊天和运行结果
- 更少的面板切换、更少的层级、更轻的 UI

真正的竞品不是另一个 AI IDE —— 而是多开 Cursor 或 VS Code 窗口然后 Alt-Tab 来回切。Chill Vibe 把这件事变成一个画面里所有项目并排可见。

当前范围依然有意比传统 IDE 更窄。项目目前聚焦在工作区列、聊天线程、流式输出、本地状态恢复，以及 Git、Files、Editor、便签和氛围工具这类轻量工具卡片，而不是完整的文件编辑、调试和终端工具链。

### 当前功能

- 看板式多列工作区布局
- 每个工作区支持多张聊天卡片
- 本地 Codex CLI 和 Claude CLI 集成
- 基于 SSE 的流式输出
- 可恢复会话
- 列与卡片的拖拽
- 聊天卡片高度可调
- 明暗双主题
- 布局、设置和会话元数据的本地持久化
- Electron 桌面运行时，内置版本检查与基于 zip 的桌面交付构建
- 实验性附加功能：Git agent 工具、天气浮层、白噪音、音乐、便签

### 技术栈

- React 19
- TypeScript
- Vite
- Express 5
- Electron
- Zod
- Playwright

### 环境要求

- Node.js 20 或更高版本
- pnpm
- 本地 `codex` CLI 和/或本地 `claude` CLI，并且可通过 `PATH` 访问

### 快速开始

```bash
pnpm install
pnpm dev
```

默认运行方式：

- Electron 桌面应用

本地生产模式运行：

```bash
pnpm build
pnpm start
```

默认桌面打包（zip 负载）：

```bash
pnpm electron:build
```

如需额外构建安装器：

```bash
pnpm electron:build:installer
```

### 使用方式

1. 为某一列选择 provider：`Codex` 或 `Claude`。
2. 为该列设置一个绝对工作区路径。
3. 可选地给该列设置默认模型。
4. 在这个工作区里创建一张或多张卡片。
5. 直接从每张卡片发送提示词，并横向比较结果。

### 本地数据

应用数据会保存在本地。

默认位置：

```text
开发态：<repo>/.chill-vibe/
打包桌面应用：Electron userData/data
```

开发态默认会落在仓库下的 `.chill-vibe/`。
打包后的桌面应用默认会落在系统管理的 Electron `userData` 目录，而不是应用文件夹本身，所以替换 zip 解压后的应用目录时不会清掉本地状态。
如需改到别的位置，可设置 `CHILL_VIBE_DATA_DIR`。

其中可能包含：

- 工作区布局
- 卡片尺寸
- 聊天历史
- provider 返回的 session ID
- provider 配置，包括 base URL 和 API key
- UI 设置
- 实验性功能相关数据，例如音乐登录 cookie、播放统计、白噪音场景和缓存的环境音频

### 安全与隐私

Chill Vibe 默认按本地使用场景设计。

- 桌面应用通过 Electron IPC 访问本地后端，而不是暴露浏览器可直连的 HTTP API。
- 聊天请求可以在你指定的工作区中启动本地 CLI 工具。
- 启动出来的 provider 子进程会继承当前 shell 环境变量。
- 状态默认保存在你的机器上，不会由应用主动上传。
- 一些实验性功能会直接请求第三方服务，例如 provider CLI、天气查询、音乐集成和按需下载的环境音频。

更多说明：

- [SECURITY.md](./SECURITY.md)
- [PRIVACY.md](./PRIVACY.md)

### 常用脚本

```bash
pnpm dev
pnpm dev:client
pnpm dev:restart
pnpm build
pnpm start
pnpm electron:dev
pnpm electron:build
pnpm electron:build:zip
pnpm electron:build:installer
pnpm electron:build:portable
pnpm legal:generate
pnpm legal:check
pnpm lint
pnpm check
pnpm test
pnpm test:quality
pnpm test:playwright
pnpm test:playwright:full
pnpm test:theme
pnpm test:electron
pnpm test:risk
pnpm test:full
pnpm verify
```

### 验证

- `pnpm test:quality` 运行 ESLint 和 TypeScript 检查。
- `pnpm test` 运行自动化单元测试。
- `pnpm test:playwright` 运行默认 Playwright smoke 回归测试。
- `pnpm test:playwright:full` 运行完整的 Playwright 浏览器流程回归测试。
- `pnpm test:theme` 运行 Playwright 主题回归测试。
- `pnpm test:risk` 运行 lint、类型检查、Node 测试、Playwright smoke 套件和 Electron 运行时检查。
- `pnpm test:full` 运行 legal 清单校验、lint、类型检查、Node 测试、完整 Playwright 套件、Electron 运行时检查和生产构建。
- `pnpm verify` 运行 `pnpm test:full`。

Electron 开发说明：

- `localhost:5173` 是 Electron 开发模式下使用的 renderer dev server，不代表 Chill Vibe 另有一个独立的浏览器产品。
- `pnpm dev:restart` 会重启本仓库的 Electron 开发运行时。

### 文档

- [项目计划](./docs/project-plan.md)
- [设计说明](./docs/design.md)
- [贡献与 Agent 规则](./AGENTS.md)
- [第三方说明](./THIRD_PARTY.md)
- [依赖许可证清单](./THIRD_PARTY_LICENSES.md)

### 开源说明

- 许可证：[MIT](./LICENSE)
- 这个仓库适合用于 local-first 开发工作流和实验用途。
- 音乐等实验性集成仅用于本地学习和实验交流。你需要自行确认上游服务条款、版权要求和所在地区法律是否允许。
- 示例环境音频不会随仓库一起分发，而是在需要时从第三方来源按需下载并缓存到本地。
- 如果你计划把服务暴露到 localhost 之外，请先自行补上认证、传输安全和其他网络加固措施。
