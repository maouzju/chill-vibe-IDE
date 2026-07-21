# 多窗口流式性能兜底 — 验证记录

## 2026-07-21 E 类复发与持续光栅降档

- `release-20260720-165915` 于 13:28:15 记录 `BrowserWindow became unresponsive`；
  `collectJavaScriptCallStack` 返回空栈，事件前系统仍有约 8 GiB 空闲。
- 复发后的同类四流现场 10 秒采样显示 renderer / GPU 分别持续约 43.4% / 42.8%
  单核，说明即使没有可采集 JS 热栈，持续 commit 与光栅预算仍偏高。
- 修复切片：删除流式卡片/流式 tab 的无限 box-shadow 动画；2～3 流刷新间隔
  200→400ms，4 流以上 500→800ms。消息与强制 flush 语义不变。
- 红测先确认旧实现仍有两处无限光栅动画且多流间隔仍为 200/500ms；修复后 focused
  Node 测试 26/26、`pnpm test:quality` 均通过。
- light/dark 的 pane streaming 主题用例均通过；完整 `pnpm test:theme` 的相关用例通过，
  但套件仍有 6 个与本切片无关的既有快照差异，未盲目更新快照。
- 修复后的 5 分钟 6-stream 离屏门禁通过：frame max 304.7ms、input/focus/tab p95
  74.8/76.3/132.4ms，零 unresponsive、零 renderer gone，持久化顺序完整。
- 门禁运行中的 10 秒进程采样：6-stream renderer 约 5.9% 单核、GPU 约 15.3%；同时仍
  运行旧包的四流真实窗口约 40.3%/49.2%，支持本切片确实移除了持续合成放大器。
- Windows zip 构建完成：`dist/release-20260721-141037/Chill Vibe-0.18.16-win.zip`，
  解压根目录只有 `Chill Vibe IDE`，SHA-256
  `6BA4B6F2CFBE8387871D8C6CB19F2724DE2C9739E680E998F74A8E6069BD9719`；可直接运行
  `dist/release-20260721-141037/win-unpacked/Chill Vibe.exe`。

## 2026-07-19 晚间 E 类复发与 transcript 观测器降频

- `release-20260719-183247` 在 5 张真实卡持续 streaming 约 28 分钟后于 22:21:05
  记录 `BrowserWindow became unresponsive`；调用栈采集 `available=false/frameCount=0`，
  事件前 Electron 总私有内存约 660 MiB，排除 OOM 和明确 JS 热循环栈。
- 现场 state 约 1.1 MiB、5 列、12 卡、265 条消息、5 卡 streaming；后续同类负载下
  renderer / GPU 分别持续约 52% / 36% 单核，说明仍有可去除的持续 UI 工作。
- 红测确认同一批 renderable 条目仅更新流式内容时结构签名保持不变；新增条目时签名变化。
- `ChatTranscript` 的 sticky、scroll watch、`ResizeObserver` 生命周期改为只受条目 ID/顺序驱动，
  不再随每个 delta 断开并重挂全部 DOM 观测器。
- focused Node 测试 46/46 通过，`pnpm test:quality` 通过。
- 30 秒 6-stream 离屏真实绘制门禁通过：`frameMaxGapMs=169.9ms`、
  `inputP95Ms=75.1ms`、`focusP95Ms=74.2ms`、`tabSwitchP95Ms=112.6ms`，
  零 unresponsive、零 renderer gone，持久化完整性通过。

## 2026-07-19 输入与 Tab 交互优先补强

- 当前用户包 `v0.18.12` 运行约 12 小时、5 张卡 streaming 时，10 秒现场采样显示
  renderer / GPU 分别持续占用约 60% / 74% 单核；状态约 1.83 MiB、15 张卡、855 条消息。
- 旧门禁的输入指标只统计同步 textarea 赋值，没有等待下一帧，无法代表用户何时真正看到文字；
  本次改为输入、聚焦和两次 tab 切换都等待实际下一帧后再计时。
- 新增普通流式 commit 的交互保护：输入、IME、pointer、click、wheel 后 120ms 内延后刷新，
  单次到期刷新最多额外延迟 300ms；完成、停止、报错、恢复、退出前的强制 flush 不变。
- 合并后的 30 秒 6-stream 离屏真实绘制门禁：`frameMaxGapMs=234.9ms`、
  `inputP95Ms=75.1ms`、`focusP95Ms=60.3ms`、`tabSwitchP95Ms=100.7ms`，
  零 unresponsive、零 renderer gone，持久化顺序与消息完整性通过。
- focused Node 测试 22/22 通过，`pnpm test:quality` 通过。

## 2026-07-18 真实复发与门禁修正

