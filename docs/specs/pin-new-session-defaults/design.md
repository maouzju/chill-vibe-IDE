# 新会话默认档位 + 「卡上改动只管这一张」开关 — Design

## 数据

- `AppSettings.pinNewSessionDefaults: boolean`（schema default false，`createDefaultSettings` false，`normalizeAppSettings` 只认 `=== true`）。
- 档位表沿用现有 `settings.modelReasoningEfforts`，不新增结构——它本来就是「每个模型新会话的档位」，只是从没在设置里露过面。

## Reducer（`src/state.ts`）

- `rememberModelReasoningEffort`（卡上拧档位的出口，App 的 `changeCardReasoningEffort` 与手机远程都走它）：`pinNewSessionDefaults` 为 true 时原样返回 state。
- 新增 `setModelReasoningEffortDefault`：设置面板档位表的出口，不受开关影响，复用 `rememberModelReasoningEffort` 纯函数算补丁。两条出口分开，是因为「谁在改」决定了该不该被开关拦，而 reducer 看不到调用方。
- `selectCardModel`：记继承链的条件从 `rememberGlobalPreference` 变成 `rememberGlobalPreference && !pinNewSessionDefaults`（同时管 `lastModel` 与列种子）。
- `addTab`：开关开且没有显式 `action.model` 时，`model = getConfiguredModel(settings, provider)`，跳过列种子 / 活动卡 / `lastModel` 三层继承；provider 解析不变。
- `addColumn`：开关开时 `model = getConfiguredModel(settings, provider)`，不读 `lastModel.model`。

为什么开关开时连「旁边那张卡的模型」也不继承：用户说的是「新开窗口用默认」，同 pane 活动卡恰恰就是那张被特调过的卡，继承它等于把特调带进下一个窗口。

## 模型清单（`shared/models.ts`）

`listReasoningDefaultModels(settings)`：对 codex / claude 两个 provider，先放设置默认模型（`isConfiguredDefault: true`），再按 `buildModelPickerOptions` 的顺序放可见内置项与自定义项（去掉「用默认」占位项、本地令牌、工具卡），按 model 去重。纯函数，Node 可测。

## UI（`src/App.tsx` 设置面板）

- `settings-model.ts` 目录新增 `reasoning-defaults`（models 分类、basic、紧跟「默认模型」）。
- 节点内容：开关（`settings-checkbox` 行 + 说明）在上，下面每个 provider 一个 `fieldset.model-picker-group`，里面 `reasoning-defaults-grid` 两列：模型名 | 档位 `<select>`。
- 文案放 `src/app-panel-text.ts`（中英）。
