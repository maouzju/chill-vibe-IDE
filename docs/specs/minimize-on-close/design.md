# 关闭后最小化到任务栏 — 设计

## 数据模型

在 `AppSettings` 中新增 `minimizeToTaskbarOnCloseEnabled: boolean`：

- schema 默认值：`false`；
- `createDefaultSettings()` 默认值：`false`；
- `normalizeAppSettings()` 对缺失或非法值回落为 `false`。

## 设置同步

该字段加入 renderer 的即时 runtime settings 同步白名单。renderer 首次加载状态、以及用户切换开关时，都会调用现有 `desktop:sync-runtime-settings`。

主进程在该 IPC 中先用 `appSettingsSchema` 校验完整设置，再更新内存中的关闭策略，并继续把同一份设置交给 desktop backend。关闭行为不依赖延迟写盘，因此用户切换后立即生效。

## 窗口关闭决策

把关闭决策提取为可单测的纯函数：

- 已进入刷盘退出流程：允许关闭；
- 未进入退出流程且开关开启：阻止关闭并调用 `win.minimize()`；
- macOS 且开关关闭：保留当前允许关闭窗口、应用继续驻留的语义；
- 其他平台且开关关闭：阻止第一次关闭，调用现有 `scheduleQuitAfterFlush()`，刷盘后再次关闭。

该顺序确保 `app.quit()`、更新安装等正式退出动作不会被“最小化”拦住。

## UI

设置项放在“实用”分组顶部，复用现有 `settings-toggle` 和 `settings-note`，不增加新颜色或布局样式。桌面与窄屏设置渲染路径都显示同一选项。

## 测试

1. 默认设置与旧状态迁移：默认关闭、显式开启保留、非法值回落关闭。
2. runtime settings 同步：更新该字段会立即触发同步。
3. 关闭决策：开启时最小化；退出中允许关闭；关闭时保留 Windows/macOS 既有路径。
4. Electron 主进程结构守卫：关闭监听实际调用决策并在最小化分支阻止销毁。
5. 质量检查与 Electron 构建。
