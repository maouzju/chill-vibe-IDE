# 聊天正文里的文件引用可点击打开内置编辑器 — 需求

## 背景与问题

用户对比 VSCode 的 agent 插件提出：「agent 返回的代码文件超链接，点击可以直接打开代码编辑器编辑，我们为什么不行。」

现状排查结论（2026-07-31）：

- 应用**已经有**完整的应用内编辑器能力：`TextEditorCard`（Monaco，含保存/冲突/diff/编码检测）、`ImageEditorCard`，
  以及打开入口 `onOpenFile(relativePath)` → `openTextEditorTab()`（`src/App.tsx:3075`）。
- 但这条入口**只接在两个地方**：结构化 edits/changes 卡片的整行按钮（`src/components/StructuredBlocks.tsx:896` / `:1398`）
  和文件树卡片（`src/components/FileTreeCard.tsx:814`）。
- 助手正文（markdown）里的文件引用**完全没接**：
  - 显式 markdown 链接 `[foo](src/bar.ts)` 点击后走的是 `openMessageLocalLink` →
    `electron/main.ts:1030` → `shell.showItemInFolder`，即**在系统资源管理器里定位文件**，不是应用内打开。
  - 行内代码 `` `src/bar.ts` ``、以及裸文本路径**根本不可点**（`createMarkdownComponents` 只覆写了 `img`/`a`）。
- 而 Claude / Codex CLI 的真实输出里，绝大多数文件引用是行内代码或裸路径，只有少数是 markdown 链接。

所以「不行」的根因有两层：**入口没接进正文**，以及**正文里最常见的文件引用形态压根不是链接**。

## 目标

让助手正文里的文件引用变成一等的「打开即改」入口，达到 VSCode agent 插件的手感。

## 需求

### R1 — markdown 显式链接指向工作区文件时，点击在应用内打开编辑器

- `[foo](src/bar.ts)`、`[foo](D:\proj\src\bar.ts)`、`[foo](file:///D:/proj/src/bar.ts)` 点击后
  在当前 pane 新开 TextEditor tab（图片走 ImageEditor），而不是弹出资源管理器。
- 无法解析成可打开文件时（目录、无扩展名、工作区未设置、非桌面环境），保持现有 reveal 行为，不得回退成"点了没反应"。
- 外链（http/https/mailto）行为不变。

### R2 — 行内代码里的文件路径可点击

- `` `src/bar.ts` ``、`` `dist/catalogSnapshot.js` ``、`` `scripts/clean-stale-dist.mjs` `` 可点击打开。
- 只有"确实像文件路径"的行内代码才可点：必须能解析出扩展名或路径分隔符，且命中扩展名白名单；
  `` `writeFileSync` ``、`` `--flag` ``、`` `2%` `` 这类标识符/普通行内代码必须保持不可点。
- 视觉上**默认与普通行内代码一致**，仅在 hover / focus 时露出可点提示（下划线 + 手型 + 主题色），
  避免整段正文被链接色淹没（遵循 `docs/ui-principles.md` 的减法原则）。
- 键盘可达：可点路径是真正的按钮，能 Tab 聚焦、Enter/Space 触发。

### R3 — 行号后缀被正确处理

- `src/bar.ts:120`、`src/bar.ts:120:8`、`src/bar.ts#L120` 都能解析成「文件 + 行号」。
- 打开后编辑器滚动并把光标定位到该行（首次挂载时定位一次，不干扰后续编辑）。
- 没有行号后缀时行为不变。

### R4 — 逃生口保留

- 按住 Alt 点击仍然走「在资源管理器中显示」，覆盖"我只想去文件夹"的场景。

### R5 — 双主题与安全

- 新增的可点样式在 light / dark 下都可读（default / hover / focus 三态）。
- 不放宽任何路径白名单：最终读写仍由 server 侧 workspace / agent-home 白名单把关；
  渲染侧只用现有 `resolveOpenableFilePath` 做解析，不新增可访问范围。

## 非目标

- 不做裸文本（无反引号、无链接）路径的自动 linkify——误判风险高于收益，本期不做，记 backlog。
- 不做文件存在性预校验（会引入每条消息 N 次 IPC）。点开不存在的文件由编辑器现有错误态承担。
- 不唤起外部 VSCode（`vscode://`）。本产品的编辑器就是内置 Monaco。

## 验收

- 单元测试覆盖路径识别（正例/反例）、行号解析、点击分流（编辑器 vs reveal）。
- 在真实 Electron 里点一条含 `` `src/state.ts` `` 的助手消息，能开出 Monaco 编辑器并可编辑保存。
- `pnpm test:quality` 通过；新增可点样式在双主题下检查。
