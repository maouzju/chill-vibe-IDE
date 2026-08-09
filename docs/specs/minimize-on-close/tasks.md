# 关闭后最小化到任务栏 — 任务

- [x] 阅读 `AGENTS.md`、`docs/design.md`、`docs/ui-principles.md` 与现有设置/窗口关闭实现。
- [x] 冻结需求与设计：默认关闭、即时生效、正式退出不拦截、最小化到任务栏。
- [x] 红测：设置默认/迁移、runtime settings 即时同步、关闭决策。
- [x] 实现 shared schema/default/normalization、设置 UI 与中英文文案。
- [x] 实现 Electron 主进程运行时同步和关闭转最小化。
- [x] 运行定向测试、`pnpm test:quality`、主题验证和 Electron 构建。
- [x] 检查当前运行面：仅发现用户正在使用的旧 packaged 实例；按安全规则未关闭或重启该实例，新构建已独立输出到时间戳目录。