- 最新发布包 `release-20260718-002246` 在四个长任务并行约 31 分钟后两次记录
  `BrowserWindow became unresponsive`，无 OOM、无 renderer gone，JS 调用栈均为空。
- 重启后的同类负载下，SwiftShader GPU 进程实测约 103% 单核 CPU，renderer 约 22%；
  说明旧默认的软件合成已经吃满光栅预算。
- 旧性能门禁的窗口完全隐藏，因此没有覆盖可见绘制，30 分钟 soak 的“零 unresponsive”
  不能证明真实合成路径安全。
- 门禁开启离屏绘制后，旧软件路径 30 秒即出现 `frameMaxGapMs=4366ms`、
  `tabSwitchP95Ms=1221ms`（红）。
- Windows 默认硬件加速 + 统一按列切片调度后的最终默认配置：
  `frameMaxGapMs=232ms`、`inputP95Ms=12ms`、`focusP95Ms=139ms`、
  `tabSwitchP95Ms=69ms`，零 unresponsive（绿）。

## 基线区分度

同一套隐藏 Electron 夹具分别在 `v0.18.8` 和当前尾部窗口切片运行。基线多次越过交互或挂载上限，例如：

| 版本 | 时长 | 心跳最大间隔 | 输入 p95 | 聚焦 p95 | Tab p95 | 单组最大挂载 | 结果 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `v0.18.8` | 约 20 秒 | 154.6ms | 5ms | 719ms | 43ms | 138 | 失败 |
| `v0.18.8` | 约 19 秒 | 166.6ms | 4ms | 298ms | 45ms | 60 | 失败 |
| 当前尾部窗口 | 约 72 秒 | 178.9ms | 7ms | 15ms | 53ms | 60 | 通过 |

这证明门禁不是无条件通过，并能同时识别交互延迟与无界活动挂载。

## 当前切片

- 5 分钟门禁第一次运行在响应性指标全部达标后，仍因 `card-chat-stress-3` 出现重复消息 ID 而失败。
- reducer 的 `appendMessages` 改为按消息 ID 幂等追加，并补充 red → green 单元测试。
- 修复后连续两次 5 分钟门禁通过：

| 运行 | 心跳最大间隔 | 输入 p95 | 聚焦 p95 | Tab p95 | 单组最大挂载 | unresponsive / renderer gone |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 分钟 A | 189.7ms | 18ms | 39ms | 104ms | 120 | 0 / 0 |
| 5 分钟 B | 235.2ms | 88ms | 91ms | 231ms | 60 | 0 / 0 |

## 打包前门禁

- 30 分钟隐藏窗口 soak 完整运行 30.27 分钟。主进程日志中 `unresponsive = 0`、`renderer gone = 0`，Electron 正常以 code 0 退出。
- 独立读取最终 `state.json` 复核：6 张压力卡的基线消息全部保序存在，每张卡都有新增流消息，重复消息 ID 为 0；`state.wal` 为 0 字节。
- `pnpm test:perf` 通过：34 条 Node 性能测试与 3 条 Playwright 加卡响应性测试全绿。
- 定向主题检查通过：窄视口结构化活动，以及 light/dark 下窗口化工具组“显示更早”活动均通过快照断言。
- Windows zip 已构建到 `dist/release-20260716-195614/Chill Vibe-0.18.8-win.zip`，压缩包只有一个顶层 `Chill Vibe IDE` 目录；SHA-256 为 `3EFDAA8ABF4FF4D125D8130853662AB97FDF210A4B5522A04683DBE48BEA9F19`。
## 2026-07-21 发送后短时卡顿：持久化压缩缓存

- 红测确认：第二次发送产生的新状态如果仍引用同一条巨型历史工具消息，持久化快照必须复用
  上一次的压缩消息对象；旧实现会重新解析和生成整条压缩消息。
- 修复后 focused Node 测试 27/27 通过，`pnpm test:quality` 通过。
- 30 秒 6-stream Electron 离屏绘制门禁通过：`frameMaxGapMs=222.3ms`、
  `inputP95Ms=75.1ms`、`focusP95Ms=62.9ms`、`tabSwitchP95Ms=105.8ms`，
  零 unresponsive、零 renderer gone，持久化完整性通过。
- 40 MB 合成历史工具输出的本地快照基准中，首次压缩约 16ms，复用后的连续快照低于
  1ms；该基准只用于证明重复工作被消除，不替代 Electron 响应性门禁。
- Windows zip：`dist/release-20260721-162832/Chill Vibe-0.18.16-win.zip`，解压根目录
  只有 `Chill Vibe IDE`，SHA-256
  `FB3BF7A5DDD9554F0365B709490273301AD81E6767CFDE0B215DFBE86462CFBF`；可直接运行
  `dist/release-20260721-162832/win-unpacked/Chill Vibe.exe`。
