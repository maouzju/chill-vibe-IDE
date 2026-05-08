# Git 卡牌快显加载设计

## 状态分层

新增轻量 Git 状态 API：`fetchGitStatusPreview(workspacePath)`。

后端复用 `inspectGitWorkspace(workspacePath, { includeChangePreviews: false, includeRepositoryDetails: false })`：

- 保留：repoRoot、branch、upstream、ahead/behind、summary、changes、clean、hasConflicts。
- 跳过：每个文件的 patch / addedLines / removedLines、lastCommit、package description。

完整 `fetchGitStatus()` 仍保留现有行为，用于 full Git、diff 预览、分析提示等需要更多上下文的场景。

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

不新增重样式组件。preview 状态复用当前 Git 卡牌紧凑布局，只把增删行统计在缺少数据时保持为 `+0 / -0`。按钮位置和视觉层级不变，符合 `docs/ui-principles.md` 的“内容优先、少 chrome”原则。
