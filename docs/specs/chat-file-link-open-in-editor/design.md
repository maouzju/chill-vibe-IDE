# 技术方案

对应 [`requirements.md`](./requirements.md)。约束沿用 AGENTS.md：共享类型先进 `shared/schema.ts`、状态变更走 `ideReducer`、
主题敏感面加双主题检查、不新增重量级持久化字段。

## 总览

```
助手正文 markdown
  ├─ <a href="src/bar.ts">        ──┐
  └─ <code>src/bar.ts:120</code>  ──┤
                                    ├─→ resolveMessageFileTarget()  (纯函数, 复用 resolveOpenableFilePath)
                                    │      → { openPath, line? } | null
                                    ↓
                        MessageFileOpenContext.open(openPath, { line })
                                    ↓
              ChatCard.openFileCallback → PaneView → WorkspaceColumn → App.openTextEditorTab
                                    ↓
                     addTab(model: TextEditor|ImageEditor, stickyNote: openPath)
                                    ↓
              TextEditorCard 挂载 → consumePendingEditorReveal() → revealLineInCenter
```

已有的 `onOpenFile` 链路（edits 卡片 / 文件树 → `App.tsx:3075 openTextEditorTab`）不重建，
本方案只是把**助手正文**接到同一条链路上，并给它加行号能力。

## M1 — 文件引用识别（新模块 `src/components/message-file-reference.ts`）

纯函数、零依赖，便于 Node 单测。

```ts
parseFileReferenceCandidate(raw: string): { path: string; line?: number } | null
resolveMessageFileTarget(workspacePath, raw): { openPath: string; line?: number } | null
```

**行号后缀**（按顺序尝试，剥离后进入路径判定）：
- `#L120` / `#L120C8`（GitHub 风格，`structured-file-paths.ts:5` 已在解析阶段剥离，这里额外把行号**取出来**）
- `:120` / `:120:8`（编译器 / ripgrep 风格）
- Windows 盘符 `D:` 不能被误当成行号 → 行号分支要求冒号后是纯数字且该冒号不是位置 1 的盘符冒号。

**"像文件路径"判定**（全部满足才可点）：
1. 单行、trim 后非空、长度 ≤ 260。
2. 不含空白字符（路径含空格的场景交给显式 markdown 链接，行内代码不猜）。
3. 不是 URL / 自定义协议（`^[a-z][a-z\d+.-]*:` 且不是 `file:`、不是盘符）。
4. 最后一段必须有扩展名，且扩展名命中白名单 `FILE_REFERENCE_EXTENSIONS`
   （ts/tsx/js/jsx/mjs/cjs/json/md/css/scss/html/py/go/rs/java/kt/rb/php/sh/ps1/bat/yml/yaml/toml/ini/sql/c/h/cpp/hpp/cs/gd/svg/txt/log/xml/lock 等）。
   —— 白名单是防误判的主闸门：`writeFileSync`、`--flag`、`2%`、`v1.5` 全部落选。
5. `resolveOpenableFilePath(workspacePath, path)` 返回非 null。

显式 markdown 链接（R1）**不套 4**（链接是作者显式意图），只需 1/3/5 + 目标看起来不是目录；
目录判定的近似规则：结尾是 `/` 或末段无扩展名 → 判为非文件，回退 reveal。

## M2 — 回调透传：React Context，而不是加参数

`renderMarkdown(content, workspacePath)` 被多处调用，且 `markdownComponentsCache` 按 workspacePath 缓存
组件对象（`chat-card-rendering.tsx:14`）——把回调塞进签名会让缓存失效或需要额外 key。

改用 Context：

- 新增 `src/components/message-file-open-context.ts`：
  `MessageFileOpenContext = createContext<MessageFileOpenHandler | null>(null)`，
  `MessageFileOpenHandler = (relativePath: string, options?: { line?: number }) => void`。
- `ChatCard.tsx` 在消息区外层 `<MessageFileOpenContext.Provider value={openFileCallback}>` 包一次
  （`openFileCallback` 已是稳定引用，`ChatCard.tsx:1696-1699`）。
