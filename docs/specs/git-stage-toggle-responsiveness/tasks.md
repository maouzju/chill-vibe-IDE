# 古法 Git 暂存切换响应任务

- [x] 记录现有 `pnpm test:perf:electron` 数秒级宿主墙钟失败证据。
- [x] 梳理 checkbox optimistic state、Electron bridge、Git stage 和状态回传链路。
- [x] 将 120 文件红测改为 renderer click-to-paint 计时，并验证连续选择最终收敛。
- [x] 为性能 Electron 启动配置独立 runtime profile。
- [x] 根据红测证据决定只修门禁：实测 5.2ms / 4.2ms / 4.1ms，无需修改生产调度或 Git 扫描。
- [x] 复跑定向 Node、`pnpm test:quality` 和完整 `pnpm test:perf:electron`（4/4 通过）。
- [x] 提交前完成 `pnpm electron:build`；提交后重启开发 Electron。

## 后台暂存收敛补强

- [x] 红测：普通单文件暂存启动的 Git 进程不得超过 4 个，并保留完整仓库详情（改前实测 7 个）。
- [x] 抽出已知 repoRoot 的状态读取路径，移除暂存前的完整扫描和暂存后的重复 `rev-parse`。
- [x] 复跑暂存/取消暂存/初始仓库回退测试、`pnpm test:quality` 和 Electron Git 性能门禁（4/4）。
- [x] 提交前完成 Windows zip 打包；提交后重启开发 Electron。
