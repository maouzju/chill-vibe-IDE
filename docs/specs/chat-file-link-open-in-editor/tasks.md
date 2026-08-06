# 任务拆解

## Slice 1 — 正文文件引用可点击打开编辑器

- [x] T1.1 红：`tests/message-file-reference.test.ts`，覆盖路径判定正反例 + 三种行号后缀 + 盘符不误判。
- [x] T1.2 绿：`src/components/message-file-reference.ts`（`parseFileReferenceCandidate` / `resolveMessageFileTarget` / `resolveMessageLinkFileTarget` / `resolveMessageLinkAction` / 扩展名白名单）。
      `isLocalMessageLinkHref` / `isExternalMessageLinkHref` 一并从 `chat-card-rendering.tsx` 迁到这里，
      避免 href 分类器和点击路由分家。
- [x] T1.3 `src/components/message-file-open-context.ts`（Context + handler 类型）。
- [x] T1.4 红：`tests/message-file-link-click.test.ts`（点击分流四象限 + Alt 逃生口）。
- [x] T1.5 绿：`chat-card-rendering.tsx` 的 `handleMessageLinkClick` 改走 `resolveMessageLinkAction`。
- [x] T1.6 红：`tests/markdown-inline-file-reference.test.tsx`。
- [x] T1.7 绿：`chat-card-rendering.tsx` 增加 `pre` / `code` 组件与 `InsideCodeBlockContext`。
      顺带修掉一个既有缺陷：`img` / `a` 一直把 react-markdown 的 hast `node` 展开到 DOM，
      markup 里留下 `node="[object Object]"`；现在统一走 `omitMarkdownNode`。
- [x] T1.8 `ChatCard.tsx` 最外层挂 `MessageFileOpenContext.Provider`。
- [x] T1.9 `src/index.css` 加 `.message-file-reference` / `.message-file-reference-link` 三态样式。
- [x] T1.10 新测试注册进 `tests/index.test.ts`。

## Slice 2 — 行号定位

- [x] T2.1 红：`tests/text-editor-reveal.test.ts`（取出即删 / TTL / 容量上限 / 非法行号）。
- [x] T2.2 绿：`src/components/text-editor-reveal.ts`。
- [x] T2.3 `App.openTextEditorTab` 增加可选 `line`；`onOpenFile` 链路各层签名带上 `options?: { line?: number }`。
- [x] T2.4 `TextEditorCard` 挂载后 consume 并 `setPosition` + `revealLineInCenter`（刻意不 `focus()`，见代码注释）。

## Slice 3 — 对标核实后的补齐（2026-07-31）

触发原因：用户质疑与 VSCode 的对齐程度。调研结论见 `design.md` 的「对标核实」一节。

- [x] T3.1 工具卡里 CLI 报告的 `file_path` 变成可点（这是**结构化**数据，不是猜的）：
      `buildToolDetails` 拆到新模块 `src/components/structured-tool-details.ts`
      （原地 export 会触发 `react-refresh/only-export-components`），
      Read 用 `offset` 当跳转行，Edit/Write/MultiEdit/NotebookEdit 也补上文件行。
- [x] T3.2 修 server 侧死分支：`extractToolInput` 的 Write/Edit 组从不提取 `notebook_path`，
      渲染端却在读它（`server/claude-structured-output.ts`）。
- [x] T3.3 详情行抽成 `StructuredToolDetailRow` 以便组件级测试覆盖 button 分支。
- [x] T3.4 点开不存在的文件给明确提示，不再甩原始 `ENOENT`
      （`src/components/text-editor-load-failure.ts` + `missingFile` 文案）。
- [x] T3.5 修 web 路径丢错误原因：`fetchFileContent` 把服务端的 `{message}` 折叠成
      "Failed to read file"，缺失文件提示在浏览器模式下永远不会触发（`src/api.ts`）。
- [x] T3.6 修样式作用域 bug：`.message-content code.message-file-reference > button` 够不到
      **工具组内**的工具卡（它渲染在 `.message-content` 之外），那份按钮退回浏览器默认灰底方框。
      改为不依赖祖先的 `code.message-file-reference > button`，并补 `tool-card-file-{rest,hover}-{dark,light}` 快照。
      教训：交互测试点得动、断言全绿，这类问题只有截图能发现（pitfall #231）。
- [x] T3.7 路径存在性校验 —— 改成**点击时**做，而不是 Copilot 那样在渲染时预校验。
      新模块 `src/components/workspace-file-fallback.ts`：先列一次父目录确认文件在不在，
      不在就按 basename 搜全仓并按「尾部段匹配 → 层级浅 → 字典序」确定性排名，
      把裸文件名 `PlayerRunSystem.OverflowLoot.cs` 改写成真实路径再开 tab。
      触发原因：2026-08-05 用户实测裸文件名链接 100% 打不开（详见 design.md「M7」）。
      测试 `tests/workspace-file-fallback.test.ts`（红先），真实仓库实测常规路径 ~1ms、兜底 56–163ms。
- [ ] T3.8（backlog）裸文本路径 autolink。Copilot 做了并因此吃了多轮误报 issue，
      需要连同 T3.7 一起做才安全。

> **v0.18.23 明确不包含 T3.8。** 该项保留为后续独立切片，不属于本次发布验收范围。

## 已知覆盖边界（不是 bug，是数据源决定的）

- **Codex 会话没有工具卡**：只有 claude 的解析器产出 `kind: 'tool'` activity
  （`server/codex-structured-output.ts` 里 codex 只有 `edited_files`/`command_execution`，
  后者的路径埋在 shell 命令文本里）。所以「工具卡文件可点」只在 Claude 会话出现；
  Codex 会话仍然有正文识别 + 改动列表可点。

## Slice 4 — 补齐验证缺口（2026-07-31，第二轮追问后）

第一轮交付时有两条链路只有单元测试、没有端到端证明，属于"声称已解决但未证明"。

- [x] T4.1 工具卡链路端到端：此前 Playwright fixture 里 tool 消息 `count=0`，被当成 fixture 问题绕开了。
      查清真因是**工具组默认折叠**（`StructuredToolGroupCardView` 的 `collapsed` 分支根本不挂载内部卡片），
      需要展开两层（工具组 → 工具卡 details）才能摸到文件按钮。已补进 spec 并通过。
- [x] T4.2 真实 Electron 运行时验证：新增 `tests/electron-chat-file-open-runtime.test.ts`，
      在真 Electron + 真文件系统 + 真 IPC 下点击 `` `src/sample.ts:12` ``，
      断言编辑器状态栏为 `12:1` 且渲染出真实文件内容。已注册进 `scripts/run-electron-runtime-tests.ps1`。
      踩坑：Monaco 把 token 间空格渲染成 U+00A0，断言必须用不含空格的片段。
- [x] T4.3 全量 `pnpm test` 回归通过，`pnpm test:quality` 干净。

## 验证

- [x] V1 新增 Node 测试全绿（`message-file-reference` / `message-file-link-click` /
      `markdown-inline-file-reference` / `text-editor-reveal`），并回归 105 项相关测试。
- [x] V2 `pnpm test:quality` 通过（0 error / 0 warning）。
- [x] V3 Playwright `tests/chat-file-reference-open.spec.ts`：点击助手消息里的 `src/sample.ts:12`
      → 打开 Monaco 编辑器 → 状态栏显示 `12:1`。
- [x] V4 双主题快照 `chat-file-reference-{rest,hover}-{dark,light}`：静止态与普通行内代码一致，
      hover 才出现主题色 + 点线下划线。
- [x] V5 `pnpm electron:build` 出包。
