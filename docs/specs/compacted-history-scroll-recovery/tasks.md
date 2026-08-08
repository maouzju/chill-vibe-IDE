# Compacted History Scroll Recovery Tasks

- [x] 为归档/当前消息合并增加先失败后通过的单元测试。
- [x] 增加定点 compact-history bridge 与 web route。
- [x] 在 ChatCard 中按需加载归档并接入临时 renderer 窗口。
- [x] 覆盖加载竞态、重复 ID 和滚动锚定回归。
- [x] 覆盖 boundary 被裁掉后的零重叠恢复，以及显式重置后的旧 sidecar 清理。
- [x] 运行定向 Node 测试、质量检查和双主题/窄视口手动视觉验证。
