# Tasks — Full Review Critical Remediation

- [x] A1 添加 600 条首次归档仍保留完整 sidecar 的红测。
- [x] A2 添加 legacy 无 messageCount 状态无损迁移红测。
- [x] A3 sidecar 改为原子写并添加故障注入测试。
- [x] B1 添加 queued old + immediate new 最终 new 胜出的红测。
- [x] B2 添加显式 reset 确实覆盖磁盘的红测。
- [x] B3 实现单调 generation 与 reset override。
- [x] C1 添加 stop-before-child-assignment 红测并修复 ChatManager。
- [x] D1 扩展 Claude signature 身份覆盖测试与实现。
- [x] D2 添加旧 entry 延迟 close 不影响新 turn 的红测并修复 pool。
- [x] D3 添加同卡并发 acquire 红测并用单调 generation 防止旧 child 覆盖或泄漏。
- [x] E1 添加 Windows junction/symlink workspace escape 红测并修复 canonical 边界。
- [x] F1 添加更新前等待主进程保存测试并接线。
- [x] 同步 history-sidecar-storage 与 claude-session-keepalive 文档。
- [x] 跑窄测、quality、unit、risk、build、打包、合并和清理 worktree；发布审计再次复核定向测试、Electron、生产构建与 5 分钟六流性能门禁，基线同现的 Windows 计时/快照噪声已单独记录。
