# 多窗口流式性能兜底 — 设计

## 总体策略

采用“先建立可失败的真实门禁，再逐层减负”的顺序：

1. **先测量，不改行为**：建立能够复现 v0.18.8 负载形态的隐藏 Electron 压力测试。
2. **先减少挂载量**：验证当前结构化工具组尾部窗口是否足以消除不可恢复卡死。
3. **仍不够才降低提交频率**：在不重新引入 React lane 分裂的前提下统一流式调度和背压。
4. **最后才考虑更深的渲染隔离**：只有 profile 仍指向布局/绘制时才扩大窗口化范围。

任何阶段达到验收目标后都停止，不为了“理论上更快”继续扩大改动面。

## 阶段 0：真实性能门禁

新增专门的聊天 Electron responsiveness 测试，而不是复用当前只覆盖 Git 工具的 `test:perf:electron`。

### 夹具

- 从真实事故形态生成 6 张 streaming 卡。
- 两张卡保留 300+ command item 的单用户长回合，其余卡保持 10～150 条活动。
- delta/activity 以可控时钟注入，模拟当前 80～180ms / 250ms 刷新来源。
- 保持 Electron 当前的软件渲染配置，使测试覆盖真正的高风险环境。
- 每次测试使用独立的 Electron `userData` / `sessionData` 根目录，避免和开发窗口或其他隐藏测试共享 Chromium profile，导致单实例、缓存或状态互相污染。

### 观测

- 主进程：`unresponsive`、`responsive`、`render-process-gone`。
- Renderer：心跳最大间隔、输入延迟、点击聚焦延迟、tab 切换延迟、长任务数。
- 负载：每次 commit 涉及的卡片数、缓冲 item 数、当前挂载的结构化 item 数。
- 进程：renderer/GPU CPU、工作集和测试前后内存增长。

测试必须先在 v0.18.8 基线上证明自己能够暴露旧问题或明显超过延迟门槛，避免写出“永远会绿”的假性能测试。

压力门禁还承担数据一致性证明：流事件可能在恢复或竞态路径中重放同一个消息 ID，因此 reducer 的 append 语义必须保持幂等。重复提交只能保留首次写入的消息；后续内容更新继续走现有 upsert 路径，不能靠重复 append 覆盖。

## 阶段 1：结构化工具组尾部窗口

当前工作树已有的 60 条尾部窗口是第一可逆切片：

- 只在 `StructuredToolGroupCard` 的展开内容层选择 `visibleItems`；
- 完整 `items`、消息 state、session 和持久化保持不变；
- 每次显示更早活动增加 60 条；
- collapsed 状态仍不挂载明细。

### 补强验证

- streaming append 后最新 item 可见，已显示的更早批次不会让挂载量失控。
- item 从 in-progress 更新为 completed 时 key 和卡片身份稳定。
- 切换 tab、折叠/展开、恢复状态后不会丢数据或改变 Provider 请求。
- 显示更早活动不会抢 composer 焦点，不会导致自动滚动跳到错误位置。
- 用阶段 0 的 Electron 夹具验证真实布局/软件绘制，而不只依赖 SSR 耗时。

如果本阶段已经满足全部压力门槛，则不实施阶段 2。

## 阶段 2：单 lane 的流式背压调度

只有阶段 1 仍出现明显 stall 时才进入。

### 不可破坏的前提

- reducer 提交继续使用 urgent 单 lane，不回退 `startTransition`。
- `deltaBufferRef` 继续按 `messageId` 保存交错 assistant item。
- completion/stop/error/recovery/close 的强制 flush 顺序不变。
- 缓冲只延迟 UI state commit，不丢弃事件、不修改事件内容。

### 候选实现

把 delta 和 activity 的两个独立 timer 收敛为一个可测试的流式渲染调度器：

