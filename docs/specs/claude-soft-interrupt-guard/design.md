# Claude 常驻会话软中断保护设计

## 轮次绑定

`ClaudeSessionPool` 为每次 `beginTurn` 或自发轮次挂载递增 `turnSerial`。provider 在创建 stream 时保存该序号，调用 `interruptTurn` 时必须同时匹配卡片、子进程和轮次；序号缺失或不匹配 fail-closed。

## 停止语义

`ChatManager.stop` 只在第一次设置 `stopRequested` 并选择软中断或硬杀。常驻会话中，已结束或已被下一轮顶替的自发轮次返回“已处理”但不触碰进程；当前轮控制通道不可写时才释放并硬杀。收尾输出继续交给原 parser，避免等待不到 result。

## 渲染竞态

`shouldDropEmptyContinuationWhileStreaming` 只过滤普通用户发起、无内容、非 ask-user 答复的空发送。显式模式和自动化来源不经过该守卫。

## 诊断

通过 stop bridge 透传 origin，在 `[chat-stop]` 记录 origin、stream 年龄、kind、repeat、softInterrupted、diffInFlight；过期轮次和被阻断的 stale interrupt 各自记录一条可搜索日志。

## 已知限制

launcher 尚未 resolve 时的 child.kill 与同卡并发 acquire 仍需后续独立切片验证，本次不宣称已消除该边界。