# 任务

- [x] SPEC（requirements / design / tasks）
- [x] red：`tests/composer-paste.test.ts` 新增 `partitionDroppedFiles` 失败测试
- [x] green：`src/components/composer-paste.ts` 实现
- [x] `ChatCard.tsx`：抽出 `ingestExternalFiles`，粘贴与拖入共用；`.composer-input-row` 挂 drag 事件与 `is-file-drop-target`
- [x] `App.tsx`：document 级文件 drop 导航守卫
- [x] `index.css`：drop-target 态样式；`tests/theme-check.spec.ts` 两主题断言
- [x] 窄测试 + `pnpm test:quality`
- [ ] `pnpm electron:build`
