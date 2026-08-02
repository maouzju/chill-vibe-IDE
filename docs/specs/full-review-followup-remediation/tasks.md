# Tasks — Full Review Follow-up Remediation

| # | 切片 | 生产文件 | 回归测试 | 状态 |
|---|------|---------|---------|------|
| 1 | Git Agent 策略提交路径闸门 | `src/components/git-agent-panel-utils.ts`、`src/components/git-operation-hub.ts` | `tests/git-operation-hub.test.ts` | 完成 |
| 2 | 重命名整体 stage / unstage / commit | `server/git-workspace.ts` | `tests/git-workspace.test.ts` | 完成 |
| 3 | moveTab / closeTab 原子化 | `src/state.ts` | `tests/state.test.ts` | 完成 |
| 4 | 跨工作区移动停掉旧进程 | `src/app-helpers.ts`、`src/App.tsx` | `tests/app-helpers.test.ts` | 完成 |
| 5 | 关闭工作区先落快照 | `src/app-helpers.ts`、`src/App.tsx` | `tests/close-workspace-confirmation.test.ts`、`tests/app-helpers.test.ts` | 完成 |
| 6 | 白噪音沙箱 + 超时 + 输出上限 | `server/whitenoise/whitenoise-generator.ts` | `tests/whitenoise-generator.test.ts` | 完成 |
| 7 | stop 与工作区 diff 的顺序 | `server/chat-manager.ts` | `tests/chat-manager-stop-race.test.ts` | 完成 |
| 8 | sidecar 索引失败可重试 | `server/session-history-catalog.ts` | `tests/session-history-search.test.ts` | 完成 |
| 9 | 历史 diff 预算 + 请求代次 | `server/git-workspace.ts`、`src/components/GitFullDialog.tsx` | `tests/git-workspace.test.ts`、`tests/git-utils.test.ts` | 完成 |
| 10 | 原生会话完成判定尾读 | `server/native-turn-completion.ts` | `tests/native-turn-completion.test.ts` | 完成 |

## 收尾

- [x] 所有新测试落在已注册文件，未新增 `tests/index.test.ts` 条目
- [x] `pnpm test:quality`（`eslint .` 与四个 tsconfig 全量类型检查均干净）
- [x] `pnpm electron:build` → `dist/release-20260802-134403/Chill Vibe-0.18.21-win.zip`（同目录 `win-unpacked` 可直接运行）
- [x] 包内特征核对（不只看目录时间戳，pitfall 176）：`readNativeSessionTailVerdict` / `stopWorkspaceDiffGraceMs` / `skippedFileStamps` / `expandRenamePathspecs` / `--sandbox read-only` / 前端策略提交的中文错误文案全部命中 `app.asar`

## 已知残留（本轮刻意不扩大范围）

- `runGit` 仍无界累加 stdout，历史 diff 的预算是在完整字符串生成之后才裁剪，内存峰值本身还在。
- `fetchCommitDiff` 的 `assertRepository()` 仍走带完整预览的 inspect，每次点历史提交都会 hydrate 整个脏工作区的 patch 预览。
- `readCatalogEntries` 对损坏 segment 仍是静默忽略且无重建触发器，症状会是「历史少了一批但 phase 显示 complete」。
- `/compact` 边界之前的消息在跨模型重放时仍会被整段剔除（pitfall 226 的第二层损耗）。
