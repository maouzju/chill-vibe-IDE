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
- [ ] 单独处理古法 Git 复选框响应性能：`pnpm test:perf:electron` 的其余 3 个用例通过，
  但 120 文件复选框用例仍出现 7.7s / 2.2s / 4.0s 延迟；该问题发生在完整状态已加载后的
  前端交互阶段，不属于本切片消除的预览 Git 子进程放大路径。
