# Tasks: 设置面板新手友好重构

## Slice 1 - 纯逻辑（Tier 1，红→绿）

- [x] 红：`tests/settings-model.test.ts`
  - 目录：每个 id 唯一；六个分类都非空；基础项恰好是 language-theme / account / models / update；danger 在系统分类且排最后；experimental 排在普通项之后。
  - 搜索：空串返回全部；中文界面搜 "proxy" 命中断线重连；搜 "思考" 命中模型项；大小写不敏感；无命中返回空数组。
  - 健康灯：无数据 → unknown；双 CLI 可用 → ok；仅一个 → warn + install-cli；有 profile → account ok；关路由 → ok；无 profile → warn + connect-account；compat active → ok；系统版本不一致 → warn + install-compat（未装）/ activate-compat（已装未激活）。
  - 向导：loading / setup / 跳过后到 account / 导入或填 key 或已有 profile 后到 model / 确认后 complete。
- [x] 绿：`src/components/settings/settings-model.ts`

## Slice 2 - 面板壳 + App 接线（Tier 2 视觉 + 低风险胶水）

- [x] `src/components/settings/settings-text.ts`、`SettingsPanel.tsx`、`EnvironmentHealthCard.tsx`
- [x] `App.tsx`：删除 `showLegacySettingsPanel` 死代码；`settingsGroupNodes` → `settingsItems`；provider profile / 代理 / 代理统计 JSX 抽成可复用节点，接口页与设置页共用；健康卡数据（cli-compat 状态）在 settingsOpen 时拉取；修复动作接线。
- [x] `src/index.css`：导航 / 搜索 / 折叠 / 健康卡 / 一般不用动 / 实验标签样式（双主题）。
- [x] `src/settings-layout.ts`：`splitSettingsGroupsIntoStableColumns` / `getStableSettingsPanelColumnCount` 随多列布局一并下线，测试同步删。

## Slice 3 - 向导 3 步

- [x] `src/app-helpers.ts` `OnboardingStage` 扩展；`App.tsx` 用 `resolveOnboardingWizardStage`；账号步加 API key 表单；模型步加默认模型选择；摘要列表 3 格。
- [x] `src/app-panel-text.ts` 新增向导文案（中英）。

## Slice 4 - 测试对齐

- [x] Playwright：`tests/theme-check.spec.ts` / `tool-card-settings.spec.ts` / `auto-urge.spec.ts` / `settings-hover-hints.spec.ts` / `local-model-panel.spec.ts` 改为先切分类 + 展开高级；瀑布流两条用例改为「导航 + 单列」断言；快照按需重生成（对照 stash 基线，不追 14 个基线红）。
- [x] `pnpm exec tsc --noEmit`（或 `pnpm check`）、窄 Node 测试、`pnpm test:quality`。

Verification (2026-09-23): 红→绿 —— `tests/settings-model.test.ts` 先因模块缺失整文件红，实现后 14/14 绿；`getBasicSettingsItems` 顺序用例先红后绿（15/15）。`pnpm exec tsc -p tsconfig.app.json` 只剩 main 上既有的 `PaneView.tsx findPaneForTab` 两条（stash 基线同样存在，与本次无关）；`pnpm lint` 通过。Playwright（复用 5173 dev server）：theme-check 设置相关 31 用例、tool-card-settings / auto-urge / settings-hover-hints / local-model-panel / routing-import / panel-persistence / github-shell 共 34 用例、onboarding-guide 2 用例全绿；快照有意重生成（设置项外壳现在带标题行 + 人话提示；`settings-panel-card-{grid,stack}` 四张随瀑布流下线，新增 `settings-panel-basics-*` / `settings-panel-narrow-*` / `tool-cards-settings-group-*`）。
