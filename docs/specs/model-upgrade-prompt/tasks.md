# 默认模型换代提示 — 任务

1. [x] SPEC
2. [x] 红：`tests/model-upgrade-prompt.test.ts`（判定 / 已读 / 全新安装 vs 老存档 / 名单健全性 / App 接线守卫）
3. [x] 绿：`shared/models.ts`、`shared/schema.ts`、`shared/default-state.ts`、`src/state.ts`（updateSettings 白名单）、`shared/i18n.ts`、`src/App.tsx`、`src/index.css`
4. [x] `tests/model-upgrade-prompt.spec.ts`（暗/亮主题截图 + 一键切换 + 保持不变 + 刷新不再弹）
5. [x] `pnpm test:quality` 绿
