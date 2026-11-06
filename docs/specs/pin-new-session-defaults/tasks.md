# 新会话默认档位 + 「卡上改动只管这一张」开关 — Tasks

1. [x] 红：`tests/pin-new-session-defaults.test.ts`（注册进 `tests/index.test.ts`），覆盖 requirements 验收里的 reducer、清单、归一化用例。确认失败。
2. [x] schema + default-state：`pinNewSessionDefaults` 字段、默认值、归一化。
3. [x] `shared/models.ts`：`listReasoningDefaultModels`。
4. [x] `src/state.ts`：`rememberModelReasoningEffort` 守卫、`setModelReasoningEffortDefault`、`selectCardModel` / `addTab` / `addColumn` 分支；`updateSettings` 允许新字段。
5. [x] 设置面板 `reasoning-defaults` 项 + 文案 + 目录 + CSS。
6. [x] theme-check 快照 `reasoning-defaults-settings-{dark,light}`。
7. [x] `pnpm test:quality`、窄测试、快照；AGENTS.md 坑位表补一行；打包。
