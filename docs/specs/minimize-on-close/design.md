# 关闭按钮行为 — 设计

## 数据模型

`AppSettings.closeBehavior: 'quit' | 'minimize' | 'tray'`（`shared/schema.ts` 的 `closeBehaviorSchema`）：

- schema 与 `createDefaultSettings()` 默认 `'quit'`；
- `normalizeAppSettings()` 通过 `resolveCloseBehavior()` 解析：新字段合法则取之，否则读旧布尔
  `minimizeToTaskbarOnCloseEnabled === true` 迁移为 `'minimize'`，再否则回落默认。

旧字段在 schema 中降级为 `.optional()` 并标注 `@deprecated`，仅保留读取能力。直接删除它会让
老存档里勾过「关闭不退出」的用户被静默改回「点 X 就退出」，连带杀掉正在跑的 Agent。

## 设置同步

`closeBehavior` 进入 renderer 的即时 runtime settings 同步白名单
（`src/hooks/persistence-queue.ts` 的 `runtimeSyncSettingsKeys`）。

主进程 `desktop:sync-runtime-settings` 先用 `appSettingsSchema` 校验，再更新内存中的
`closeBehavior` 与 `trayMenuLanguage`；切到非 `tray` 时顺带销毁已存在的托盘图标，
避免用户改了设置托盘图标还白占一格通知区。

## 窗口关闭决策

纯函数 `resolveWindowCloseAction()`（`electron/window-lifecycle.ts`），按优先级：

1. 已进入刷盘退出流程 → `allow-close`（保证 `app.quit()`、更新安装不被拦）；
2. `minimize` → `minimize`；
3. `tray` → `hide-to-tray`（macOS 同样返回该值：那里等价于隐藏窗口留 Dock 图标，
   绝不能退化成退出，否则勾了「不退出」的用户反而丢掉正在跑的 Agent）；
4. `quit` → macOS `allow-close`，其他平台 `quit-after-flush`。

## 托盘

`electron/main.ts` 内的 `ensureTray` / `destroyTray` / `restoreFromTray` / `resolveTrayIcon`：

- **图标**：`build/icon.png`（dev 用 `icon-dev.png`），`nativeImage` 读入后 resize 到 16×16 ——
  直接塞 256px 原图在部分 Windows 主题下会被裁成一角。
- **按需创建**：只在真正隐藏时建，恢复时销毁。常驻会白占通知区，还要跟设置切换同步。
- **建不出来就不藏**：`ensureTray` 返回 false 时退回 `win.minimize()`。隐藏 + `setSkipTaskbar(true)`
  之后托盘图标是唯一入口，没有它窗口就是一个用户再也叫不回来的后台进程。
- **顺序**：`ensureTray` → `hide()` → `setSkipTaskbar(true)`。
- **菜单**：显示 Chill Vibe / 退出。退出走 `scheduleQuitAfterFlush()` 而非 `app.exit()`，
  保证未保存状态照常刷盘。菜单语言跟随 `settings.language`。
- **恢复**：`restoreFromTray()` 先 `destroyTray()`，再 `setSkipTaskbar(false)` + 复用 `presentWindow()`。
  托盘单击、双击、菜单项、以及 `second-instance` 都走这一条路径 —— 藏进托盘后再点桌面快捷方式
  走的正是 `second-instance`，单纯 focus 一个不可见且不在任务栏的窗口是叫不回来的。
- **收尾**：`will-quit` 中 `destroyTray()`。托盘图标是 GDI 资源，不销毁会在通知区留下幽灵图标。

`window-all-closed` 不受影响：`hide()` 不销毁窗口，该事件不会触发。

## UI

设置项在「实用」分组顶部，由 `settings-toggle` 开关改为 `settings-hover-detail is-field` +
`settings-field` + `select`（复用 `codexPersonality` 的既有结构），说明仍走 hover note。
宽屏与窄屏两条渲染路径共用 `renderCloseBehaviorSettings()`。

## 测试

1. `tests/electron-window-lifecycle.test.ts`：三档决策 + 退出优先 + macOS 托盘不退化成退出。
2. `tests/default-state.test.ts`：默认值、非法值回落、旧布尔迁移、新字段不被旧布尔覆盖。
3. `tests/persistence-queue.test.ts`：改该字段触发 runtime 同步。
4. `tests/electron-runtime.test.ts`：主进程结构守卫 —— 同步赋值、minimize 分支、
   hide-to-tray 分支（hide + setSkipTaskbar + ensureTray + new Tray）、托盘退出走刷盘、
   `will-quit` 销毁托盘。
5. `tests/settings-hover-hints.spec.ts`：新 select 的 hover 说明契约。
6. 质量检查、实机托盘验证与 Electron 构建。
