# 文本编辑器对标 VSCode 差距拆解与改进需求

## 背景

Chill Vibe 的文本编辑器（`src/components/TextEditorCard.tsx` + `text-editor-monaco.ts`）基于 **Monaco Editor v0.55**——与 VSCode 同一个编辑器内核。因此语法高亮、多光标（Alt+Click）、查找替换（Ctrl+F/H）、代码折叠、括号匹配、列选择、undo/redo 这些"编辑内核能力"**已经天然具备**，不是差距。

真正的差距全部在**集成层**：当前集成只有约 600 行，是"打开一个文件 → 编辑 → 自动保存"的最小闭环。与 VSCode 相比缺失的是数据安全保护、会话连续性、AI 协同场景支撑和产品完整度。

### 产品定位约束

Chill Vibe 是以 AI 对话为核心的轻 IDE。编辑器的定位是**"快速查看 + 小幅修改 + 看清 agent 改动"**，不是替代 VSCode。差距评估和改进优先级都以这个定位为准：与 agent 协同相关的差距权重最高，纯重度编程功能（调试器、扩展系统）明确不追。

## 差距拆解

### A 类 — 数据安全（会丢数据，最严重）

| # | 差距 | 现状 | VSCode 行为 |
|---|------|------|-------------|
| A1 | 并发写冲突无保护 | 编辑器 dirty 时外部（agent）改同一文件，`resolveTextEditorExternalRefresh` 直接忽略磁盘变更（`tool-card-state.ts`），1.5 秒后 autosave **盲写覆盖 agent 的修改**，无任何提示 | 保存前检测磁盘版本变化，弹"文件已在磁盘上更改"对话框，提供对比/覆盖/放弃 |
| A2 | 大文件无守门 | `readWorkspaceFile` 直接 `readFile(path, 'utf8')` 整读（`server/file-system.ts`），无大小上限；大文件会贯穿 HTTP/IPC → React state → Monaco 全链路 | 大文件降级（关 tokenization、只读提示），超大文件拒绝并提示 |
| A3 | 二进制文件无检测 | 图片/二进制按 utf8 读成乱码字符串直接进编辑器 | 二进制检测 → 专门 viewer 或"无法编辑"提示 |
| A4 | 保存失败静默吞掉 | `save()` 的 `catch {}` 空吞（`TextEditorCard.tsx`），只读/权限错误时用户以为已保存 | 保存失败显式报错 + 重试/另存为 |

### B 类 — 会话连续性（高频烦人）

| # | 差距 | 现状 | VSCode 行为 |
|---|------|------|-------------|
| B1 | 切 tab 丢 undo 栈/光标/滚动 | 非激活 pane tab 不渲染卡片 body（AGENTS.md pitfall #135），unmount 时 `model.dispose()` + `editor.dispose()`，undo 历史、光标、滚动位置全部丢失 | model 跨编辑器存活，viewState 保存/恢复，关闭文件前 undo 栈一直在 |
| B2 | 外部变更感知靠 2 秒轮询 | `TEXT_EDITOR_REFRESH_INTERVAL_MS = 2000` 定时整文件重读 + focus 刷新；agent 改动最慢 2 秒后可见，多卡片时读放大 | 文件系统 watcher 即时推送 |
| B3 | 重启不恢复编辑状态 | 卡片和文件路径会恢复，但光标/滚动/未保存内容不恢复 | 热退出（hot exit）连未保存 buffer 都恢复 |

### C 类 — AI IDE 核心场景（产品价值最大）

| # | 差距 | 现状 | VSCode 行为 |
|---|------|------|-------------|
| C1 | 无 Diff 视图 | Monaco 自带 `createDiffEditor` 但完全没用上；用户想看 agent 改了什么只能去 Git 卡 | 编辑器内 diff 标配（工作区 vs HEAD、磁盘 vs 缓冲区） |
| C2 | 无 Git gutter 修改标记 | 行号旁没有红/绿/蓝改动条 | 标配，秒懂哪些行被改过 |
| C3 | 冲突场景无合并 UI | A1 的延伸：检测到冲突后也没有对比择优的界面 | 内置 merge/对比编辑器 |

