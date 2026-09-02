# Fable 5.1 换代 — 设计

## 1. `shared/models.ts` — 模型表

`MODEL_OPTIONS` 的 Claude 段（顺序即选择器顺序）：

| label | model | aliases | 备注 |
|---|---|---|---|
| Fable 5.1 | `claude-fable-5-1` | `fable`, `fable-5.1`, `claude-fable-5-1` | 裸 `fable` 跟随最新一代 |
| Fable 5（选择器隐藏） | `claude-fable-5` | `fable-5`, `claude-fable-5` | 仅兼容旧卡片与精确输入 |
| Opus 5 | `claude-opus-5`（默认） | 不变 | |
| Sonnet 5 | `claude-sonnet-5` | 不变 | |
| Sonnet 4.6（选择器隐藏） | `claude-sonnet-4-6` | 不变 | |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | 不变 | |

`resolveSlashModel` 按 `MODEL_OPTIONS` 顺序取首个命中，且 label 本身参与匹配
（`Fable 5` 规整后即 `fable-5`）。因此 5.1 条目必须排在 legacy 条目之前，
而 legacy 条目不能再持有 `fable` 这个裸别名。

## 2. `isFableModel` — 判定单点化

```ts
// shared/models.ts
export const isFableModel = (model?: string | null): boolean => {
  const normalized = model?.trim().toLowerCase() ?? ''
  return (
    normalized.includes('claude-fable-') ||
    normalized === 'fable' ||
    normalized.startsWith('fable-')
  )
}
```

调用点：

| 位置 | 原判定 | 换代后果（未修时） |
|---|---|---|
| `shared/reasoning.ts` `isClaudeAlwaysThinkingModel` | `includes('claude-fable-5')` | 侥幸兼容 5.1 |
| `src/state.ts` 陈旧列继承保护 | `=== 'claude-fable-5'` | **失效**：在 Sonnet 上聊过的 pane 新建 tab 又被拉回 2 倍价的 Fable |

前缀取 `claude-fable-` 而非官方原文的 `claude-fable-5`：代际号不该进判定条件。
最坏退化是未来某代 Fable 若改成可关思考，会多送一次 `high` —— 代价远小于漏改。

这与 `TOOL_CARD_MODELS` 那次（Pitfall #263）是同型问题：同一份名单/判定被手抄多份，
新增一项时必然漏改其中几处。处理方式一致 —— 单点定义，别处一律引用。

## 3. 头脑风暴请求模型选单

`ChatCard.tsx` 的 brainstorm 分支曾另抄一份 `!TOOL_CARD_MODELS.has(model)` 过滤
（局部常量 `hiddenBrainstormRequestModels`，正是 Pitfall #263 点名的四份手抄之一），
于是后加的 `hiddenFromPicker` 只在普通选择器生效。新增 legacy Fable 5 条目会让这个
既有缺口直接可见（下拉里冒出一个已下架的「Fable 5」）。

改为共享出口：

```ts
// shared/models.ts
export const isBrainstormRequestModelVisible = (option) =>
  !option.usesConfiguredDefault && isModelPickerOptionVisible(option)
```

并删除 `hiddenBrainstormRequestModels`。

## 4. 测试

| 行为 | 测试 |
|---|---|
| 选择器可见项 / legacy 隐藏 | `tests/models.test.ts` |
| 别名解析（裸 `fable` 跟新、`fable-5` 跟旧） | `tests/models.test.ts` |
| 头脑风暴选单不含下架型号 | `tests/models.test.ts` |
| Fable 判定跨代际（5 与 5.1 同等对待） | `tests/reasoning.test.ts` |
| 陈旧 Fable 5.1 列不覆盖 pane 最近聊天模型 | `tests/state.test.ts` |

`tests/state.test.ts` 的红测试必须让 provider 解析成 `claude`（pane 里要有一张 Claude 聊天卡），
否则 `rememberedColumnModel` 因 provider 不匹配提前变 `undefined`，根本走不到陈旧列判定
—— 已有的那条 tool-only pane 用例就是这种情况，它测的是另一条路径。
