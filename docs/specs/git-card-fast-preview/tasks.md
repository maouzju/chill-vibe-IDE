# Git 卡牌快显加载任务

- [x] 明确需求与设计。
- [x] 写失败测试：完整 Git 状态延迟时，preview 到达后按钮和改动数已出现。
- [x] 写/更新后端测试：preview 状态不包含 patch/增删行详情。
- [x] 扩展 shared 类型引用、api、Electron preload/main/backend、Express endpoint、测试 mock bridge。
- [x] 调整 GitToolCard 刷新流程：preview 先渲染，full 后补齐。
- [x] 确保分析按钮在 preview-only 状态下先补齐完整状态再启动 Agent。
- [x] 跑窄测试、质量检查，并重启当前开发运行时。

## 2026-07-20 完整预览进程放大补强

- [x] 红测：6 个已跟踪文件的完整预览不得启动超过 6 个 Git 进程。
- [x] 批量读取 HEAD 文件大小并批量生成已跟踪文件 patch。
- [x] 保留 untracked、rename、delete、预算省略和异常回退语义。
- [x] 复跑 Git workspace 窄测、`pnpm test:quality` 和 `pnpm electron:build`。
- [x] 复核古法 Git 复选框响应性能：专项门禁改用 renderer click-to-paint 后测得
  5.2ms / 4.2ms / 4.1ms，确认旧的秒级数字来自 Playwright 宿主墙钟；详见
  `docs/specs/git-stage-toggle-responsiveness/`。
