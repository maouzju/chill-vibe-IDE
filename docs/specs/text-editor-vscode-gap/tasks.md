# 文本编辑器改进任务清单

按 P0 → P3 顺序实施。每个任务标注层级（Tier 1 = 红→绿 TDD，Tier 2 = 视觉快照）和涉及面。P0 全部完成前不开始 P1 新任务（数据安全优先）。

> 2026-06-11：P0–P2 全部 + P3-1 已实施并验证（红→绿单测 + tests/text-editor-card.spec.ts 11 个 E2E + 双主题快照 + smoke 套件通过）。P3-2/3/4 维持远期备选。

## P0 — 数据安全（防丢数据）

- [x] **P0-1** 服务端大文件/二进制守门（Tier 1，`server/file-system.ts` + `shared/schema.ts`）
  - 红：超限文件 / 含 NUL 文件的 `readWorkspaceFile` 测试先失败
  - `stat` 前置；>10MB 返回 `tooLarge`，>1.5MB 标记 `large`，NUL 检测返回 `binary`
  - `FileReadResponse` schema 扩展 + 客户端类型同步
- [x] **P0-2** 编辑器侧守门提示态（Tier 2，`TextEditorCard.tsx` + `tool-card-text.ts`）
  - `binary`/`tooLarge` 提示态文案（双语言）+ 双主题快照
  - `large` 时编辑器降级选项 + 跳过轮询
- [x] **P0-3** 读写带版本指纹（Tier 1，`server/file-system.ts` + `src/api.ts` + electron bridge）
  - 红：`expectedRevision` 不匹配时 `writeWorkspaceFile` 必须拒绝写入
  - read 返回 `revision`；write 校验；HTTP 409 / bridge 结构化冲突错误
  - 缺省 `expectedRevision` 保持旧行为（兼容）
- [x] **P0-4** 冲突检测进编辑器状态机（Tier 1，`tool-card-state.ts` + `TextEditorCard.tsx`）
  - 红：`resolveTextEditorExternalRefresh` 在 dirty + 磁盘变更时返回 `conflict` 的单测先失败
  - 冲突时暂停 autosave；状态条冲突态 + 覆盖磁盘 / 放弃本地两个动作
- [x] **P0-5** 保存失败可见（Tier 1 小项，`TextEditorCard.tsx`）
  - 失败态 + 重试按钮；blur 保存失败同样提示

## P1 — 会话连续性 + agent 协同

- [x] **P1-1** 模型缓存池（Tier 1，新 `text-editor-model-cache.ts` + `TextEditorCard.tsx` + `text-editor-monaco.ts`）
  - 红：缓存命中复用 model、unmount 不丢 undo 栈的单测先失败（模型层可在 node 侧用 mock 验证缓存语义）
  - LRU 上限 12；`removeCard` 路径驱逐；revision 不一致走刷新/冲突逻辑
  - Playwright：输入 → 切 tab → 切回 → Ctrl+Z 可撤销、光标/滚动保持
- [x] **P1-2** 文件 watcher 推送（Tier 1，`electron/` + `server` bridge + `TextEditorCard.tsx`）
  - 按打开文件集合动态 `fs.watch` 单文件；`desktop:file-changed` 事件桥
  - 自写吞掉（revision 比对）+ 200ms debounce；窗口 close 清理 watcher
  - 桌面模式轮询放宽到 30s 兜底；浏览器模式保留 2s 轮询
  - Electron 运行时测试：外部写文件 → 编辑器内容刷新
- [x] **P1-3** 冲突对比 diff 视图（Tier 1 + Tier 2，`TextEditorCard.tsx` + `text-editor-monaco.ts`）
  - DiffEditor 懒加载；磁盘版 vs 缓冲区；从 P0-4 冲突条的"查看差异"进入
  - 双主题快照

## P2 — 编辑器产品化

- [x] **P2-1** vs HEAD diff（Tier 1，`server/git-workspace.ts` 新端点 + 前端入口）
  - 新增单文件 `git show HEAD:path` 读取端点（红先行）
  - toolbar"对比"按钮；非 git 仓库隐藏入口
- [x] **P2-2** Git gutter 改动标记（Tier 1 + Tier 2）
  - per-file 行区间 diff 端点；装饰渲染 + 主题 token；1s 节流
  - 双主题快照进 `tests/theme-check.spec.ts`
- [x] **P2-3** 编辑器设置节（Tier 1，`shared/schema.ts` + `default-state.ts` + 设置页）
  - 红：`normalizeAppSettings` 对缺失 `editor` 节补默认值的测试先失败
  - fontSize / wordWrap / minimap / tabSize；`editor.updateOptions` 即时生效
- [x] **P2-4** 状态栏 + EOL（Tier 2 为主，小 Tier 1）
  - 行:列、语言、EOL 显示；EOL 切换走 `model.setEOL` + dirty
  - 双主题快照

## P3 — 远期备选（不承诺）

- [x] **P3-1** TS/JS 轻语义：tsconfig 探测端点 + compilerOptions 映射
- [ ] **P3-2** 快速打开（Ctrl+P 模糊找文件开编辑器卡）
- [ ] **P3-3** 跨文件搜索面板
- [ ] **P3-4** 热退出（未保存 buffer 落盘恢复，需评估与状态持久化体积约束的冲突）

## 验收口径

- 每个 Tier 1 任务先有失败测试再实现；新测试文件必须注册进 `tests/index.test.ts`。
- 主题敏感 UI（提示态、冲突条、diff、gutter、状态栏）双主题验证。
- P0 完成后整体跑 `pnpm test:risk` 一次作为阶段闸门；P1/P2 按任务粒度窄验证。
