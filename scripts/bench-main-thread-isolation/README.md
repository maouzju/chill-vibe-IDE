# 主线程隔离效果基准

一句话：**证明「把阻塞操作搬出主进程」确实能治住窗口卡死，而不是把问题挪个地方。**

```
pnpm exec electron scripts/bench-main-thread-isolation
```

## 为什么有这个基准

- **症状**：用户报"闪退"。实测退出码 `0xCFFFFFFF` —— Windows 因为窗口 5 秒不泵消息把进程杀了。
  也就是说闪退是卡死的结局，不是崩溃。外部监控实测冻结 10~19 秒（`logs/app-unresponsive.log`）。
- **根因**：`server/` 全部跑在 Electron 主进程主线程上，而 libuv 在 Windows 上**同步执行
  `CreateProcessW`** —— 每次 `spawn('git', …)` 都是主线程硬阻塞。2026-08-12 实测这台机器上
  单次 git spawn p50=102ms、最坏 6910ms，一次就够跨过 5 秒线。
- **为什么不能只优化调用点**：削掉最重的几处只是把出血点堵上，主线程和消息泵共用一个线程这个
  结构没变，下一个重活照样卡死。基准要回答的是结构问题，不是某一处的耗时。

## 2026-08-12 实测结果

同一批 20 次 `git cat-file`，唯一区别是跑在哪个进程：

| 跑在哪 | 单次最长停摆 | 停摆 >1s | 停摆 >5s | 判定 |
|---|---|---|---|---|
| 主进程（改造前） | **6827ms** | **11 次** | **2 次** | 会被 Windows 当无响应杀掉 |
| utilityProcess（改造后） | **58ms** | 0 | 0 | 窗口全程可响应 |

同一脚本前一次运行主进程侧录到单次 **14094ms**，与用户现场 10~19 秒的冻结量级一致。

## 可行性探针

```
pnpm exec electron scripts/bench-main-thread-isolation/probe-utility-process.js
```

回答三个「错了就得推翻方案」的问题，实测结论（Electron 36.9.5）：

| 探针 | 结论 |
|---|---|
| utility 里 `process.versions.electron` | 可见 = 36.9.5 → MCP/超管的 `ELECTRON_RUN_AS_NODE` 判断不变 |
| fork 的 `env` | 默认继承，也可显式覆盖 |
| fork 的 `cwd` | 路径存在即可（正反斜杠都行） |
| fork 的 `cwd` 指向**不存在**的目录 | **子进程静默死亡**：不抛异常、无 `exit` 事件、`postMessage` 石沉大海 |
| 子进程内 `process.chdir()` | 可用，失败会抛可捕获的错误 —— **优先用它** |

最后一条很要紧：`server/app-paths.ts` 的 `getAppDataDir` 有 `process.cwd()` 兜底，工作目录错了就是**数据目录静默漂移**，用户视角是"历史全没了"。

## 读数怎么看

只看**单次连续停摆**（`maxLagMs`），不要看累计——Windows 判无响应看的是「消息队列连续 5 秒没被服务」，
和一段时间内累计卡了多久无关。跑得越久累计越大，那个数没有判据意义。

心跳每 50ms 一次，`lag = 实际间隔 - 50ms` 就是主线程被占住的时长，等价于窗口消息泵停摆的时长。