- 单流且用户空闲时保留接近实时的刷新观感；
- 多流时提高批处理窗口，避免一个 commit 同时重绘多个巨型卡片后立刻进入下一 commit；
- 键盘、pointer、滚动交互后的短保护窗内优先保证交互，流式事件继续进入缓冲；
- 非活跃 pane 可以比活跃 pane 更低频刷新，切换为活跃时立即无损 flush 该卡；
- 每个定时值必须由压力测试结果决定，先通过 feature flag 做 A/B，不直接替换生产默认值。

调度器应做成纯状态机/driver，注入时钟并覆盖：排队、合并、强制 flush、取消、卡片优先级变化和应用关闭。

## 阶段 3：测量驱动的渲染隔离

仅当 profile 证明剩余成本仍来自 DOM layout/paint 时考虑：

- 对其他超大结构化明细应用同类有界窗口；
- 将昂贵预览延迟到用户展开时再挂载；
- 评估 `content-visibility` 等浏览器级隔离，但必须验证滚动尺寸、搜索、焦点和可访问性。

整条 transcript 虚拟化是最后手段。可变高度消息、自动滚动、Ask User、portal、折叠组和历史显示都会提高回归风险，未有证据前不实施。

## Windows 合成策略（2026-07-18 实证更新）

历史版本从启动起无条件调用 `app.disableHardwareAcceleration()`。真实四流现场中，
SwiftShader GPU 进程持续占满约一个 CPU 核，随后 `BrowserWindow unresponsive`；同时
JS 心跳仍健康、调用栈采集连续为空，说明瓶颈在合成/光栅路径而非 JS 热循环。

- Windows 恢复 Electron 默认硬件加速，把合成和光栅工作交回 GPU；
- Linux/macOS 暂时维持旧默认，等待各自 soak 证据；
- `CHILL_VIBE_DISABLE_HARDWARE_ACCELERATION=1` 可回退软件渲染；
- `CHILL_VIBE_ENABLE_HARDWARE_ACCELERATION=1` 可用于非 Windows 实验。

压力门禁使用隐藏离屏窗口并消费 paint 帧，避免原先“隐藏窗口不产生真实绘制”的假绿。
离屏位图回读限制为 15fps，避免测试自身用 60fps CPU 拷贝制造非生产瓶颈。

## 阶段 2 落地：单 lane、按列切片的统一流式调度

delta 与 activity 不再各自启动定时器。统一调度器一次只提交一个 column 的动作批次，
列之间让出 50ms；多流时刷新间隔自适应为 80/200/500ms。这样既不恢复
`startTransition`，也避免六列同时换引用后在同一帧触发整板布局/绘制。

## 验证矩阵

### 逻辑测试（严格 red → green）

- 工具组窗口边界、批次显示、源数组不变。
- 调度器的顺序、合并、强制 flush、取消和交错 item。
- stop/done/error/recovery/close 前所有缓冲落入 state。
- UI 窗口不影响请求 seeding、archive recall 和持久化内容。

### 组件与浏览器交互

- 300 条流式 command 只挂载有界尾部。
- 输入、中文文本插入、焦点、tab 切换、滚动锚定、折叠/显示更早活动。
- Ask User、排队发送、手动停止、模型选择和附件行为不变。
- light/dark、桌面和窄视口快照经过人工审查。

### Electron 压力与 soak

- 5 分钟确定性自动压力测试作为日常门禁。
- 30 分钟隐藏窗口 soak 作为打包前门禁。
- 记录并比较基线、当前尾部窗口、可选调度器三个版本的 p50/p95/max 和资源曲线。

## 发布和回滚

- 一个发布候选包只包含一个性能行为切片。
- 使用新的时间戳目录，与用户正在运行的包并存；不得自动关闭用户实例。
- 包内保留性能策略开关和诊断计数，出现回归可立即关闭当前切片。
- 任一数据不一致、焦点丢失、tab panel 异常卸载、恢复失败或 unresponsive 都是停止发布条件。
