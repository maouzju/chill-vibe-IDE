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

当前工作树已有的 20 条尾部窗口是第一可逆切片：

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

### 2026-07-23 重度多 Tab 补强

用户核心场景不是单张超长卡，而是多个 Agent workspace 同时使用、单个 pane 的 tab 条常驻十几个 tab，
其中多条 Agent 在后台继续流式运行。性能夹具因此提升为 6 个 workspace column、每 pane 14 tab、
每 pane 首尾两条流并发（总计 84 tab / 12 stream）。前 3 列保留可见前台流，后 3 列停在普通 History tab，
从而让 6 条流长期处于后台并验证它们不会因正文 delta 反复重绘 pane；重新激活后台流时还要验证隐藏期新输出已经出现。

此形态暴露出 `PaneView` memo 的额外放大：普通后台 tab 只有消息正文变化时，完整 card 引用仍会变化，
旧比较器会无条件重绘整个 pane。新的比较策略只让后台 tab 的 chrome 可见字段参与比较；激活 tab 与 Git 保活 tab
仍比较完整 card。切换激活 tab 会读取 column 中最新 card，因此这项隔离不缓存或截断后台消息。

### 2026-07-23 20 个运行 Agent 校正

12 流门禁只证明了“多个后台流存在”，没有完全覆盖用户的真实重度形态。后续基线改为 84 tab / 20 stream：
6 个 pane 按 `4/4/3/3/3/3` 分布运行 tab，每列保持一个正在回答的 Agent 激活，另外 14 条流在后台。
交互循环必须在全部 20 条流仍为 streaming 时，对前台 Agent 做中文输入和焦点测量、右键发送按钮走真实延后发送，
并切换到同列另一条运行流验证隐藏输出，再切回。Provider 仍由本地 fake Codex app-server 产生确定性事件，
因此覆盖真实应用路径但不联网、不调用模型、不产生 Token 费用。

### 2026-07-23 新建会话首次输入偶现门禁

在 20 条流稳定运行后，测试继续轮转 6 个 pane，重复 60 次真实鼠标点击新增 tab、等待新 composer 自动聚焦、立即插入中文草稿、切回运行 tab、再切回新 tab核对草稿。
夹具同时用合成历史把序列化状态从约 0.46MB 提升到至少 4MB，覆盖当前打包版约 3MB 状态下的克隆与保存压力，不读取真实内容。
核对后清空并关闭探针 tab，使每次都从相同 84-tab 基线开始。门禁同时记录 ready/input p95、max 和焦点失败，
并以 ready/input max `< 500ms` 捕获偶发长尾。该门禁先用于取证；若当前实现未红，不凭猜测修改生产路径。

旧实现的 5 分钟红测抓到真实长尾：新建 ready p95 / max 为 707.5 / 802.3ms，heartbeat / frame 最大间隔为 656.9 / 900.0ms。
此时 20 条流没有丢失、崩溃或焦点失败，瓶颈来自持续增长的末尾助手正文：每次 delta 都让 `ReactMarkdown` 重新解析整段长文本，
交互恰好撞上该提交时，新 tab 的 reducer 与 composer mount 只能排在昂贵解析之后。最小修复只作用于“正在流式、无结构化类型、且正文至少 16,000 字符”的末尾助手消息：
流期间用单个保留换行的纯文本节点显示完整原文，完成/停止后立即恢复完整 Markdown。消息对象、Provider 上下文、持久化与最终展示都不截断。

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
列之间让出 50ms；首版多流刷新间隔为 80/200/500ms，2026-07-21 E 类复发后最终默认值收紧为
单流/2～3 流/4+ 流 80/400/800ms。这样既不恢复
`startTransition`，也避免六列同时换引用后在同一帧触发整板布局/绘制。

## 交互优先补强（2026-07-19）

真实 5 流现场仍出现输入和 tab 切换发黏：renderer 与 GPU 在持续流期间分别长期占用
约 0.6 / 0.7 个 CPU 核。原调度器虽然降低了总提交频率，但定时提交仍可能正好撞上
`pointerdown`、键盘输入或 IME 提交后的关键绘制帧。

- renderer 在捕获阶段记录键盘、输入法、pointer、click 和 wheel 交互时间；
- 普通流式刷新若落在交互后的短保护窗内，继续缓冲并稍后重试；
- 保护只延迟普通 UI commit，完成、停止、报错、恢复和退出前的强制 flush 不变；
- 连续输入不能无限饿死流式输出，因此每次到期刷新只允许有限的最大额外延迟；
- 该策略继续使用 urgent 单 lane，不修改消息、Provider 上下文或持久化内容。

## 结构不变时停止重建 transcript 观测器（2026-07-19 晚间复发）

`release-20260719-183247` 在 5 个真实会话持续 streaming 约 28 分钟后仍记录了一次
`BrowserWindow became unresponsive`，调用栈采集为空，内存保持在正常区间。现场 state
仅约 265 条消息，但 renderer / GPU 在后续同类负载下仍持续占用约 0.5 / 0.35 个 CPU 核。

代码走查发现 `ChatTranscript` 把完整 `renderableMessages` 引用作为布局观测 effect 的依赖。
因此同一条 assistant/command 只更新内容、DOM 条目身份完全不变时，仍会在每次流式提交后：

- 断开并重新注册全部 transcript 条目的 `ResizeObserver`；
- 重新启动 18 帧 scrollTop 观察循环；
- 重建 sticky prompt 的布局扫描回调。

本切片只把这些 effect 的失效条件收窄到“渲染条目结构发生变化”（条目 ID/顺序变化）。
内容更新继续由现有长期存活的 `ResizeObserver` 触发 sticky 同步，消息内容、自动滚动、焦点、
持久化和 Provider 语义均不改变。