- markdown 的 `a` / `code` 组件内部 `useContext` 取用。组件对象缓存保持不变。
- Provider 缺席（Playwright 片段渲染、sticky 预览克隆之外的场景）时 Context 为 null，行为自动退回现状。

## M3 — `a` 组件点击分流

改 `handleMessageLinkClick`（`chat-card-rendering.tsx:871`），签名增加 `openFile?: MessageFileOpenHandler`
和 `event.altKey`：

| 条件 | 行为 |
|---|---|
| Alt 键按下 | 走原 `openMessageLocalLink`（资源管理器定位） |
| 本地 href + `resolveMessageFileTarget` 命中 + 有 openFile | `openFile(openPath, { line })` |
| 本地 href 其他情况 | 原 `openMessageLocalLink` |
| 外链 | 原 `openExternalLink` |

顺序很重要：Alt 逃生口在最前，保证 R4 永远可用。

## M4 — `code` 组件（行内代码可点）

react-markdown v10 不再给 `code` 传 `inline`，因此用一个局部 Context 判断是否在 `<pre>` 内：

```tsx
pre: (props) => <InsideCodeBlockContext.Provider value={true}><pre {...props} /></...>
code: (props) => { if (useContext(InsideCodeBlockContext)) return <code {...props} /> ; ...可点判定 }
```

代码块（fenced / indented）**永不可点**——大段代码里满是像路径的 token，点击会变成误触雷区。

可点时渲染：

```tsx
<code className="message-file-reference">
  <button type="button" data-open-file-path={openPath} onClick={...}>{children}</button>
</code>
```

保留外层 `<code>` 以继承既有等宽/背景样式，内层 button 承担交互与无障碍（`aria-label` 复用
`getStructuredLabels(language).openFile`，但正文渲染拿不到 language → 用与结构化卡片一致的中英双语常量，
由 Context 一并提供 language；若 Context 缺席则退回不可点）。

## M5 — 行号定位：模块级一次性 registry，不进持久化

新增 `src/components/text-editor-reveal.ts`：

```ts
setPendingEditorReveal(workspacePath, filePath, line): void
consumePendingEditorReveal(workspacePath, filePath): number | null   // 取出即删
```

- key 与 `text-editor-model-cache.ts` 同构：`${workspacePath}\0${filePath}`。
- `App.openTextEditorTab(columnId, paneId, relativePath, title, line?)`：有 line 时先 `setPendingEditorReveal`，再 `addTab`。
- `TextEditorCard` 首次内容就绪后 `consumePendingEditorReveal` → `editor.revealLineInCenter(line)` + `setPosition`。
- **为什么不进 card schema**：行号是一次性导航意图，不该被持久化后在重启时重新跳转；
  加持久化字段还要同步 `shared/schema.ts` + `default-state.ts` + `normalizeAppSettings`（pitfall #5/#6），
  收益与成本不匹配。模块级 registry 也符合 AGENTS.md「避免重量级 in-state 快照」。
- registry 带 TTL/容量上限（≤32 条、60s 过期），防止"设置了但那张卡从未挂载"导致的条目堆积。

## M6 — 样式（`src/index.css`）

```
.message-file-reference > button { 继承 code 字体; 无边框透明背景; color: inherit; cursor: pointer }
.message-file-reference > button:hover { color: var(--accent-fg); text-decoration: underline }
.message-file-reference > button:focus-visible { outline: 2px solid var(--accent-fg); ... }
```

默认态与普通行内代码**像素级一致**（R2），只有 hover/focus 才有提示。全部使用现有主题 token，双主题自动跟随。

## 测试

| 测试 | 覆盖 |
|---|---|
| `tests/message-file-reference.test.ts`（新增，红先） | 路径判定正/反例、行号后缀三种写法、Windows 盘符不被误判为行号、工作区外绝对路径 |
| `tests/message-file-link-click.test.ts`（新增） | `a` 点击分流四象限；Alt 走 reveal |
| `tests/markdown-inline-file-reference.test.tsx`（新增） | 行内代码渲染成 button / 保持普通 code；代码块内不可点 |
| `tests/text-editor-reveal.test.ts`（新增） | registry 取出即删、TTL、容量上限 |
| 已有 `tests/message-local-link.test.ts` | 回归：无 Context 时行为不变 |

