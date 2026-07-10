# 自定义主题任务

- [x] 阅读 `AGENTS.md` 与 `docs/ui-principles.md`，明确主题安全和持久化要求。
- [x] 完成 requirements / design / tasks SPEC。
- [x] 先增加主题色归一化与配色生成的失败单测并确认红灯。
- [x] 更新 schema、默认设置和旧状态归一化；非字符串脏值由 schema 回退为 `null`。
- [x] 实现共享配色生成函数与根 CSS token 应用/清理。
- [x] 在两个设置入口增加颜色选择、当前值和恢复默认操作。
- [x] 增加中英文文案与双主题/窄视口安全样式。
- [x] 增加并人工检查设置页视觉覆盖：默认浅/深、橙色自定义浅/深、520px 窄视口。
- [x] 定向 Node 测试 87/87、设置相关 Playwright 9/9、`pnpm test:quality` 通过。全量 `pnpm test:theme` 为 129/137；剩余 8 项是附件、Auto Urge、结构化编辑和 Git 旧快照/旧断言，与本功能无关。
- [x] `pnpm electron:build` 成功：`dist/release-20260710-114044/Chill Vibe-0.17.17-win.zip`，并保留 `win-unpacked/Chill Vibe.exe`。
- [x] 已用 `pnpm dev:restart` 重启开发 Electron；renderer 指向当前仓库、5173 返回 HTTP 200，未触碰正在运行的打包版。

## 二期：改为“自定义”主题（按用户反馈）

- [x] 需求变更：主题四选一（浅色/深色/系统/自定义），仅自定义主题可设置底色与主题色；内置主题不再显示配色控件。
- [x] 红灯单测：`resolveAppTheme('custom', …)` 按底色解析、`customThemeBase` 归一化、reducer 切换保留底色；先确认失败再实现。
- [x] schema/归一化：`themeSchema` 加 `custom`，新增 `customThemeBase`（catch/default `dark`）；`normalizeAppSettings`、`createDefaultSettings`、`appStateSchema` 同步。
- [x] 前端：主题解析与崩溃页透传底色；accent token 以 `theme === 'custom'` 为闸门；`renderThemeToggle` 增加自定义分区（底色切换 + 配色控件）；“恢复默认外观”重置三字段；中英文“自定义/底色”文案；`.theme-custom-settings` 样式。
- [x] Playwright：重写为“内置主题无配色控件 → 自定义解锁 → 选色 → 底色切换保色相 → 持久化/重载 → 恢复默认 → 切回内置主题移除覆盖”；深/浅/窄视口快照刷新并人工核对。
- [x] 定向 Node 测试 92/92；设置相关 Playwright 9/9；`pnpm test:quality` 通过。theme-check 其余 9 项失败为附件、Auto Urge、单栏标题、Git 旧快照与 `.settings-field-icon` 计数旧断言，均与本功能无关（该计数断言与图标行均源自 v0.1.0 初始提交，本次未触碰任何模型行）。

## 三期：底色取色器（按用户反馈）

- [x] 红灯单测：`getSurfaceBaseAppearance` 明暗判定、`createThemeSurfaceTokens` 表面派生、`customBaseColor` 归一化。
- [x] schema/归一化：`AppSettings.customBaseColor`（可空 `#rrggbb`，脏值 catch 为 `null`）。
- [x] shared/theme.ts：surface token 派生 + `getDefaultThemeSurfaceColor`；App.tsx surface effect（`theme === 'custom'` 闸门）；底色行取色器 UI（预设 chip 清色、取色自动定明暗）；取色器圆点 `--ink-4` 中性边框防隐身。
- [x] Playwright：用例追加底色取色流程（任意深色底 → 自动 dark ink；浅色底 → 自动翻转 light；预设 chip 清除覆盖）；快照因近色容差吞差异，删除后强制重生成并人工核对（坑记入 AGENTS.md #149）。
- [x] 定向 Node 测试 95/95、目标 Playwright 用例通过、`pnpm test:quality` 通过。
