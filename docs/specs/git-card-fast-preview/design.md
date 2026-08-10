# Git 卡牌快显加载设计

## 状态分层

新增轻量 Git 状态 API：`fetchGitStatusPreview(workspacePath)`。

后端复用 `inspectGitWorkspace(workspacePath, { includeChangePreviews: false, includeRepositoryDetails: false })`：

- 保留：repoRoot、branch、upstream、ahead/behind、summary、changes、clean、hasConflicts。
- 跳过：每个文件的 patch / addedLines / removedLines、lastCommit、package description。

完整 `fetchGitStatus()` 仍保留现有行为，用于 full Git、diff 预览、分析提示等需要更多上下文的场景。

## 完整预览批量补齐（2026-07-20）

完整状态原先对每个已跟踪文件分别执行 `git cat-file -s`、读取 HEAD 内容，再执行一次
`git diff --no-index`。文件数增加时，进程数和等待时间近似线性放大；6 个普通文件已可
触发 21 个 Git 进程。

后续补强保持 API 和 UI 不变：

1. 用一次 `git ls-tree -r -l -z HEAD` 建立 HEAD 文件大小表，继续执行 256 KiB 单文件和
   512 KiB 总预览预算；
2. 将预算内的已跟踪路径按命令行长度分成有界批次，通过 `git diff HEAD` 批量取得 patch；
3. 按已知的旧/新路径把 patch block 映射回 `GitChange`，保留 rename/delete/add 语义；
4. untracked 文件使用等价的新增文件 unified patch，不再为每个文件启动 Git；
5. 批量输出缺失或无法安全匹配时，才回退现有单文件路径，正确性优先于跑分。

该切片不改变 `GitStatus` schema、按钮流程、暂存/提交语义或前端渲染结构。

## 前端加载流程

`GitToolCard` 首次刷新时并行/串行组织为：

1. 若当前卡牌没有当前工作区状态，先请求 preview。
2. preview 返回后立即设置 `gitStatus` 和 `loadState=preview`，渲染主卡牌按钮与改动数量。
3. 随后继续请求完整状态；完整状态返回后替换 preview 状态并进入 `ready`。
4. 如果完整请求失败但 preview 已成功，保留 preview 和按钮，只显示错误 notice。
5. 如果 preview 失败且没有旧状态，进入现有错误态。

## 按钮安全

- 「提交新增」仍会在处理前调用完整 `fetchGitStatus()`，保证提交基于最新状态。
- 「分析改动」需要更好的 patch 上下文；如果当前只有 preview，打开分析面板前先触发完整刷新。刷新期间按钮显示分析中/禁用，完整状态到达后再打开 Agent 面板。
- 「古法 Git」可先用 preview 打开完整面板，`GitFullDialog` 现有初始化会刷新完整状态并补齐 diff。

## 类型与桥接

- `shared/schema.ts` 继续使用 `GitStatus`，不新增持久化字段。
- Electron preload/main/backend 和测试用 mock bridge 增加 `fetchGitStatusPreview`。
- HTTP fallback 测试桥增加 `/api/git/status/preview`，Express 增加对应 endpoint，便于 Playwright 覆盖。

## UI

不新增重样式组件。preview 状态复用当前 Git 卡牌紧凑布局；当轻量状态还没有 diff 行数时，增删行统计显示为 `+? / -?`，避免把“尚未加载”的行数误导成真实的 0 行改动。按钮位置和视觉层级不变，符合 `docs/ui-principles.md` 的“内容优先、少 chrome”原则。

「同步」按钮的显隐只由 upstream 决定，不由 `clean` 决定。干净状态继续使用紧凑空态行，但在「古法 Git」旁保留同步入口，让用户可以拉取尚未体现在本地 ahead/behind 数据里的远端变化。

## 自动刷新与 patch 保真（2026-08-10）

Git 卡片常驻在布局中，即使 tab 不可见也不会卸载。因此刷新分成两条明确路径：

1. 聚焦、tab 激活等自动触发共享 3 秒节流时钟，并以真实的 in-flight 标记去重；暖卡只请求
   `fetchGitStatusPreview()`，冷卡在 preview 到达后再补一次完整状态。卡片不再绑定
   `onMouseEnter`，避免鼠标掠过就把完整 Git 管线压到 Electron 主进程。
2. preview 不带 patch 时，按路径合并上一轮仍对应的 patch/行数，让文件列表和统计保持稳定；
   这份合并结果会标记为 preview fidelity。分析变更、完整 Git 对话框等 patch 消费方在开工前
   通过 `needsFullGitStatusFetch()` 检查 workspace 与 fidelity，不满足条件就重新抓取全量，
   不把上一轮可能过期的 diff 交给 AI。

服务端的 Git 输出先缓存 Buffer，再统一按 UTF-8 解码，避免 chunk 边界切断中文或 emoji。
批量 patch 读取后用 `createGitPatchBlockIndex()` 一次扫描每个 block，分别索引 marker/header
匹配并保留旧实现的“最早命中”规则；这样查找从 N×N 降为一次建索引加 O(1) 查询，异常时仍沿用
现有单文件回退路径。
