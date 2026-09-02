# Fable 5.1 换代 — 需求

## 背景

2026-09-02 核对官方 models overview：Fable 家族的当前一代是 **Claude Fable 5.1**
（`claude-fable-5-1`，$10/$50 每百万 token，1M 上下文，128K 输出，adaptive thinking 常开，
默认 effort `high`，可靠知识截止 2026-06）。上一代 **Claude Fable 5**（`claude-fable-5`）
被列入 legacy，仍可调用。官方选型建议是「多数场景先用 Opus 5，Opus 5 高 effort 仍不够时才上 Fable 5.1」。

本仓库的模型表停在 Fable 5，且「这是不是 Fable」的判定在两处各写各的字面量：

- `shared/reasoning.ts` 用 `includes('claude-fable-5')` —— 侥幸兼容 `claude-fable-5-1`；
- `src/state.ts` 用 `=== 'claude-fable-5'` —— 对新 id 直接失效。

换代不处理这条分叉，就会出现「档位约束还在、陈旧列保护没了」的半坏状态。

## 需求

### R1 模型表换代

- Claude 模型选择器里的 Fable 项变为 **Fable 5.1**（`claude-fable-5-1`）。
- 裸别名 `fable` 跟随最新一代，解析到 `claude-fable-5-1`（与裸 `opus` / `sonnet` 的语义一致）。
- `fable-5.1`、`claude-fable-5-1` 解析到 `claude-fable-5-1`。
- **Fable 5 保留为隐藏条目**：`claude-fable-5` 从选择器与 `/model` 可选列表下架，
  但精确别名（`fable-5`、`claude-fable-5`）仍解析到原 id，已保存的卡片不被静默改写
  （与 Sonnet 4.6 同一处理，Pitfall #119）。
- Fable 5.1 仍**不是**默认模型；`DEFAULT_CLAUDE_MODEL` 维持 `claude-opus-5`。

### R2 Fable 判定单点化

- 「这是不是 Fable」只在 `shared/models.ts` 定义一次（`isFableModel`），
  `shared/reasoning.ts` 的强制思考判定与 `src/state.ts` 的陈旧列继承保护一律引用它。
- 判定不含代际号：匹配 `claude-fable-` 前缀而非官方原文的 `claude-fable-5`，
  下一代 Fable 上线时不需要改判定才生效。
- `docs/specs/fable-5-follow-up/` 的 R2/R3（思考关不掉、默认档 `high`、档位菜单无 `auto`）
  行为不变，对 5.1 与 5 一致生效。

### R3 隐藏模型不得从头脑风暴选单漏出

- 头脑风暴卡的「请求模型」下拉与普通模型选择器同源，`hiddenFromPicker` 在两处一致生效。
- 差别只保留一条：头脑风暴请求必须指名具体模型，因此不提供「用默认模型」那一项。

## 非目标

- 不改默认模型、不改 Opus/Sonnet/Haiku 任何一项。
- 不做 `claude-fable-5` → `claude-fable-5-1` 的存量卡片迁移（静默换模型的风险大于收益）。
- 不跟进 Fable 5.1 的定价展示 / 上下文窗口相关 UI（本仓库不展示这些字段）。