全部注册进 `tests/index.test.ts`（pitfall #3）。

## 对标核实（2026-07-31 调研，一手源码证据）

用户质疑「这和 VSCode 插件与 CLI 的原生交互一样吗」，查证结论如下。

**VSCode 官方 Chat API 确实有结构化文件锚点**：`ChatResponseStream.anchor(Uri | Location, title?)` /
`ChatResponseAnchorPart`（`microsoft/vscode` `src/vscode-dts/vscode.d.ts`）。但——

**Copilot Chat 的 anchor 数据本身也是从模型纯文本里正则猜出来的**，是「B → A」两段式：

1. system prompt 强制模型输出 markdown 链接（`vscode-copilot-chat`
   `src/extension/prompts/node/agent/fileLinkificationInstructions.tsx`：
   `[file.ts](file.ts#L10)`，明确写 "NO BACKTICKS ANYWHERE"）。
2. 扩展侧正则扫（`src/extension/linkify/filePathLinkifier.ts`，连**裸文本路径**都扫），
   再 `statCache.stat(uri)` 做**真实存在性校验**，通过才产出 anchor。
3. anchor → `ChatResponseAnchorPart` → UI 的 pill。

**Claude Code 的 VSCode 扩展根本没用 Chat API**：它是自绘 webview（react-markdown + remark-gfm，
只覆写 `a`/`pre`/`code`/`img`），文件链接靠对 `<a href>` 的启发式正则
（`^([^:#]+?)(?:[:#]L?(\d+)(?:-L?(\d+))?)?$` + 扩展名/目录名判定）。
Cline、Roo 同样是纯渲染侧猜测，Cline 也做异步存在性校验。

### 我们的定位

| | 数据来源 | 现状 |
|---|---|---|
| 改动列表 / changes summary | 结构化（CLI tool 入参 + turn 结束时的真实 git diff） | 早已可点 |
| 工具卡 Read/Edit/Write 的 `file_path` | **结构化**（`streamToolActivity.toolInput`，claude CLI 直接给的） | 本次补上可点 + 用 `offset` 定位行 |
| 正文散文里的路径 | **无任何结构化元数据**，流里只有裸文本 | 只能靠启发式识别 |

所以：**和 Claude Code 官方 VSCode 扩展是同一类做法，而且覆盖比它更广**——
它只解析 `<a href>`，反引号包的 `` `src/foo.ts:12` `` 在它的 webview 里点不了，
而 Claude CLI 的 system prompt 恰恰要求模型输出 `file_path:line_number` 这种裸格式。

### provider 覆盖差异（实测）

`server/codex-structured-output.ts` 里 `kind: 'tool'` 零命中——**codex app-server 根本不产生工具活动卡**
（它读文件是走 shell 命令，路径埋在 command 文本里，只有 `edited_files` / `file_change` 带结构化路径）。
所以「工具卡里的文件路径可点」这一条**只在 Claude 卡上生效**；codex 卡仍然有正文可点 + 改动列表可点。
要覆盖 codex 的读取类操作，得从 `command_execution` 的命令文本里解析路径，那又回到启发式，本期不做。

**与 Copilot 的实际差距只剩一条：它有 `stat()` 存在性预校验。**
本期不做，理由是触发面完全不同：Copilot 必须校验，因为它连裸文本都扫（也因此有
`web` 文件夹被误链接这类 issue）；我们只认反引号 + 扩展名白名单 + 可解析成工作区路径，
误报面小一个量级，而预校验要引入跨进程 API + 缓存 + 异步渲染一致性。
折中做法：点开不存在的文件时给「工作区里没有这个文件」的明确提示，
而不是甩一个原始 `ENOENT`（`src/components/text-editor-load-failure.ts`）。
真的需要预校验时再作为独立 slice 引入。

## 实施顺序

```
M1（纯函数，可独立红→绿）
 └→ M2（Context 骨架）
      ├→ M3（a 分流）
      └→ M4（code 可点）+ M6（样式）
M5（行号 registry + App/TextEditorCard 接线，依赖 M1 的 line 解析）
```
