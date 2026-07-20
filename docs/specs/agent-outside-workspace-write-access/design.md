# Agent 项目外写入权限设计

## 1. 数据模型与兼容

在 `AppSettings` 和 `ChatRequest` 增加：

```ts
agentOutsideWorkspaceWriteEnabled: boolean
```

默认值为 `true`。`createDefaultSettings()`、`appStateSchema` 默认对象和
`normalizeAppSettings()` 同步补齐；旧状态缺字段时回落为开启，显式 `false` 原样保留。

现有 `shared/codex-chat-settings.ts` 继续作为 Agent 请求设置的集中映射点，新增字段同时透传给 Codex 与 Claude。显式请求级 `sandboxMode` 仍优先于全局设置，确保 Brainstorm / Git Agent 的 `read-only` 不被放宽。

## 2. 设置 UI

在现有“Agent 安全防护”设置卡最上方增加普通 `settings-toggle`：

- 标签：允许 Agent 修改项目文件夹外的文件；
- 默认勾选；
- 说明强调开启只代表 Chill Vibe 允许并请求该权限，Codex、Claude、组织或机器级策略仍可继续收紧；关闭后 Codex 使用工作区沙箱，Claude 在支持平台使用官方 sandbox，原生 Windows 使用 IDE 防护兜底且不是完整 OS 沙箱。

弹出设置面板与完整设置页继续复用 `renderCodexSafetySettings()`，主题快照中的开关数量从 2 增至 3，不增加新的视觉结构或颜色。

## 3. Codex 权限映射

`getCodexSandboxMode(request)` 按以下顺序解析：

1. 请求显式 `sandboxMode`；
2. `agentOutsideWorkspaceWriteEnabled === false` 时为 `workspace-write`；
3. 否则为 `danger-full-access`。

因此 exec 参数、app-server `thread/start` / `thread/resume` 和 `turn/start.sandboxPolicy` 自动共用同一结果。既有 requirements 冲突恢复继续只会收窄，不会写回用户设置。

开关表达的是 Chill Vibe 的请求上限，而不是绕过 Provider 或系统管理策略的能力。若 Codex `requirements` 拒绝 `danger-full-access`，既有兼容恢复仍按允许范围降级到 `workspace-write` 或 `read-only`，并保留普通日志提示。

## 4. 共享 Agent 安全 Hook

保留现有 launcher 与 `server/codex-destructive-command-guard.js` 文件，避免破坏 Codex Hook 信任键；把运行条件从“仅高风险删除防护开启”调整为：

```text
codexDestructiveCommandProtectionEnabled === true
OR agentOutsideWorkspaceWriteEnabled === false
```

子进程环境新增两个显式布尔标志，防护脚本按功能独立判定：

- 高风险删除防护开关；
- 项目外写入开关。

Hook matcher 扩展为 `Bash|apply_patch|Edit|Write|NotebookEdit`。文件工具从 `file_path`、`path`、`notebook_path` 等标准字段读取目标：相对路径以受保护 `workspacePath` 解析，绝对路径直接规范化；已有祖先使用 `realpath`，从而阻止 symlink/junction 把项目内表面路径导向项目外。

当项目外写入关闭时：

- 项目内直接文件写入允许；
- 项目外或无法安全解析的直接写入拒绝；
- shell 层补充识别重定向、PowerShell 内容写入/复制/移动、新建，以及常见 POSIX/cmd 写入命令的目标；确定目标在项目外时拒绝；
- 既有递归删除判定继续由独立高风险删除开关控制。

Hook 本身解析异常继续使用退出码 `2` 失败关闭。

## 5. Claude 官方 sandbox

`buildClaudeArgs()` 接收可测试的平台参数。项目外写入关闭且平台不是原生 Windows时，在 session-level `--settings` 增加：

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "network": { "allowedDomains": ["*"] },
    "filesystem": { "denyWrite": ["<项目外额外读取目录>"] }
  }
}
```

Claude sandbox 默认只允许工作目录和会话临时目录写入。现有 `--add-dir` 仍用于读取 `.claude`、`.codex` 和附件目录；凡不位于项目内的额外目录同步进入 `denyWrite`，避免“为读取授权”意外变成可写授权。网络通配允许保持本设置只控制文件写入，不改变现有联网能力。

原生 Windows 不注入不受支持的 Claude sandbox，依赖共享 Hook 的直接文件路径校验和常见 shell 写入拦截。UI 和文档明确该平台限制。

## 6. Claude keepalive 与错误

keepalive signature 增加 `agentOutsideWorkspaceWriteEnabled`，并继续包含完整运行环境、Hook 命令和 `--settings` 派生参数。切换设置后签名变化，旧进程被回收。

项目边界要求 Hook 时，Hook 准备失败按 `env-setup` 返回；Claude 官方 sandbox 配置使用 `failIfUnavailable: true`，避免 macOS/Linux/WSL2 静默裸跑。

## 7. 验证

1. 默认状态、旧状态迁移和显式关闭测试；
2. 请求映射测试：Codex / Claude 都透传，显式 `read-only` 不被放宽；
3. Codex exec 与 app-server 测试：关闭后得到 `workspace-write`；
4. Hook 红绿测试：项目内 Write 允许，项目外/`..`/真实路径逃逸拒绝，高风险删除开关与边界开关互相独立；
5. Claude 参数测试：支持平台注入严格 sandbox，额外读取目录进入 `denyWrite`；Windows 不注入不支持的 sandbox；Hook matcher 和 keepalive signature 随设置变化；
6. 设置卡双主题快照更新并人工审查；
7. 目标 Node 测试、`pnpm test:quality`、`pnpm test:theme`；
8. `pnpm electron:build`；
9. `pnpm dev:restart` 并检查当前 Electron 开发运行时。
