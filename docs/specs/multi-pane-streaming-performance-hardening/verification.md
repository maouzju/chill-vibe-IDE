# 多窗口流式性能兜底 — 验证记录

## 2026-07-19 输入与 Tab 交互优先补强

- 当前用户包 `v0.18.12` 运行约 12 小时、5 张卡 streaming 时，10 秒现场采样显示
  renderer / GPU 分别持续占用约 60% / 74% 单核；状态约 1.83 MiB、15 张卡、855 条消息。
- 旧门禁的输入指标只统计同步 textarea 赋值，没有等待下一帧，无法代表用户何时真正看到文字；
  本次改为输入、聚焦和两次 tab 切换都等待实际下一帧后再计时。
- 新增普通流式 commit 的交互保护：输入、IME、pointer、click、wheel 后 120ms 内延后刷新，
  单次到期刷新最多额外延迟 300ms；完成、停止、报错、恢复、退出前的强制 flush 不变。
- 30 秒 6-stream 离屏真实绘制门禁：`frameMaxGapMs=211.9ms`、
  `inputP95Ms=72.8ms`、`focusP95Ms=72.2ms`、`tabSwitchP95Ms=149ms`，
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
