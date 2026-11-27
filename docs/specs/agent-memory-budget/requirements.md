# AI 内存预算 — Requirements

## 背景

2026-11-27 实测：用户同时开很多会话，各会话的 agent 无视 CLAUDE.md 里「别跑卡电脑」的软约定——同一时刻 28 个 node 进程、一个 `sim.mjs 16` 16 路并发占 2.8GB、6+ 个 `host1.mjs` 模拟、全仓 eslint 2.4GB，可提交内存只剩 15.7GB，整机卡顿。软约定靠 agent 自觉，挡不住；要做成硬拦截。

## 用户目标

agent 每次要执行「会启动重任务」的 shell 命令前，由 IDE 检查整机资源；超标就拒绝执行，并把原因告诉 agent，让它等待、降并发或先停掉自己启动的旧进程。

## 功能需求

1. 设置「AI 内存预算」，**默认开启**，含三个数值：
   - 最低空闲物理内存，默认 8 GB；
   - 最低剩余可提交内存，默认 8 GB；
   - 重进程上限，默认 8（工作集 ≥ 200MB 的 node / electron / python / java / deno / bun / 无头浏览器进程数）。
2. 对 Claude、Codex、Gemini 三个 provider 都生效，复用现有 PreToolUse / BeforeTool 守卫链；预算开启时，即使危险命令防护、越界写入、攻形检测全关，也要注入钩子。
3. 只拦 shell 类工具（Claude `Bash` / `PowerShell`、Codex shell、Gemini `run_shell_command`），不拦 Edit / Write 等文件工具。
4. 只拦「会启动重任务」的命令：node / npm / pnpm / npx / yarn / bun / deno / tsx / tsc / vite / vitest / jest / playwright / eslint / electron / python / pytest / java / gradle / mvn / cargo / go / dotnet 等，以及直接执行 `.js/.mjs/.cjs/.ts/.py` 脚本；git / ls / 读文件 / 查进程等轻命令放行；kill / taskkill / Stop-Process / pkill 必须放行；只查版本号或帮助（`node --version`、`pnpm -v`）放行。
5. 拒绝信息要让 agent 看懂：当前空闲 X GB / 可提交 Y GB / 重进程 N 个（列出前几个大进程的命令行摘要），要求它等待、降并发，或先停掉**自己**启动的旧进程；明确不许去杀别的会话的进程。
6. 检查要快：钩子超时 5 秒；探测本身限时 3 秒，超时 / 出错一律放行（fail-open），不能卡死 agent。
7. 设置面板显示这些项（中英 i18n）；关闭开关时三个数值收起。
8. 老存档没有这些字段时按默认值补齐（默认开启）。

## 非目标

- 不限制会话数、回合数或 provider 启动（见 `docs/specs/provider-run-resource-guard`：不以排队/限并发代替根因修复）。本功能只在资源已经紧张时拒绝启动**新的重任务命令**。
- 不替 agent 杀进程，不自动降并发。
- 不拦文件编辑工具，不拦读取类命令。

## 验收

- 守卫单测：重/轻命令分类、包装层（`bash -c`、`powershell -Command`、`cmd /c`、`Start-Process`、`timeout`/`nohup` 前缀）、kill 放行、超标拒绝信息含三项数字与进程摘要、探测失败放行。
- 预算单独开启（其它防护全关）时 Claude `--settings` 带 PreToolUse 钩子、Codex 带 `hooks.PreToolUse`、Gemini 带 BeforeTool；预算关且其它关时不注入。
- 真实执行：经 `powershell -Command "& 'x.cmd'; exit $LASTEXITCODE"` 跑钩子，超标的 `pnpm test` 退出码 = 2，`git status` / `taskkill` 退出码 = 0。
- 设置面板快照（深浅两套）有意更新。
