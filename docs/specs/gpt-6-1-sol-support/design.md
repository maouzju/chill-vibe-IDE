# GPT-6.1 Sol 支持设计

## 事实依据（2026-09-30）

- 官方 Codex 0.159.2 `model/list`：`gpt-6.1-sol` 提供 low/medium/high/xhigh/max/ultra，`defaultReasoningEffort=low`，`supportsPersonality=false`，`serviceTiers` 含 `priority`（Fast），输入文本+图片，`isDefault=true`。`ultra` 是 CLI 的自动任务委派档，不是直接 API 的 `reasoning.effort`。
- 官方 API 文档：档位 low…max，默认 medium，`none`/`minimal` 不支持；CLI 目录的默认档（low）与 API 默认不同，应用驱动的是 CLI，按 CLI 目录取默认。
- 真实中转站探针（用户的 duckcoding，本机 CLI 0.156.1，`scripts/probe-codex-app-server.mjs` 走 app-server `turn/start`）：
  - `effort=none` → 整轮 400：`gpt-6.1-sol does not support reasoning effort 'none'; use low, medium, high, xhigh, max, ultra`。
  - `effort=low` → 正常完成。
  - 对照 `gpt-6-sol`、`gpt-6-luna` 用 `effort=none` 均正常完成——`none` 是否合法是**逐型号**的，不是 Codex 全局属性。
- 本机全局 CLI 0.156.1 的目录里没有 6.1 Sol：能用，但会警告 `Model metadata for gpt-6.1-sol not found. Defaulting to fallback metadata`，上下文窗口回落到 258400。升级全局 CLI 到 ≥0.159 即消除，应用侧不受影响。

## 模型目录

`shared/models.ts` 增加 `GPT-6.1 Sol` 条目，放在 `Codex` 默认项之后、`GPT-6 Sol` 之前（新一代在前，与 Claude 目录一致）。

`DEFAULT_CODEX_MODEL` 保持 `gpt-6-sol`：2026-08-14 教训——默认落在服务商没上架的型号上，Codex 开箱即死（`unknown provider for model ...`）。本机中转站已列出 `gpt-6.1-sol`，但同事的中转站不一定。想换默认是改这一个常量。

裸别名 `sol`、`6` 留在 GPT-6 Sol：默认没动，`/model sol` 就不该悄悄换成另一代；6.1 用显式别名。`canonicalizeModelAlias` 不剥点号，`6.1` 与 `6` 不会撞。

## 推理档位与关闭思考

Astra 与 6.1 Sol 在目录里同时具备四条性质：六档、缺省 low、没有 `none`、不收 personality。判定统一改为 `shared/models.ts` 的 `isCodexNoneEffortUnsupportedModel`（取代只认 Astra 的 `isAstraModel`），请求出口、`server/providers.ts` 的 personality、两处 UI 全部引用它，不在各处手写名单。

- `shared/reasoning.ts`：该组型号返回六档、缺省 low；`toCodexEffortValue` 在 `thinkingEnabled === false` 时发 `low`，其它型号仍发 `none`。app-server（`buildCodexTurnStartParams`）与 exec（`buildCodexArgs`）共用这个出口。
- `server/providers.ts`：该组型号的 `turn/start` 省略 `personality`，其它字段（`serviceTier` 等）不变。
- `ChatCard` / `AutomationBoardCard`：思考开关显示为开启且禁用；旧 `false` 显示实际的 low，选深度时同步恢复 `thinkingEnabled`，避免 UI 选 max、请求仍发 low。不做启动时的存量迁移。

被否决：
- 在每处补一个 `|| model === 'gpt-6.1-sol'`——给同一份漏名单再补一处，下一代必然再漏。
- 立即上「型号能力表」（档位/默认档/none/人格一张表）——目前只有一组同质型号，属于为假想需求设计；出现第一个「性质只成立一部分」的型号时再拆。
- 前缀匹配（如带日期快照名）——没有实证，保持与 Astra 一致的精确匹配。

## 不变项

- Fast：`codexFastMode` 是全局 `serviceTier: priority`，与型号无关，6.1 Sol 目录本身也带 `priority`，无需改动。
- 上下文窗口：由 CLI 自报，应用内没有按型号的窗口表。
- GPT-6 Sol / GPT-6 Luna 的目录同样标了 `supportsPersonality=false`，但现网一直在发 personality 且能正常完成，缺证据，不在本任务里改。

## 已知限制

- Ultrafast 档（官方称「未来几天」上线）尚未发布，不在范围内。
- 旧 CLI 自带的 `spawn_agent` 型号目录不含 6.1 Sol；我们的子 agent 提示词按自己的目录列出它。子 agent 若显式选它，最坏是工具报错后回退继承父模型；升级 CLI 后自动消失。

## 验证

共享目录/推理/请求出口单测（含 fake app-server 抓 `turn/start`），聊天与自动化模板的双主题 Playwright 用例，`pnpm test:quality`，Electron 构建。中转站 `none`/`low` 探针结果见上。
