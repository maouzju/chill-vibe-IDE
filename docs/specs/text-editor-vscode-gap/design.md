# 文本编辑器改进技术方案

对应 [`requirements.md`](./requirements.md) 的差距编号。所有方案遵守现有约束：共享类型先进 `shared/schema.ts`，新持久化字段走 `normalizeAppSettings()`，状态变更走 `ideReducer`，主题敏感面加双主题快照。

## A1 + C3 — 保存冲突保护

**核心思路：乐观锁。** 读文件时带回版本指纹，写文件时校验指纹。

- `FileReadResponse` 增加 `revision: string`（内容 SHA-1 或 `mtimeMs:size` 组合，server 端计算）。
- `fileWriteRequestSchema` 增加可选 `expectedRevision`；`writeWorkspaceFile` 在写之前重读当前指纹，不匹配时抛 `FileRevisionConflictError`，HTTP 路径返回 409，desktop bridge 返回带 `conflict: true` 的结构化错误。
- `TextEditorCard` 持有 `revisionRef`；保存成功后更新。收到冲突时：
  - 停掉 autosave 定时器，状态条切换为冲突态（黄色提示"文件已被外部修改"+ 两个按钮：**查看差异**（打开 C1 的 diff 视图，左侧磁盘版/右侧本地版）、**覆盖磁盘** / **放弃本地**）。
  - `resolveTextEditorExternalRefresh` 增加第三种返回：dirty 且磁盘变更时返回 `{ kind: 'conflict', diskContent }`，不再静默 `null`。
- 兼容性：`expectedRevision` 缺省时保持旧行为（直接写），老客户端不受影响。

**风险**：Electron bridge 错误对象跨 IPC 需保持结构化（参考 pitfall #110 的 normalize 思路），不能只靠 Error message 字符串判断冲突。

## A2 + A3 — 大文件/二进制守门

全部在 `server/file-system.ts::readWorkspaceFile` 入口处做：

- 先 `stat`：size > 硬上限（10MB）→ 返回 `{ tooLarge: true, size }`，不读内容；size > 软上限（1.5MB）→ 正常返回但带 `large: true`。
- 读前 8KB 检测 NUL 字节 → `{ binary: true }`，不返回内容。
- `FileReadResponse` schema 扩展为可辨识联合（或带可选标志位 + content 可空），客户端：
  - `binary` / `tooLarge` → 专门提示态（复用现有 `text-editor-error` 样式族，但文案区分）。
  - `large` → 正常可编辑，但创建 editor 时降级：`{ folding: false, wordWrap: 'off', renderValidationDecorations: 'off' }`，并跳过 2 秒轮询（只保留 focus 刷新 / watcher）。

## A4 — 保存失败可见

- `save()` 的 catch 分支记录 `saveError` state；状态条第三态：`保存失败 — 重试`（点击重试 `flushPendingSave`）。
- 卸载时的兜底保存失败无法提示，接受（窗口已关）；但 blur 保存失败要提示。

## B1 — 编辑会话保持（模型缓存池）

**这是体验提升最大的单项改动。**

- 新模块 `text-editor-model-cache.ts`：模块级 `Map<cacheKey, { model, viewState, revision, savedContent }>`，key 为 `workspacePath\0filePath`。**纯模块缓存，不进 React state、不进持久化**（呼应 AGENTS.md 对重量级 in-state 快照的禁令，pitfall #131）。
- `TextEditorCard` unmount 时：`editor.saveViewState()` 存入缓存，**只 dispose editor，不 dispose model**。
- mount 时：缓存命中且 revision 与磁盘一致 → 复用 model + `restoreViewState`，undo 栈天然保留；revision 不一致 → 走刷新逻辑（dirty 则进 A1 冲突态）。
- 淘汰策略:LRU 上限 12 个模型；卡片被关闭（`removeCard`）时主动驱逐对应条目。驱逐入口：在 `App.tsx` 关卡路径上调用 `evictTextEditorModel(workspacePath, filePath)`。
- 注意：现有代码在 `createTextEditorModel` 里"同 URI 旧模型 dispose 重建"，要改为优先取缓存模型。

## B2 — 文件 watcher 替代轮询

