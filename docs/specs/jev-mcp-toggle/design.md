# Design: JEV 快速判断 MCP

照 `docs/specs/computer-use-toggle/design.md` 的同一形态（pitfall #383）。

## 数据

- `AppSettings.jevEnabled: boolean`（默认 false）、`AppSettings.jevApiKey: string`（默认 ''）、`AppSettings.jevApiUrl: string`（默认 ''，恢复时 trim）。
- `ChatRequest.jevEnabled?: boolean`、`ChatRequest.jevApiUrl?: string`：只在开关打开时由 `buildCodexChatRequestOverrides` 带上（两条 provider 分支都带）。**key 不进请求**；地址为空时由服务端按 key 自动选择，非空时作为完整 JEV 请求地址。

## 服务端

- `server/jev-runtime.ts` `createJevRuntime(request, deps)`：
  - `request.jevEnabled !== true` → `null`。
  - 从 `loadState().settings.jevApiKey` 读 key；空 → warn + `null`。
  - key 写到 `<dataDir>/jev/api-key`（内容变了才写，0600），env `CHILL_VIBE_JEV_KEY_FILE` 指向它；env `CHILL_VIBE_JEV_ROOT` = 工作区；非空 `jevApiUrl` 通过 `CHILL_VIBE_JEV_URL` 传给 MCP。
- jev_ask 的每个显式路径先做 realpath 与工作区边界校验，拒绝 ..、绝对工作区外路径和符号链接逃逸；目录遍历中的文件也复用同一校验。
  - 返回 `{ codexRuntimeArgs, claudeMcpConfig, instruction }`，命令为 `process.execPath server/jev-mcp.js`（Electron 下 `ELECTRON_RUN_AS_NODE=1`）。
- `server/providers.ts`：`launchProviderRun` 与 computer use 并列计算；Codex 追加 `-c` 与指令；Claude 把 JEV 的 `mcpServers` 合并进已有的 `computerUseMcpConfig` 槽位一起传（不新增一整条参数链）；keepalive 签名加 `jev`。

## MCP：`server/jev-mcp.js`

- 换行分帧 stdio（不是 Content-Length），入口守卫（pitfall 211）。
- 工具 `jev_ask`：
  - 输入 `questions`（`{id:{type:'noul'|'choice'|'score', instructions, criteria?}}`）+ `paths`（文件/目录，相对工作区；跳过 node_modules/.git/dist 等与二进制/超大文件）和/或 `texts`；可选 `extensions`、`threshold`（默认 0.6）。
  - 每个文件/文本一次请求（state 截断到 60000 字符），并发 8，最多 300 项。
  - 服务方：key 以 `sk-or-` 开头走 OpenRouter `/api/alpha/decisions` + `typesafe/jev-1.13`，否则 TypeSafe `/v1/systemone` + `jev-latest`；`CHILL_VIBE_JEV_URL` 非空时覆盖默认 endpoint，按当前 JEV state/questions 协议直接请求，不自动拼接路径。429/5xx 退避重试 2 次；401/402/403 立刻整体报 key 失效。
  - 输出精简 JSON（参考 JevMCP，MIT）：noul → `0.93`，不确定 `[0.55,"?"]`；choice/score → `[value, conf]`，不确定再附 top-2 概率；另给 `unsure` 列表与 `errors`。

## 上下文预算

- 系统提示追加一句（约 60 个汉字）；工具描述 3 句；Codex 版多半句「先 tool_search」。