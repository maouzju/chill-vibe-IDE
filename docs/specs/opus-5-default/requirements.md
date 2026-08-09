# Opus 5 作为 Claude 默认模型 — 需求

## 背景

Anthropic 发布了 Opus 层的新一代模型 **Opus 5**（`claude-opus-5`），能力高于 Opus 4.8。
Chill Vibe 的 Claude 模型表此前把 `claude-opus-4-8` 作为 `DEFAULT_CLAUDE_MODEL`
（见 [`../fable-5-follow-up/requirements.md`](../fable-5-follow-up/requirements.md) R1，该条已被本 SPEC 取代）。

## 需求

### R1 模型表更新

- Claude 模型选择器提供 **Opus 5**（`claude-opus-5`），排在 Fable 5 之后。
- `DEFAULT_CLAUDE_MODEL` 改为 `claude-opus-5`：新会话、未配置的 `requestModels.claude`、
  brainstorm 卡片回退模型等所有默认路径一并跟随。
- 裸别名 `opus` 改指 `claude-opus-5`，与裸 `sonnet` 移交 Sonnet 5 的处理一致。
- **Opus 4.8 不再作为模型选项或斜杠命令别名提供**，避免继续把已被 Opus 5
  取代的模型展示为可选项；历史卡片中已保存的 `claude-opus-4-8` 仍原样保留，
  不做静默迁移（Pitfall #119）。

### R2 思考档位不变

- Opus 5 走普通 Claude 档位路径（默认 `max`，思考可关），
  **不**进入 `isClaudeAlwaysThinkingModel` 的 Fable 分支 —— 该判定只匹配 `claude-fable-5`
  与裸 `fable*` 形态，`claude-opus-5` 不会误命中，`shared/reasoning.ts` 无需改动。

## 验收

- `pnpm test` 全绿（含 `tests/models.test.ts` 新增的默认值 / 别名 / 不迁移断言）。
- `pnpm test:quality` 通过。
- 本机 CLI 实测：`claude --model claude-opus-5 -p "..."` 正常返回。
