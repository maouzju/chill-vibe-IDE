# Git 同步冲突交给显式会话 — 任务

- [x] 红测：`tests/git-operation-hub.test.ts` 冲突时调用 `openAgentSession`、不发后台 chat、不 push、面板收起并飘字。
- [x] 红测：无 `openAgentSession` 时停在错误态、不 push。
- [x] Hub 改造，删除后台冲突流与 `conflict` 同步步骤。
- [x] 接线 App → WorkspaceColumn → PaneView → ChatCard → GitToolCard。
- [x] 文案与 `GitSyncPanel` 清理；更新 `git-card-fast-preview/design.md` 中被取代的段落。
- [x] `pnpm test:quality` + 定向 Node 测试；打包。
