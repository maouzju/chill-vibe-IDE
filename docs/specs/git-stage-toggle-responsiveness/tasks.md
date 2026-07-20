# 古法 Git 暂存切换响应任务

- [x] 记录现有 `pnpm test:perf:electron` 数秒级宿主墙钟失败证据。
- [x] 梳理 checkbox optimistic state、Electron bridge、Git stage 和状态回传链路。
- [x] 将 120 文件红测改为 renderer click-to-paint 计时，并验证连续选择最终收敛。
- [x] 为性能 Electron 启动配置独立 runtime profile。
- [x] 根据红测证据决定只修门禁：实测 5.2ms / 4.2ms / 4.1ms，无需修改生产调度或 Git 扫描。
- [x] 复跑定向 Node、`pnpm test:quality` 和完整 `pnpm test:perf:electron`（4/4 通过）。
- [x] 提交前完成 `pnpm electron:build`；提交后重启开发 Electron。
