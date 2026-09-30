# 任务

- [x] 先写失败测试（目录/别名、六档与缺省 low、none→low 出口、personality 省略、子 agent 目录、聊天与模板 UI）。
- [x] `shared/models.ts`：增加 GPT-6.1 Sol 条目；`isAstraModel` 改为 `isCodexNoneEffortUnsupportedModel`。
- [x] `shared/reasoning.ts` / `server/providers.ts` / `ChatCard` / `AutomationBoardCard` 改用共享判定。
- [x] 目标测试、`pnpm test:quality`、双主题 Playwright 目标用例。
- [x] `pnpm electron:build` 并验证产物（`dist/release-20260930-115248`：app.asar + zip 齐全，包内含新型号与判定函数）。
