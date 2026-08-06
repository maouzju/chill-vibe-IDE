# Agent 循环重复 — 任务

- [x] 阅读 `AGENTS.md`、`docs/ui-principles.md`、原生完成边界、Tab 与计划唤醒相关 SPEC。
- [x] 冻结需求与设计：默认关闭、最终完成触发、同 Pane 新 Tab、文本首条提示、自动鞭策互斥。
- [x] 先写并运行失败测试：默认/归一化、循环判定、Reducer 新建 Tab。
- [x] 实现共享 schema、默认值、恢复归一化与 reducer action。
- [x] 接入 stream terminal 完成调度并复用现有 `sendMessage()`。
- [x] 增加设置总开关、输入框设置菜单勾选项、正文状态提示、中英文文案和主题样式。
- [x] 补齐 UI / 主题覆盖并审查 light、dark、桌面、窄屏。
- [x] 运行定向测试与 `pnpm test:quality`。
- [x] 执行 `pnpm test:theme`；标准 headless shell 缓存损坏而无法完成，已用系统 Edge 跑同一 Playwright 定向用例并生成/复核六张 light、dark、桌面、窄屏与设置菜单快照。
- [x] 执行 `pnpm electron:build`，确认 zip 与 `win-unpacked` 产物路径。
- [x] 检查当前运行面：仅发现用户正在使用的旧 packaged 实例；按安全规则不关闭/重启该实例，也未伪装成已重启开发面。
- [x] 将聊天内循环开关收进输入框右侧设置菜单，并用独立状态提示明确显示当前已开启。
