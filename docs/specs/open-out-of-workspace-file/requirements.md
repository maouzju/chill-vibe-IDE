# 打开项目外文件 — 需求

## 背景与问题

用户报告（2026-08-14）：

> 如果 IDE 里的项目的 agent 改动了项目外的文件，那么点击之后是无法显示内容的。

复现路径：会话里的 agent（Claude / Codex）修改了工作区根目录之外的文件（另一个仓库、
`D:\tools\x.ps1`、跨盘符路径等），改动卡里照常列出该文件，点击后开出 TextEditor tab，
但内容区是错误态而不是文件内容。

## 根因（2026-08-14 定位）

责任链断在两侧的假设不一致：

- 渲染侧 `src/components/structured-file-paths.ts:162` `resolveOpenableFilePath` **故意放行**
  工作区外的绝对路径，注释明写「server-side workspace/agent-home whitelist is the final gate」。
- 服务端 `server/file-system.ts:140` `ensureWithinWorkspace` 的白名单只有三个根：
  `workspacePath`、`~/.claude`、`~/.codex`。任何别的项目外路径直接 `throw new Error('Path traversal is not allowed.')`。
- `src/components/text-editor-load-failure.ts:9` 的友好化只匹配 ENOENT，
  于是这句**原始英文** `Path traversal is not allowed.` 被原样丢给用户，看起来像「打不开 / 没内容」。

即：渲染侧把闸门交给服务端，服务端的闸门从来没有为这个场景开过。

## 需求

### R1 — 桌面端点击项目外文件能看到内容

- agent 改动卡 / changes summary / 工具卡 / 正文文件引用里的**项目外绝对路径**，
  在 Electron 桌面端点击后必须开出编辑器并显示真实文件内容。
- 覆盖读、写（编辑保存）、剪贴板复制、磁盘变更监听四条既有能力，不出现「能看不能存」的半残状态。

### R2 — 不扩大网络暴露面

- 放行**只对 Electron 桌面 IPC 通道**（`desktop:*`，仅本机渲染进程可达）生效。
- HTTP 路由（`POST /api/files/read` 等）的可访问范围**一个字节都不放宽**。
  依据：`server/index.ts:115` 主 Express 默认绑 `127.0.0.1`，但 `HOST` 环境变量可覆盖为 `0.0.0.0`；
  手机远程监工是独立 server 且绑 `0.0.0.0`（`server/remote-monitor.ts:506`），
  只暴露 `/api/actions`、`/api/snapshot`、`/api/history`、`/api/events`，本来就没有文件读取能力 —— 这条边界必须保持。

### R3 — 相对路径的逃逸仍然是攻击，必须继续拒绝

- 放行只针对**绝对路径**（agent 结构化输出给的就是绝对 OS 路径）。
- `../../etc/passwd` 这类相对路径逃逸、以及工作区内指向外部的 symlink / junction，
  在任何通道下都保持拒绝，现有回归测试不得放松。

### R4 — 被拒绝时说人话

- 仍然会被拒绝的场景（浏览器/HTTP 模式），错误提示不能是裸英文 `Path traversal is not allowed.`，
  要给出本地化的「该文件不在可访问范围内」说明。

### R5 — 项目外文件的相邻能力优雅降级

- Git gutter diff 对项目外文件（不在本仓库里）不得报错阻断编辑器，只是没有 diff。
- tab 标题、编辑器缓存 key、行号定位对绝对路径不得出现错标签或串文件。

## 非目标

- 不放开**目录浏览**：`listFiles` / `searchWorkspaceFiles` 维持工作区内，
  文件树不应能翻遍全盘（没有需求，且是最大的信息泄露面）。
- 不做「项目外文件只读」模式。agent 已经能改这些文件，用户在 IDE 里改同一个文件是同等权限，
  额外做只读态反而制造「打开了却存不了」的新困惑。
- 不做跨会话的项目外路径持久白名单（见 design.md 的方案取舍）。

## 验收

- 红先单测：`ensureWithinWorkspace` / `readWorkspaceFile` 在 opt-in 下放行项目外绝对路径，
  默认（HTTP 语义）仍拒绝；相对路径逃逸与 symlink 逃逸在两种模式下都拒绝。
- `pnpm test:quality` 通过。
- 打包后在真实 Electron 里点开一个项目外文件，能看到内容并能保存。
