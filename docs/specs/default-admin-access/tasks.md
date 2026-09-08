# 任务

- [x] 添加并运行红灯测试：默认/旧状态、开启和关闭、新建/已有、显式 false、工具卡（3 条均先红后绿）。
- [x] 实现设置持久化、新建播种、MCP 禁止扩散与中英文设置 UI。
- [x] 定向测试、质量检查、深浅主题截图审查与运行时检查。

## 验证记录（2026-09-08）

- default-admin-access、automation-board-state、state、automation-board-mcp：202 条通过；随后含 automation-board-render 的定向复测 41 条通过。
- pnpm test:quality 通过。
- pnpm test:theme 因 5173 被其他项目 Roadbound 占用而在启动前退出；未复用或停止该服务。临时隔离配置使用 5187，仅运行 theme-check 的 default admin setting：深浅主题 2 条通过，四张开关截图已逐张审查；覆盖悬停说明、焦点、窄屏和刷新后设置保留。全主题套件未完成，不宣称全量通过。
- pnpm electron:build 成功：dist/release-20260908-190102/Chill Vibe-0.20.18-win.zip，顶层 Chill Vibe IDE；可直接运行 win-unpacked/Chill Vibe.exe。
- 当前活跃面为 release-20260908-181439 打包版，按运行时保护规则未关闭或重启；交付新包供用户自行切换。沿用当前会话工作区，未提交或改动其他任务的差异。
