# 自定义主题设计

## 方案概览

“自定义”成为第四个主题选项，配色只属于它：

- `theme` 四选一：`light` / `dark` / `system` / `custom`。
- `customThemeBase` 决定自定义主题的明暗底色（默认 `dark`）。
- `accentColor` 保存用户选择的基础颜色；`null` 表示沿用当前底色的默认蓝。
- 内置三个主题不渲染配色控件，动态 accent token 只在 `theme === 'custom'` 时写入根节点；`accentColor` 在切回内置主题时保留在设置里，方便下次切回。

设置页在自定义主题下显示：底色浅/深切换（复用 theme-chip）+ 原生 `input[type=color]` 调色器 + 当前十六进制颜色 + 恢复默认按钮。所有变更直接派发既有 `updateSettings`，复用当前持久化队列。

## 数据结构

在 `shared/schema.ts` 中：

```ts
export const themeSchema = z.enum(['light', 'dark', 'system', 'custom'])
export const customThemeBaseSchema = z.enum(['light', 'dark'])
// appSettingsSchema 内
customThemeBase: customThemeBaseSchema.catch('dark').default('dark'),
accentColor: z.string().nullable().catch(null).default(null),
```

Schema 先用 `catch` 吞掉脏值，真正的收口放在 `normalizeAppSettings()`：`theme` 接受 `custom`；`customThemeBase` 只认 `light`，否则回 `dark`；颜色接受 `#rgb` / `#rrggbb`，统一输出小写 `#rrggbb`，其他输入回退为 `null`。旧文件和脏数据不会因为这些字段阻断启动。

`createDefaultSettings()` 与 `appStateSchema` 的默认 settings 同步加入 `customThemeBase: 'dark'` 与 `accentColor: null`。

## 主题解析

`resolveAppTheme(theme, prefersDark, customThemeBase = 'dark')`：`custom` 直接返回底色；`system` 跟随系统；其余原样。`src/theme.ts` 的 `getResolvedAppTheme` 与崩溃页 `renderer-crash-state.ts` 透传 `customThemeBase`。

## 底色取色器（surface tokens）

`shared/theme.ts` 追加：

- `getSurfaceBaseAppearance(color)`：按“黑/白文字哪个对比度更高”把任意底色判成 `light`/`dark`（决定 ink 模板），非法输入返回 `null`。
- `createThemeSurfaceTokens(color)`：从底色派生表面色板并写入根节点：`--page-bg`（底色本身）、`--page`、`--panel`/`--panel-strong`/`--panel-soft`、`--input-strong-bg(-focus)`、`--menu-bg`、`--empty-state-bg`。面板一律向白提亮，深底提 2%–13%、浅底提 40%–85%，透明度沿用内置模板的比例；`--line`/`--ink` 等前景族不覆盖，由 `data-theme` 模板自动适配。
- `getDefaultThemeSurfaceColor(theme)`：取色器未自定义时展示的内置底色（`#e2ddd5` / `#141a24`）。

交互：底色行 = 浅/深预设 chip + 取色器圆点 + 自定义时显示色值。取色时同一 patch 写入 `customBaseColor` 与按亮度自动判定的 `customThemeBase`（chips 失去高亮）；点任一预设 chip 写 `customThemeBase` 并把 `customBaseColor` 清回 `null`。surface token effect 与 accent 相同，以 `theme === 'custom'` 为闸门。取色器圆点使用 `--ink-4` 中性边框——底色 swatch 天然和面板同色，淡边框会“物理隐身”（见 AGENTS.md pitfall 149）。

## 配色生成

在 `shared/theme.ts` 增加纯函数：

- `normalizeAccentColor(value)`：颜色格式归一化。
- `createThemeAccentTokens(value, resolvedTheme)`：生成当前主题要写入根节点的动态 CSS token。
- `getDefaultThemeAccentColor(resolvedTheme)`：供颜色控件在未自定义时展示当前默认色。

生成规则：

1. 以用户颜色为基础。
2. 与当前主题主表面计算对比度；浅色主题必要时向黑色混合，深色主题必要时向白色混合，直到强调色与背景至少达到 3:1。
3. 从调整后的颜色派生 `accent-2`、`accent-3`、透明高亮、边线、卡片标题、拖放、菜单和 Git 工具相关 token。
4. 在黑/白文字中选择对比度更高的一种作为 `--accent-contrast`。
5. `theme !== 'custom'` 或 `accentColor === null` 时不生成 token，React effect 删除所有内联覆盖，让 CSS 原始主题值重新接管。

纯函数放在 shared 层，便于对持久化格式、极亮/极暗颜色和对比色进行 Node 单测，不把配色算法藏在 React effect 里。

## 前端接入

`src/App.tsx`：

- 主题解析 effect 传入 `customThemeBase`；accent token effect 以 `theme === 'custom'` 为闸门应用/清理动态覆盖。
- `renderThemeToggle()` 扩展为四选一主题按钮 + 仅自定义主题可见的 `.theme-custom-settings` 分区（底色切换 + 主题色编辑器），两个设置入口复用同一渲染函数。
- 颜色输入变化时写入 `accentColor`；恢复默认时写入 `null`；底色切换写入 `customThemeBase`；“恢复默认外观”一并重置 `theme`、`customThemeBase`、`accentColor`。

`shared/i18n.ts`：增加中英文“自定义”“底色”“主题色”“自动适配提示”“恢复默认”“默认颜色”等文案。

`src/index.css`：增加紧凑的颜色控件样式，使用现有 panel、line、ink、accent token；窄宽度允许换行。

## 测试策略

### 红 → 绿单测

- `tests/default-state.test.ts`：默认值、合法颜色规范化、短 hex 扩展、非法值清理；`custom` 主题与 `customThemeBase` 归一化。
- `tests/theme-runtime.test.ts`：浅/深主题的动态 token、极端颜色对比修正、默认色和空值行为；`resolveAppTheme('custom', …)` 按底色解析。
- `tests/state.test.ts`：`updateSettings` 切入/切出自定义主题并保留底色。

### UI / 视觉

- 扩展 `tests/theme-check.spec.ts`：内置主题下无配色控件；选中“自定义”后出现底色切换与颜色控件；选色后根 token 变化、底色切换保色相、持久化 `theme|customThemeBase|accentColor`、重载生效、恢复默认、切回内置主题移除覆盖；深/浅/窄视口各截一张自定义分区快照。
- 使用仓库 `pnpm test:theme`；若命中已知 Playwright discovery 问题，记录失败并用运行时 DOM/CSS 检查作为补充，不盲目更新快照。

### 交付验证

- 定向 Node 测试。
- `pnpm test:quality`。
- 自动 `pnpm electron:build` 生成 Windows zip。
- 按运行进程判断并用 `pnpm dev:restart` 重启当前开发 Electron 表面，不触碰已打包用户实例。
