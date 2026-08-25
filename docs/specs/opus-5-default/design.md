# Opus 5 作为 Claude 默认模型 — 设计

## 1. `shared/models.ts`

唯一改动点。`MODEL_OPTIONS` 的 Claude 段变为（顺序即选择器顺序）：

| label | model | aliases |
|---|---|---|
| Fable 5 | `claude-fable-5`（不变） | `fable`, `fable-5`, `claude-fable-5` |
| **Opus 5** | **`claude-opus-5`（新默认）** | **`opus`, `opus-5`, `claude-opus-5`** |
| Sonnet 5 | `claude-sonnet-5`（不变） | 不变 |
| Sonnet 4.6 | `claude-sonnet-4-6`（旧值保留，选择器隐藏） | 不变 |
| Haiku 4.5 | `claude-haiku-4-5-20251001`（不变） | 不变 |

`DEFAULT_CLAUDE_MODEL = 'claude-opus-5'`。

模型表不再暴露 Opus 4.8 选项或斜杠别名，但 `normalizeStoredModel` 仍不得改写已保存的
`claude-opus-4-8`（Pitfall #119），确保历史卡片继续使用原模型。

## 2. 波及面（无需改动，仅确认）

`DEFAULT_CLAUDE_MODEL` 是共享常量，以下引用点自动跟随新值：

- `shared/schema.ts` — `requestModels.claude` 的 zod 默认值与两处初始状态
- `shared/default-state.ts` — 默认设置
- `src/components/brainstorm-card-utils.ts` — Claude 回退模型
- `src/App.tsx` — 设置面板两处 placeholder

`shared/reasoning.ts` 不动：`isClaudeAlwaysThinkingModel` 只匹配 fable 形态，
Opus 5 沿用 Opus 系的普通档位（默认 `max`、可关思考）。

## 3. 测试

| 覆盖 | 文件 | 断言 |
|---|---|---|
| 默认值 | `tests/models.test.ts` | `DEFAULT_CLAUDE_MODEL === 'claude-opus-5'` |
| 选择器顺序 | 同上 | claude 选项列表含 `claude-opus-5`，其后直接为 Sonnet 5 |
| 别名 | 同上 | `opus` / `opus 5` / `claude-opus-5` → Opus 5；Opus 4.8 别名不再解析 |
| 不迁移 | 同上 | `normalizeModel('claude', ' claude-opus-4-8 ')` 原样返回 |