- Electron main 进程：`fs.watch`（Windows 原生支持 recursive 不稳定，只 watch 单个文件，按打开的编辑器文件集合动态增减 watcher）。
- 推送链路复用现有 desktop 事件桥模式（与 chat stream 订阅同构）：`desktop:file-changed` 事件 → 渲染端 `subscribeFileChanges(workspacePath, filePath, cb)`。
- 收到事件 → 现有 `refreshFileFromDisk()`（debounce 200ms，编辑器写盘自身触发的事件用 revision 比对吞掉，防自激励）。
- **浏览器模式 fallback 保留现有 2 秒轮询**，桌面模式轮询间隔放宽到 30 秒作为 watcher 失效兜底。
- 资源清理：窗口 close 时清 watcher（参考 pitfall #112，挂在 BrowserWindow close 而不是 webContents destroyed）。

## C1 — Diff 视图

- toolbar 增加"对比"按钮，两种模式：
  1. **vs HEAD**：git 仓库内文件，调用现有 `server/git-workspace.ts` 能力取 HEAD 版本内容（需新增单文件 `git show HEAD:path` 端点）。
  2. **冲突对比**（A1 触发）：磁盘版 vs 编辑器缓冲区，纯客户端数据。
- 实现：`monaco.editor.createDiffEditor`，懒加载（与现有 `import('./text-editor-monaco')` 同模式）；diff 模式下隐藏普通 editor 容器，共享同一卡片外壳。original 侧模型用 `inMemory://` scheme，退出 diff 即 dispose。
- 主题：跟随现有 `resolveTextEditorMonacoTheme`，新增双主题快照。

## C2 — Git gutter 修改标记

- 数据源：watcher/保存事件后调用轻量 git diff（复用 git-card-fast-preview 的轻量状态思路，新增 per-file unified diff 端点，输出行区间）。
- 渲染：`editor.createDecorationsCollection`，三类装饰（added/modified/deleted）映射到 `linesDecorationsClassName`，颜色用 `src/index.css` 主题 token（双主题各定义一组）。
- 节流：内容稳定 1 秒后才请求 diff；非 git 仓库静默禁用。

## D1 — TS/JS 轻语义

- 打开 TS/JS 文件时，server 端探测最近的 `tsconfig.json`（向上查找，限 workspace 内），返回 `compilerOptions` 原文。
- 客户端映射白名单字段（`target`/`module`/`jsx`/`strict`/`paths` 等）到 `monaco.languages.typescript.typescriptDefaults.setCompilerOptions`。
- 已打开的 TS/JS 模型互相可见是 Monaco 默认行为（同一全局 worker），B1 的模型缓存让"打开过的文件"持续参与语义分析，免费增强。
- 明确不做：node_modules 类型加载、完整项目图谱。`paths` 仅做 alias 不报错级别的宽松处理。

## E1 — 编辑器设置

- `shared/schema.ts` 增加 `editorSettingsSchema`：`{ fontSize: number(10–24, 默认13), wordWrap: boolean(默认false), minimap: boolean(默认false), tabSize: 2|4(默认2) }`，挂到 `appSettingsSchema`。
- `createDefaultSettings` + `normalizeAppSettings` 同步补默认值（pitfall #5/#6）。
- 设置页新增"编辑器"小节；变更通过 `editor.updateOptions()` 即时生效，不重建编辑器。

## E2 + E3 — 状态栏与 EOL

- 卡片底部加一行状态栏（或并入现有 toolbar 右侧）：`行:列`（`onDidChangeCursorPosition`）、语言 id、EOL 指示（`CRLF`/`LF`）。
- EOL 点击切换：`model.setEOL()` + 标记 dirty 走正常保存流。
- 主题敏感面，加双主题快照。

## 实施顺序依赖

```
A2/A3（server 守门，独立）
A1（依赖 FileReadResponse.revision）──→ C3 冲突 UI ──→ C1 diff（冲突对比模式）
B1（模型缓存，独立）
B2（watcher，独立；落地后 A1 冲突发现更及时）
C1 vs HEAD 模式（依赖 git show 端点）──→ C2 gutter
E1/E2/E3（独立，随时可插队）
D1（独立，最后做）
```
