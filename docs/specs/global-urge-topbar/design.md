# 全员鞭策（Global Urge）— 设计

## 数据模型（shared/schema.ts + shared/default-state.ts）

`appSettingsSchema` 新增三个字段（都持久化）：

| 字段 | 类型 | 默认 | 含义 |
|------|------|------|------|
| `autoUrgeGlobalControlEnabled` | boolean | `false` | 设置面板"全员鞭策按钮"勾选框 |
| `autoUrgeGlobalActive` | boolean | `false` | 顶部栏全员鞭策开关状态 |
| `autoUrgeGlobalProfileId` | string | `defaultAutoUrgeProfileId` | 顶部栏鞭策类型选择 |

归一化：`normalizeAutoUrgeSettings()` 校验 `autoUrgeGlobalProfileId` 必须存在于归一化后的 `autoUrgeProfiles`，否则回退到活动 profile。两个布尔在 `normalizeAppSettings()` 主体按现有布尔模式兜底（pitfall 5）。

`state.ts` 的 `updateSettings` action 允许键列表加这三个键。

## 生效合成（src/components/chat-auto-urge.ts）

新增纯函数：

```ts
resolveEffectiveAutoUrge({
  cardAutoUrgeActive, cardAutoUrgeProfileId,
  globalUrgeActive, globalUrgeProfileId, isToolCard,
}) => { active, profileId, source: 'card' | 'global' | 'none' }
```

优先级：卡自身开启 → `card`；否则全局开启且非工具卡 → `global`；否则 `none`。

## props 链

App 层计算一次：

```
globalUrgeActive = autoUrgeEnabled && autoUrgeGlobalControlEnabled && autoUrgeGlobalActive
globalUrgeProfileId = settings.autoUrgeGlobalProfileId
```

两个原始值 props 传 `WorkspaceColumn → PaneView/LayoutRenderer → ChatCard`（原始值对 memo 友好；ChatCard 的 memo 比较列表补这两项）。

## ChatCard 行为

- `resolveEffectiveAutoUrge` 的结果替代原 `autoUrgeActive` 参与：profile 查找（`source==='global'` 时用全局 profileId）、`autoUrgeStateRef.active`、composer"鞭策运行中"状态显示。
- composer 里的逐卡鞭策勾选仍只反映 `card.autoUrgeActive`（点击行为不变）。
- `evaluateAutoUrge` 返回 `disable` 时，仅当 `source==='card'` 才 `patchCard({ autoUrgeActive: false })`；`global` 源的 disable 表示"本轮已见成功关键词"，不写卡（本来就是 false）。
- 新 effect：`globalUrgeApplies`（source==='global'）从 false→true 且卡 idle 时触发一次 `manual-activation`（与逐卡开关打开即发一致）。用 ref 存前值，mount 首帧不触发。

## 顶部 UI（src/App.tsx + src/index.css）

`app-topbar-frame` 内、`app-tab-list` 之后、窗口控制之前，当 `autoUrgeEnabled && autoUrgeGlobalControlEnabled` 时渲染 `.app-topbar-urge`：

- checkbox 开关（label"全员鞭策"），写 `updateSettings { autoUrgeGlobalActive }`；
- `<select>` 鞭策类型，选项来自 `autoUrgeProfiles`，写 `updateSettings { autoUrgeGlobalProfileId }`。

样式用现有主题 token（`--color-*`），双主题验证；控件区在自定义窗框下需要 `-webkit-app-region: no-drag`（topbar 可拖拽区域内的交互控件惯例，若 topbar 有 drag region）。

## 设置面板（src/App.tsx）

自动鞭策块（`autoUrgeEnabled` 展开区）内、鞭策类型列表之前，加勾选框"全员鞭策按钮"+ 说明文字，写 `updateSettings { autoUrgeGlobalControlEnabled }`。

## i18n（shared/i18n.ts）

新增：`autoUrgeGlobalControlLabel`（全员鞭策按钮）、`autoUrgeGlobalControlHint`（说明）、`autoUrgeGlobalToggleLabel`（全员鞭策）、`autoUrgeGlobalTypeAriaLabel`（全员鞭策类型）。zh-CN + en 两份。

## 测试

- `tests/chat-auto-urge.test.ts`：`resolveEffectiveAutoUrge` 三态 + 工具卡排除 + profile 选择。
- `tests/auto-urge-settings.test.ts`：新字段默认值、旧存档缺字段归一化、非法 `autoUrgeGlobalProfileId` 回退。
- UI 为浅层接线（Tier 2 部分），当前 Playwright harness 有已知噪音（pitfall 25/34），以逻辑层单测 + `test:quality` 为主要门。
