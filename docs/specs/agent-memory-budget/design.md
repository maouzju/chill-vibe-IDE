# AI 内存预算 — Design

## 数据流

```
AppSettings.memoryBudgetEnabled / memoryBudgetMinFreeGb / memoryBudgetMinCommitGb / memoryBudgetMaxHeavyProcesses
  → buildCodexChatRequestOverrides（三个 provider 分支都带）
  → ChatRequest.memoryBudget?: { minFreeGb, minCommitGb, maxHeavyProcesses }（只在开启时带；省略 = 关闭）
  → prepareDestructiveCommandGuardRuntime：memoryBudget 存在即注入钩子，写 env
      CHILL_VIBE_MEMORY_BUDGET_ENABLED=1
      CHILL_VIBE_MEMORY_BUDGET_MIN_FREE_GB / _MIN_COMMIT_GB / _MAX_HEAVY_PROCESSES
  → 同一个 launcher（pre-tool-use-guard.cmd/.sh）→ codex-destructive-command-guard.js
      先攻形 → 危险命令 / 越界写 → 都放行后再做内存预算
```

- 阈值走环境变量而不是钩子命令行：Codex session-flags 钩子按命令文本算信任哈希，命令必须所有卡一致（pitfall #206）。
- Claude 常驻进程池签名加入 `memoryBudget`，改阈值 / 开关后下一回合换进程（env 只在 spawn 时生效）。Codex / Gemini 每回合新起进程，天然生效。
- Claude PreToolUse matcher 从 `Bash|Edit|Write|NotebookEdit` 扩成 `Bash|PowerShell|Edit|Write|NotebookEdit`；守卫的 shell 工具名也认 `PowerShell`。Windows 上 Claude Code 有原生 PowerShell 工具，之前它完全绕过危险命令防护（与 #444 Gemini 工具名同根因）。

## 模块

`server/memory-budget-guard.js`（纯 JS，钩子进程直接加载，配 `.d.ts`）：

- `readMemoryBudgetFromEnv(env)` → budget | null。
- `isHeavyShellCommand(segments)`：输入守卫已有的 `analyzeShellText` 切好的子命令段（已展开 `bash -c` / `powershell -Command` / `cmd /c` / `-EncodedCommand`）。每段跳过 `VAR=x`、`&` 调用符、前缀（sudo/env/nohup/time/timeout/nice/start/Start-Process/call…及其选项和数字参数），取真正的命令名；命中重命令表且参数不全是 `--version/-v/--help/-h/version` → 重。直接执行 `*.js|mjs|cjs|ts|mts|py` 也算重。
- `probeSystemMemory({ platform, timeoutMs, budget })`：
  - Windows：一次 `powershell -NoProfile -NonInteractive -Command`，`Get-WmiObject Win32_OperatingSystem`（比 CIM 少约 100ms 模块加载）拿 FreePhysicalMemory / FreeVirtualMemory（= 提交上限 − 已提交，即剩余可提交）；`Get-Process -Name <重进程名单>` 按工作集过滤；只有超标时才用 `Get-WmiObject Win32_Process -Filter "ProcessId=… OR …"` 取前 5 个的命令行。2026-11-27 本机实测：放行路径约 450ms，超标路径约 950ms；`Get-CimInstance` 全量命令行约 1s，PerformanceCounter 6.4s。
  - Linux：`os.freemem()`，`/proc/meminfo` 的 `CommitLimit − Committed_AS`，`ps -axww -o pid=,rss=,args=`。
  - macOS：`os.freemem()`，可提交项不检查（null），进程同 Linux。
  - 任何失败 / 超时（3s，kill 子进程）→ 返回 null。
- `evaluateMemoryBudget(snapshot, budget)` → `{ allowed, reason }`，纯函数；snapshot 某项为 null 时该项不判。
- `assessMemoryBudget(input, { env, probe })`：工具名不是 shell、预算关、命令不重 → 放行；探测 null → 放行；否则按 evaluate。

拒绝信息（stderr，退出码 2，开头 ASCII 哨兵 `CHILL_VIBE_MEMORY_BUDGET_BLOCK` 便于日志检索）：

```
Chill Vibe 内存预算：整机资源紧张，已暂缓这条会启动重任务的命令（命令未执行）。
当前：空闲物理内存 5.2 GB（下限 8 GB）/ 剩余可提交 6.1 GB（下限 8 GB）/ 重进程 11 个（上限 8）。
占用最大的进程：
- node 2.7 GB  pid 42976  node tools/sim.mjs 16 --avail ...
请：1) 等一会儿再试（其它会话的任务结束后会自动释放）；2) 降低并发（如 16 路改 2~4 路、--max-old-space-size ≤ 3000）；3) 如果上面有你自己这个会话之前启动、已不再需要的进程，先停掉它。不要结束其它会话启动的进程。
查看 / 结束进程、git、读文件等轻命令不受限制。
```

## 设置面板

放在「Agent 安全防护」块末尾：开关 + 悬停说明；开启时下面一行三个数字输入（`.memory-budget-fields`，auto-fit 网格，窄屏自动换行）。数值范围：内存 0–256 GB（步进 1），进程 1–64；非法值回落默认。

## 风险

- 误拦：`node -e` 小脚本在资源紧张时也会被拦（无法确定它会不会起重任务）；信息里写明可以等。
- 探测进程本身的开销：只在重命令时探测，单次 ≤ 1s。
