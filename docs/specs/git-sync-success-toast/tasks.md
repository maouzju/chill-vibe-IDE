# Git 同步完成飘字 — Tasks

- [x] 1. 写 requirements / design（本 SPEC）
- [x] 2. Tier 1 红：`tests/git-operation-hub.test.ts` 改 3 处 `syncStep.kind === 'done'` 断言为
      「面板已收起 + transient success notice」，新增过期用例与 error 态保留用例，确认失败
- [x] 3. hub：删 `GitSyncStep.done`，push 成功改为收面板 + `showTransientNotice`，
      加 `noticeTimeout` / `noticeToken` 与 `clearNotice` 清理
- [x] 4. `GitSyncPanel.tsx` 删 `done` 分支
- [x] 5. `GitToolCard.tsx` + `src/index.css`：transient notice 渲染为浮层飘字
- [x] 6. 绿：跑 hub 测试 + 相关 git 测试 + `pnpm test:quality`
- [x] 7. Tier 2：`pnpm test:theme` 确认快照无回归
- [x] 8. 打包 `pnpm electron:build`
- [x] 9. 补漏：`tests/git-tool-switch.spec.ts:772` 的端到端断言仍在找旧的
      `.git-agent-panel .git-tool-notice.is-success`，任务 2 只改了 hub 单测漏了它。
      已改为断言「面板收起 + `.git-tool-toast` 飘字」，对齐需求 1、2。

