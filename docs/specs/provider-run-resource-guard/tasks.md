# Provider Run Resource Forensics — Tasks

- [x] 接受用户校正：VSCode Codex 可稳定并行十几个会话，并发数量不能作为限制理由。
- [x] 更新 requirements/design，明确恢复无限制即时启动并保留客观心跳。
- [x] 红测：同步创建 12 条流时 12 条 provider launcher 都立即启动。
- [x] 红测：启动失败只终止自己的流，不阻塞其他并行流。
- [x] 删除 ChatManager 并发槽位、FIFO 队列、环境变量和排队文案。
- [x] 更新多窗性能文档和 AGENTS 已知坑，撤回错误根因表述。
- [x] 运行针对性测试与 `pnpm test:quality`。
- [ ] 自动构建并校验 Windows zip；不关闭用户当前打包版工作窗口。