## 2026-07-21 E 类复发：清除无限光栅动画并扩大多流背压

`release-20260720-165915` 在多卡流式约 11 分钟后再次进入
`BrowserWindow unresponsive`。调用栈依旧为空，系统仍有约 8 GiB 可用内存；现场新包的
renderer / GPU 在四流状态下各持续消耗约 43% 单核，锚点继续指向持续渲染/合成负载。

- 移除流式卡片和非活跃流式 tab 的无限 `box-shadow` 呼吸动画，改为静态边框状态；
- 单流仍保持 80ms 刷新；2～3 流由 200ms 放宽到 400ms，4 流以上由 500ms 放宽到
  800ms；完成、停止、错误、恢复和退出前的强制 flush 不变；
- 不降低 Provider 并发，不丢弃 delta，只减少 UI commit 与持续光栅次数。

## 2026-07-21 发送后短时卡顿：复用已压缩的持久化消息

发送后进入 streaming 时会启动延迟保存。旧实现每次保存都重新遍历并解析所有历史
`structuredData`，即使这些工具输出从上一次保存后完全没有变化。长会话里，同一批巨型命令、
补丁和工具结果会在每次发送后重复压缩，形成明显的主线程尖峰。

- 以不可变 `ChatMessage` 对象为键缓存已经压缩过的持久化消息；
- 后续发送若历史消息对象和原始 `structuredData` 均未变化，直接复用压缩结果；
- 当前流中新建或更新的消息仍正常重新压缩，短消息继续完整保存；
- 缓存只影响发往持久化 IPC 的快照，不改变 React 状态、Provider 上下文或磁盘恢复语义。

## 2026-07-25 E 类持续卡死的 renderer 自动恢复

本次现场在运行约 8 小时后再次记录 `BrowserWindow became unresponsive`，JS 调用栈仍为空，系统内存充足，随后用户只能关闭窗口。此前 Windows dump 已把同族故障锚定到 renderer/GPU/DXGI 等待链路，但当前证据仍不足以盲改具体绘制代码。因此增加一个独立、可回滚的恢复层，而不宣称底层根因已经修复。

- `electron/unresponsive-recovery.ts` 提供纯控制器：首次 `unresponsive` 武装一次定时器，`responsive` 或销毁会取消；定时到期且仍无响应才调用恢复回调。
- 默认在 Electron `unresponsive` 事件后等待 8 秒，再强制终止卡死 renderer，并在 `render-process-gone` 后重新加载。Electron 自身通常已等待数秒才发事件，因此总冻结时间仍能避开普通短帧，同时比人工关应用更早自救。
- `CHILL_VIBE_UNRESPONSIVE_RECOVERY_MS=0` 完全关闭；正整数可调整宽限期。
- renderer reload 不重启主进程、本地 Express、ChatManager 或 Provider CLI。页面恢复后，保存状态中的 `streamId` 会重新订阅 ChatManager；backlog 重放与既有消息 ID 幂等规则负责补齐冻结期间事件。
- 恢复前记录 renderer PID、无响应起点和最后输入；若底层故障继续复发，日志仍保留客观证据。

回滚点集中在控制器接线和单个环境变量，不改变 reducer、流式调度、硬件加速或 Provider 并发。

### 2026-07-26 现场修正：普通 reload 不会替换卡死进程

新包现场连续四次触发 8 秒恢复，但四次日志中的 renderer PID 始终是 `45156`，且没有任何 `Renderer finished load`。这证明 `reloadIgnoringCache()` 只是把导航请求排进已经无法处理消息的 renderer，自动恢复本身是假恢复。

修正后的恢复顺序：

1. 持续无响应到期后记录旧 renderer PID，并标记本窗口进入强制恢复。
2. 调用 `webContents.forcefullyCrashRenderer()`，只终止 renderer；Electron main、本地后端、ChatManager backlog 和 Provider CLI 保持运行。
3. 只在 `render-process-gone` 确认旧 renderer 已退出后调用 `reloadIgnoringCache()`。
4. `did-finish-load` 记录新 renderer PID；运行时测试必须证明 PID 确实变化且新的 UI root/desktop bridge 已恢复。

这仍是恢复层，不把空 JS 栈的 GPU/native 底层等待误报为已根治；但它把“只能人工关闭整个 IDE”修正为真正的 renderer 进程级自愈。

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

## 2026-07-23 长时运行状态动画复发

现场包 `release-20260723-223152` 在 4 条 Codex 流持续运行约 32 分钟后两次触发 `BrowserWindow became unresponsive`。
`collectJavaScriptCallStack()` 均返回 `available=false, frameCount=0`，事件前后系统仍有 12GB 以上可用内存，Electron 工作集约 656MB，
因此证据继续指向 Chromium 绘制/合成链路，而不是可采样的 JS 热循环或系统 OOM。

上一轮已移除整卡和 pane tab 的无限 `box-shadow` 动画，但所有挂载中的流式卡片、命令块和 busy 状态仍保留小型
transform/opacity 无限点动画。inactive pane panel 为保留状态持续挂载，使这些看似很小的动画会随多流、多 tab 数量叠加，并在长时间运行中持续消耗合成预算。

本切片最初把 `.streaming-dots span`、`.structured-command-running-dots span` 和 `.is-busy::before` 全部改为静态透明度层级，
但现场反馈指出前台运行反馈因此过弱。最终策略改为：当前可见的 active pane 保留三点跳动，隐藏 pane 和通用 busy 点保持静态；
不改变 Provider 并发、消息刷新、状态语义或持久化。测试同时约束后台无无限动画、前台必须有动效；最终以真实 Electron 多流门禁和新 Windows 包验证。
