# 关闭按钮行为 — 任务

## 第一轮（2026-08-09，最小化到任务栏）

- [x] 阅读 `AGENTS.md`、`docs/design.md`、`docs/ui-principles.md` 与现有设置/窗口关闭实现。
- [x] 冻结需求与设计：默认关闭、即时生效、正式退出不拦截、最小化到任务栏。
- [x] 红测：设置默认/迁移、runtime settings 即时同步、关闭决策。
- [x] 实现 shared schema/default/normalization、设置 UI 与中英文文案。
- [x] 实现 Electron 主进程运行时同步和关闭转最小化。
- [x] 运行定向测试、`pnpm test:quality`、主题验证和 Electron 构建。
- [x] 检查当前运行面：仅发现用户正在使用的旧 packaged 实例；按安全规则未关闭或重启该实例，新构建已独立输出到时间戳目录。

## 第二轮（2026-08-17，扩展为三态 + 系统托盘）

用户反馈「根本没有实现，它只是把窗口缩小了而已」——第一轮的 minimize 与点「—」无异，
应用仍占任务栏格位，用户真正想要的是彻底藏起来。

- [x] 复核链路，确认 minimize 确实执行、缺的是隐藏路径而非 bug。
- [x] 红测：`resolveWindowCloseAction` 的 `tray → hide-to-tray` 分支与 macOS 不退化。
- [x] 红测：`closeBehavior` 默认值、非法值回落、旧布尔迁移、新字段优先级。
- [x] 红测：主进程结构守卫（hide + setSkipTaskbar + ensureTray + 托盘退出刷盘 + will-quit 销毁）。
- [x] 实现 schema 枚举 + `resolveCloseBehavior` 迁移，旧布尔降级为 deprecated optional。
- [x] 实现主进程托盘：按需创建、建不出来退回最小化、单击/菜单/second-instance 恢复、退出前销毁。
- [x] 设置 UI 由开关改为三选一下拉，补中英文案，同步 runtime 白名单与 action 类型。
- [x] `pnpm test:quality` 与定向 Node/Playwright 测试全绿。
- [x] 实机验证隐藏/恢复行为，并产出新的 Electron 打包。
