# Design: 设置面板新手友好重构

## 结构

```
src/components/settings/
  settings-model.ts        纯逻辑：分类目录、搜索过滤、健康灯判定、向导步进（无 React）
  settings-text.ts         新增文案（zh-CN / en）：导航、搜索、分层、健康卡、人话提示、向导步骤
  SettingsPanel.tsx        面板壳：左导航 + 搜索 + 基础/高级折叠 + 单列内容
  EnvironmentHealthCard.tsx 三盏灯 + 一键修复
```

`App.tsx` 仍然负责**生产每一项的控件 JSX**（它们闭包了上百个 handler，整体搬家风险远大于收益），但不再自己排版：它把每一项包装成 `{ id, node }` 交给 `SettingsPanel`，面板按 `settings-model.ts` 里的目录决定分类、分层、顺序、标签与提示。

### 目录（settings-model.ts）

```ts
type SettingsCategoryId = 'get-started' | 'models' | 'appearance' | 'automation' | 'network' | 'system'
type SettingsItemMeta = {
  id: string
  category: SettingsCategoryId
  tier: 'basic' | 'advanced'
  label: { 'zh-CN': string; en: string }
  hint?: { 'zh-CN': string; en: string }   // 人话：做什么；拿不准就保持默认
  keywords?: string[]                        // 额外搜索词（两种语言混放）
  experimental?: boolean                     // 「实验」标签
  danger?: boolean                           // 危险区，永远最后
}
```

- 分类内顺序 = 目录声明顺序，但 `experimental` 永远排在普通项之后、`danger` 永远最后（`orderSettingsItems`）。
- `filterSettingsItems(items, query, language)`：大小写不敏感，匹配 label / hint / keywords 的**两种语言**（用户可能在中文界面里搜 "proxy"）。空串返回全部。
- 老 group 标题（"Agent 安全防护"、"卡片类型"、"本地模型"…）尽量沿用为项标签，减少 Playwright 定位改动。

### 面板（SettingsPanel.tsx）

- 状态全部在内存：`activeCategory`（默认 get-started）、`query`、`advancedOpen: Partial<Record<CategoryId, boolean>>`。
- 无搜索词：渲染当前分类的 basic 项 → `<details class="settings-advanced">`（summary = 高级设置，`open` 受控）包着 advanced 项。系统分类里实验/危险项外再套一层 `.settings-leave-alone` 标签。
- 有搜索词：忽略分类与折叠，平铺命中项，每项头部带分类 chip；无命中显示空态。
- 每一项渲染为 `.settings-group`（`id="settings-item-<id>"`）+ `h3.settings-group-title` + 可选 `.settings-item-hint`（人话提示，常驻一行——它是「这一组是什么」的组级介绍，ui-principles 第 3 条允许）。
- 左导航是 `role="tablist"` 的按钮列；窄视口（≤720px）导航折成横向 chip 行。

### 健康卡（EnvironmentHealthCard.tsx + deriveEnvironmentHealth）

输入：`onboardingStatus.environment.checks`、`providers`（/api/providers）、`cliCompatStatus`（/api/cli-compat/status）、`settings.providerProfiles` / `cliRoutingEnabled`。

| 灯 | ok | warn | error | unknown |
|---|---|---|---|---|
| CLI 已安装 | claude 与 codex 都可用 | 只有一个可用 | 都不可用 | 还没拿到检测结果 |
| 账号可用 | 任一可用 provider 有带 key 的激活 profile；或关闭了 CLI 路由（走 CLI 自己的登录） | 有 CLI 但没有 profile | — | CLI 状态未知 |
| 版本兼容 | 每个可用 provider 都在用兼容版，或系统版本 == 兼容版本 | 某个 provider 版本不一致 / 未装兼容版 | — | 还没拿到 compat 状态 |

每盏灯附 `fix`：`{ kind: 'install-cli' } | { kind: 'connect-account' } | { kind: 'install-compat' | 'activate-compat', provider }`；App 把它们映射到 `handleRunSetup` / 跳转 account 项 / `installCliCompat` / `setCliCompatActive`。

### 向导（resolveOnboardingWizardStage）

```
loading  → 没拿到 onboardingStatus
setup    → 环境未就绪且没跳过
account  → 未导入 / 未跳过 / 未填 key / 没有现成 profile
model    → 用户还没确认默认模型
complete
```

`OnboardingStage` 联合类型加 `'account' | 'model'`；旧的 `'import'` 语义并进 `account`（cc-switch 可用时「立即导入」是这一步的主按钮，否则主按钮是「保存 API key」）。摘要列表从 2 格变 3 格。

### 样式

新增 token 只在 `src/index.css` 末尾的 `/* -- Settings: beginner layout -- */` 段；健康灯颜色复用 `--danger` / `#3aa76d`（已在 onboarding 用）/ `--accent`，深色主题靠现有 token 自动适配。

## 被否决的方案

- **把 1500 行控件 JSX 全部搬进新组件**：要么 props 爆炸（>80 个 handler），要么复制 App 状态；行为等价性没法用现有测试证明。目录 + 节点注入的方案保留了同一份 JSX，风险最小。
- **给折叠状态加持久化字段**：需求明确「不新增持久化」；折叠默认收起本身就是新手保护。
- **删掉「接口」tab**：Playwright 有 6 条用例、用户肌肉记忆都指着它；先做「两处都能到」。
