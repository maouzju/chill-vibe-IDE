# 默认模型换代提示 — 设计

- 判定表：`shared/models.ts` 的 `MODEL_SUCCESSORS`（旧型号→最新同档型号，单跳）。新型号上架在此加一行。
  `findModelUpgradeSuggestions(requestModels, acknowledged)` 为纯函数；键格式 `provider:旧>新`。
- 已读名单：`settings.acknowledgedModelUpgrades: string[]`（schema 默认 `[]`）。
  - `createDefaultSettings()` = 当前全部已知键（全新安装已读）。
  - `normalizeAppSettings(settings)`：有 settings 但缺字段 → `[]`（老存档会被提示）；settings 缺失 → 默认。
- UI：`App.tsx` 用 `useMemo` 从设置推导待提示项，**无独立 open 状态**；`loadStatus==='ready'` 且无引导 / 恢复弹窗时显示，
  复用 `structured-preview-*` 弹窗样式，文案走 `shared/i18n.ts`（`modelUpgradeDialog*`）。
  任一出口都把键写入 `acknowledgedModelUpgrades`，故「一次」由落盘设置保证。
- 被否决：静默自动换（默认模型是用户选择，且影响计费）；弹窗用独立 `useState` 控制（刷新/重启会重复弹）。
- Playwright 夹具 `createPlaywrightState` 默认带全部已读键，避免 55 条用例被弹窗盖住；测弹窗的用例显式传 `[]`。
