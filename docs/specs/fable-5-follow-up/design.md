# Fable 5 功能跟进 — 设计

## 1. `shared/models.ts`

`MODEL_OPTIONS` 的 Claude 段变为（顺序即选择器顺序，Fable 5 作为最强模型放最前）：

| label | model | aliases |
|---|---|---|
| Fable 5 | `claude-fable-5` | `fable`, `fable-5`, `claude-fable-5` |
| Opus 4.8 | `claude-opus-4-8`（默认，不变） | `opus`, `opus-4.8`, `claude-opus-4-8` |
| Sonnet 5 | `claude-sonnet-5` | `sonnet`, `sonnet-5`, `claude-sonnet-5` |
| Sonnet 4.6 | `claude-sonnet-4-6` | `sonnet-4.6`, `claude-sonnet-4-6`（裸 `sonnet` 移交 Sonnet 5） |
| Haiku 4.5 | `claude-haiku-4-5-20251001`（不变） | 不变 |

无迁移逻辑：`claude-sonnet-4-6` 仍是合法可用模型（Pitfall #119）。

## 2. `shared/reasoning.ts` — 模型感知层

新增（全部纯函数，provider 级旧函数保留不动，避免波及 Codex/Git 调用点）：

```ts
// 官方识别规则是"model id 含 claude-fable-5"；宽松涵盖手输别名形态。
isClaudeAlwaysThinkingModel(model?: string | null): boolean
  // model 含 'claude-fable-5'，或规整后等于/前缀为 'fable'（'fable', 'fable-5'）

getDefaultReasoningEffortForModel(provider, model): ReasoningEffort
  // claude + fable → 'high'；其余走 getDefaultReasoningEffort(provider)

getReasoningOptionsForModel(provider, model, language): ReasoningOption[]
  // claude + fable → 过滤掉 'auto'；其余同 getReasoningOptions

normalizeReasoningEffortForModel(provider, model, effort): ReasoningEffort
  // 先 normalizeReasoningEffort；claude + fable 且结果为 'auto' → 'high'
  // 空/未知值在 fable 上落到模型默认 'high' 而非 provider 默认 'max'

toClaudeEffortFlagValue(model, effort, thinkingDisabled): string
  // 统一出口，替代 buildClaudeArgs 内联三元：
  //   fable：thinkingDisabled 或 auto → 'high'；ultracode → 'xhigh'；其余原样
  //   非 fable：thinkingDisabled 或 auto → 'none'；ultracode → 'xhigh'；其余原样
```

`auto → none` 的归一化收敛了一个既有边缘：旧代码只在 `thinkingDisabled` 时发 `none`，若卡片带 `auto` 但 `thinkingEnabled !== false` 会把非法值 `auto` 发给 `--effort`。

## 3. `server/providers.ts` — `buildClaudeArgs`

- `effortFlagValue` 改用 `toClaudeEffortFlagValue(request.model, request.reasoningEffort, thinkingDisabled)`。
- `--settings` JSON 增加 `...(ultracodeActive ? { ultracode: true } : {})`。
- 删除 `getClaudeUltracodeInstruction` 及其注入（系统提示不再包含 ultracode 关键词）。
- `ultracodeActive` 判定不变（`isUltracodeEffort`），`--effort` 仍发 `xhigh`。

## 4. `shared/default-state.ts` — `createCard`

`reasoningEffort` 参数默认值从 `getDefaultReasoningEffort(provider)` 改为 `undefined`，函数体内用 `normalizeReasoningEffortForModel(provider, normalizedModel, reasoningEffort)` 求值 —— 新建 Fable 5 卡默认 `high`，其余卡行为不变（`normalizeReasoningEffortForModel` 对 undefined 落到模型级默认）。

## 5. `src/components/ChatCard.tsx`

- `reasoningValue`（行 ~2795）：`normalizeReasoningEffort` → `normalizeReasoningEffortForModel(effectiveProvider, card.model, ...)`。
- `reasoningOptions`（行 ~2799）：`getReasoningOptions` → `getReasoningOptionsForModel(effectiveProvider, card.model, language)`（依赖数组补 `card.model`）。
- 思考开关（行 ~3793）：`disabled={fableAlwaysThinking}`、`checked={fableAlwaysThinking || card.thinkingEnabled !== false}`，其中 `fableAlwaysThinking = effectiveProvider === 'claude' && isClaudeAlwaysThinkingModel(card.model)`。
- 档位下拉 `disabled`（行 ~3805）：补 `&& !fableAlwaysThinking`（Fable 上思考恒开，档位始终可选）。

## 6. 测试策略（Tier 1，红先）

| 面 | 文件 | 断言 |
|---|---|---|
| 模型表 | `tests/models.test.ts` | claude 选项列表含 fable/sonnet-5 新顺序；`fable`/`sonnet`/`sonnet-4.6` 别名解析；`claude-sonnet-4-6` 直传不迁移 |
| 档位 | `tests/reasoning.test.ts` | fable 默认 high、菜单无 auto、auto 归一 high、opus 行为不变、`toClaudeEffortFlagValue` 行为表 |
| CLI 参数 | `tests/provider-system-prompt.test.ts` | fable + 思考关闭 → `--effort high` 非 `none`；opus + 思考关闭 → `none` 不变；ultracode → settings JSON 含 `"ultracode":true` 且系统提示无注入、`--effort xhigh` |
| createCard | `tests/reasoning.test.ts` | `createCard(..., 'claude', 'claude-fable-5')` 默认 `high`，默认模型卡仍 `max` |

UI 封装（第 5 节）为低风险 glue，走 prove-after：类型检查 + 现有测试通过，核心分支已由 shared 层单测覆盖。

## 7. 风险

- 旧 CLI 对 `--settings` 未知键 `ultracode` 的容忍：Claude Code settings 校验为宽松模式（未知键警告不报错），最坏退化为 xhigh；本机对新 CLI 做一次 smoke。
- `sonnet` 裸别名移交 Sonnet 5 后，仅影响新的 `/model sonnet` 输入；已持久化的完整 id 不受别名变化影响。
