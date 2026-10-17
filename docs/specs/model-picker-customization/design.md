# 模型选择器：滚轮切换 + 自定义下拉项 — Design

## 数据形状（`shared/schema.ts` → `appSettingsSchema`）

```ts
// 键是 `${provider}:${model}`（与 ChatCard getSelectValue 同形；「默认」项的 model 为空串，键是 `codex:`）
modelPickerVisibility: z.record(z.string(), z.boolean()).default({})
modelPickerCustomModels: z.array(modelPickerCustomModelSchema).default([])
// modelPickerCustomModelSchema = { id, provider, model, label }
```

- **覆盖表而不是「可见名单」**：只记用户亲手改过的项。存可见名单的话，以后内置目录新上架一个型号，所有存过名单的人都看不到它；下架的型号也会被名单永远钉在下拉里。覆盖表让没碰过的项继续跟随 `hiddenFromPicker`。
- 归一化（`normalizeAppSettings`）：覆盖表丢掉非布尔值、空键、工具卡键；自定义项按 `createModelPickerCustomModel` 清洗（trim、provider 非法回落 codex、模型名不合形状/是工具卡或本地令牌则丢弃、按 id 与 `provider:model` 去重）。
- 写入走现有 `updateSettings` patch，不新增 reducer action。

## 纯函数（`shared/models.ts`）

- `getModelPickerOptionKey(option)` → `${provider}:${model}`。
- `isModelPickerOptionEnabled(option, visibility)`：工具卡永远 false；覆盖表有布尔值就用它；否则 `!hiddenFromPicker`。原 `isModelPickerOptionVisible` 保持不变（看板、超管目录仍按内置可见性）。
- `listConfigurableModelPickerOptions()`：设置面板要列的内置项 = `MODEL_OPTIONS` 去掉工具卡。
- `isValidCustomPickerModelName(model)`：复用 `customModelNamePattern` + 排除工具卡/本地令牌。
- `buildModelPickerOptions({ localModelEntries, customization, current, mode })`：
  1. `mode: 'chat'`：本地条目 → 自定义项 → 当前卡模型的临时自定义项（不在目录且不在自定义项里时）→ 内置项（启用的 + 当前选中的那一项）。
  2. `mode: 'brainstorm'`：不含本地条目，不含 `usesConfiguredDefault` 项。
  3. 按键去重，先到先得。
- `stepModelPickerOption(options, currentKey, direction)` → 目标键或 `null`（到头/空列表/找不到当前项时，找不到当前项则向下取第一项、向上取最后一项）。

## 滚轮（`src/components/ChatCard.tsx`）

- 累积器抽到 `src/components/wheel-step.ts`：`createWheelStepAccumulator()` 返回 `(event) => 1 | -1 | 0`（1 = 向上滚）。思考档位旋钮改用它，行为不变（同阈值 16、200ms 清零、deltaMode 换算）。
- 原生 `wheel` 监听挂在 `.model-select` 按钮本身，`{ passive: false }`（React 根 wheel 监听是 passive，`preventDefault` 无效，见 pitfall #129B）。按钮在卡头和输入框两处各渲染一份，用 React 19 回调 ref（返回清理函数）各自挂监听；处理函数读 `modelWheelRef`（每次渲染刷新），所以监听不必随状态重挂。
- 预览 + 延迟提交：
  - `wheelPreviewKey` 本地 state；按钮显示 `wheelPreviewKey` 对应项（没有则显示真实当前项）。
  - 每格：以预览键（或当前键）为起点 `stepModelPickerOption`，更新预览、重设 450ms 计时器。
  - 提交 `flushWheelPreview()`：清计时器与预览；目标键 ≠ 当前键时走与点击下拉项同一个 `applyModelPickerOption`。
  - 触发提交：计时器到点、`pointerleave` 按钮、`handleSubmit` 开头、组件卸载。
  - 不处理：按钮 disabled（流式中）、下拉菜单打开。
- 为什么不逐格提交：`selectCardModel` 是复合动作（作废/保留 session、跨 provider 存取 providerSessions、含图卡清会话、记 lastModel），经过中间型号会把会话状态折腾一遍，且每格都会落盘。

## 设置面板

- `settings-model.ts` 新增条目 `model-picker`（category `models`，tier `basic`，不进落地页 `basicViewOrder`）。
- `App.tsx` 渲染：
  - 内置项按 provider 分组的勾选列表（`settings-toggle` 同款 checkbox）。勾选状态 = `isModelPickerOptionEnabled`；改动时若新值等于内置默认则从覆盖表删除该键，否则写入。
  - 自定义项列表：每行「provider · 模型名 · 显示名」+ 删除按钮；底部一行草稿（provider select + 模型名 + 显示名 + 添加）。不合法/重复时添加按钮禁用。
  - 「恢复默认」按钮：清空覆盖表。
- 文案进 `src/app-panel-text.ts`。

## Props 透传

`App` 用 `useMemo` 组 `modelPickerCustomization = { visibility, customModels }`（依赖两个 settings 字段的引用），沿 `localModelEntries` 同一条链：`WorkspaceColumn` → `LayoutRenderer`（展开 props）→ `PaneView` → `ChatCard`；`layout-memoization.ts` 两个比较器与 ChatCard 的比较器各加一行引用比较。

## 被否决的替代

- 下拉菜单里直接右键「隐藏此项」：发现性差，且用户明确要「在设置里」。
- 把自定义项并进 `localModelEntries`：本地条目带端点/密钥并以令牌进卡，语义是「另一个服务」；自定义项只是同一路由下多一个模型名，走现有的自定义模型名路径（`getCustomModelOption` 同形）。