### D 类 — 语言智能（差距最大，但要务实）

| # | 差距 | 现状 | VSCode 行为 |
|---|------|------|-------------|
| D1 | TS/JS worker 无项目上下文 | ts worker 是默认配置，未喂 tsconfig/lib，跨文件 import 全是报错或 any | tsserver 完整项目语义 |
| D2 | 其他语言只有高亮 | basic-languages 仅 Monarch 高亮，无补全/跳转/诊断 | LSP 生态 |

### E 类 — 产品完整度（中等价值，单项成本低）

| # | 差距 | 现状 | VSCode 行为 |
|---|------|------|-------------|
| E1 | 编辑器配置硬编码 | fontSize 13 / tabSize 2 / wordWrap off / minimap off 写死，无设置入口 | 全部可配 |
| E2 | 无状态栏信息 | 无行:列、无语言指示、无 EOL 指示 | 状态栏标配 |
| E3 | 无 EOL/编码处理 | CRLF/LF 不可见不可切换，假定 UTF-8（Windows 项目常见痛点） | EOL 显示与切换、编码选择 |
| E4 | 无编辑器内文件操作 | 不能新建/重命名/另存为 | 标配 |
| E5 | 无快速打开 | 无 Ctrl+P 模糊找文件 | 核心交互 |
| E6 | 无跨文件搜索 | 无 Ctrl+Shift+F | 标配 |

## 目标

1. **任何情况下不丢用户或 agent 的数据**：保存冲突必须被检测并提示，大文件/二进制不允许击穿链路，保存失败必须可见（A1–A4）。
2. **切换 tab / 切换卡片不丢编辑会话**：undo 栈、光标、滚动在卡片存活期内保留（B1）。
3. **agent 改动近实时可见**：外部文件变更通过 watcher 推送，秒级反映到打开的编辑器（B2）。
4. **看清改动**：编辑器内一键查看当前文件 vs HEAD 的 diff，行级 gutter 改动标记（C1、C2）。
5. **基础可配置**：字号、自动换行、minimap、缩进宽度进设置页（E1）。
6. **状态栏补齐**：行:列、语言、EOL 显示与切换（E2、E3）。
7. **TS/JS 智能升半级**：喂 tsconfig compilerOptions + 已打开文件互相可见，达到"轻语义"水平（D1）。

## 非目标

- 不接完整 LSP / tsserver，不做调试器、终端集成、扩展系统、远程开发——这些是 VSCode 的护城河，与本产品定位不符（D2 明确放弃，D1 只做轻量提升）。
- 不重做卡片/分栏模型去模仿 VSCode 的 tab 栏；多文件管理沿用现有卡片体系。
- 不做 markdown 预览、图片 viewer 等 viewer 类功能（A3 只要求"识别并拒绝编辑"，不要求"能看"）。
- 跨文件搜索（E6）、快速打开（E5）、热退出（B3）列为远期备选，不在本轮承诺范围。

## 验证

- A1：单元测试覆盖"dirty + 磁盘变更 → 保存被拦截并返回冲突"；Playwright 覆盖冲突提示条出现。
- A2/A3：单元测试覆盖超限文件与含 NUL 字节文件的读取响应标志；UI 显示对应提示态。
- B1：Playwright 覆盖"输入 → 切 tab → 切回 → Ctrl+Z 仍可撤销且光标/滚动保持"。
- B2：Electron 运行时测试覆盖外部写文件后编辑器内容在事件驱动下刷新。
- C1/C2：Playwright 覆盖 diff 视图开启路径；gutter 标记的视觉回归快照进 `tests/theme-check.spec.ts`（双主题）。
- E1–E3：设置变更后编辑器选项生效的单元/Playwright 覆盖；新增持久化字段走 `normalizeAppSettings()` 并有迁移测试。
