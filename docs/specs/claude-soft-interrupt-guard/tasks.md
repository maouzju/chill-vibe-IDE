# 任务

- [x] 为轮次序号和 stale interrupt 添加先红后绿测试。
- [x] 为 ChatManager stop 幂等、自发轮次和渲染空继续添加先红后绿测试。
- [x] 透传 stop origin 并补充 desktop bridge 覆盖。
- [x] 加入 CLI 取证探针与 AGENTS 已知陷阱记录。
- [x] 运行 `pnpm test`，确认 3153/3153 通过。

## 明确未完成

- [ ] launcher 未 resolve 时与同卡并发 acquire 的 child.kill 边界：留作后续独立修复，不属于本次发布范围。