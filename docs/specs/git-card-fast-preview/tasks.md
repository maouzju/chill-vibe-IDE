# Git 卡牌快显加载任务

- [x] 明确需求与设计。
- [x] 写失败测试：完整 Git 状态延迟时，preview 到达后按钮和改动数已出现。
- [x] 写/更新后端测试：preview 状态不包含 patch/增删行详情。
- [x] 扩展 shared 类型引用、api、Electron preload/main/backend、Express endpoint、测试 mock bridge。
- [x] 调整 GitToolCard 刷新流程：preview 先渲染，full 后补齐。
- [x] 确保分析按钮在 preview-only 状态下先补齐完整状态再启动 Agent。
- [x] 跑窄测试、质量检查，并重启当前开发运行时。
