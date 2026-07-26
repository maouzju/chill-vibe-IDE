# Opus 5 作为 Claude 默认模型 — 任务

- [x] T1 红：在 `tests/models.test.ts` 增加默认值 / 选择器顺序 / 别名 / 不迁移断言，确认 4 项失败
- [x] T2 绿：`shared/models.ts` 改 `DEFAULT_CLAUDE_MODEL` 为 `claude-opus-5`，新增 Opus 5 条目，
      Opus 4.8 降为精确别名条目
- [x] T3 确认 `shared/reasoning.ts` 无需改动（`isClaudeAlwaysThinkingModel` 只匹配 fable 形态）
- [x] T4 验证：`tests/models.test.ts` 8/8 通过；`pnpm test` 1648/1648 通过；`pnpm test:quality` 通过；
      本机 CLI 实测 `claude --model claude-opus-5 -p ...` 正常返回
- [x] T5 文档：新建本 SPEC，并在 `docs/specs/fable-5-follow-up/` 标注被取代的两条
