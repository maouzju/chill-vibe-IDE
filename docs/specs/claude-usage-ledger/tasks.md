# Claude 用量账本 — Tasks

## Slice 1 — Schema 与共享纯函数（红→绿）✅ 2026-10-28
- [x] `shared/schema.ts`：`claudeUsageRequestSchema` / `claudeUsageResponseSchema`
      （`costByFamily` 必须是 `z.partialRecord`，见 AGENTS.md pitfall 412）。
- [x] `tests/claude-pricing.test.ts` 红 → `shared/claude-pricing.ts` 绿。
- [x] `shared/claude-prompt-markers.ts` + `shared/chat-request-seeding-copy.ts`（从
      `server/providers.ts` / `src/chat-request-seeding.ts` 提出常量，原处改为引用）。
- [x] `tests/claude-prompt-shell.test.ts` 红 → `shared/claude-prompt-shell.ts` 绿。

## Slice 2 — 服务端账本（红→绿）✅
- [x] `server/external-history.ts` 导出 `getClaudeProjectsDirs` / `getExternalHistoryHomeDirs`。
- [x] `tests/claude-usage-ledger.test.ts` 红（临时目录 jsonl fixture）→
      `server/claude-usage-ledger.ts` 绿：增量读 / 去重 / 桶聚合 / 缓存 / 查询 / 项目归属。
- [x] `server/index.ts` 路由、`electron/backend.ts` + `main.ts` + `preload.ts` +
      `src/electron.d.ts` IPC、`src/api.ts` 客户端函数。

## Slice 3 — 前端 ✅
- [x] `tests/claude-usage-view-model.test.ts` 红 → `src/claude-usage-view-model.ts` 绿。
- [x] `shared/i18n.ts` 双语文案。
- [x] `src/stats-card-source.ts` + `src/App.tsx`：快照多带鞭策名单。
- [x] `src/components/ClaudeUsageView.tsx`、`src/components/StatsCard.tsx` 视图切换。
- [x] `src/index.css`：样式 + `--usage-*` 双主题 token + 容器查询。

## Slice 4 — 验证 ✅
- [x] 四个 Node 测试登记进 `tests/index.test.ts` 并全绿（连同 stats-card / seeding 邻居共 101 条）。
- [x] `pnpm test:quality`：lint 绿；tsc 的 app / server / node 配置绿，test 配置唯一的红是
      别的会话未提交的 `tests/claude-agent-status.test.ts`（`language: 'zh'`），与本功能无关。
- [x] `tests/stats-card-theme.spec.ts` 补新视图亮 / 暗 / 窄卡三张截图 + 悬停 / 切口径断言，
      file-scoped 8/8 绿。
- [x] 真实 `~/.claude/projects` 跑一遍（17,634 个文件 / 21.5 GB，首扫 126 s，缓存 12.7 MB）：
      近 30 天 $29,945 / 30.68B token / 3,029 会话，token-dashboard 用**同一份** prices.json
      算同窗口是 $29,808（它截图里的 $45,133 是 10-28 03:11 改价前的旧价表）。

## 已知取舍 / 后续可选
- 鞭策名单变化不回溯已入账的提示词计数（FR-5 明说）。
- 已见键只保留 120 天：四个月前的会话若被新建 fork 再抄一遍，那一天会重复计一次。
- AI 项目简介、git 提交量、`~/.codex`、自定义日期区间、表头排序：见 requirements 非目标。
