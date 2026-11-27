# AI 内存预算 — Tasks

## Slice 1 — 守卫（Tier 1，红→绿）

- [x] 红：`tests/memory-budget-guard.test.ts`：重/轻分类、包装层、kill 放行、版本查询放行、evaluate 信息、探测失败放行、PowerShell 工具名、env 解析。
- [x] 绿：`server/memory-budget-guard.js` + `.d.ts`；守卫 `evaluateToolUse` 改 async 接入；`shellToolPattern` 认 `PowerShell`。

## Slice 2 — 设置链路（Tier 1，红→绿）

- [x] 红：`tests/agent-memory-budget.test.ts`：默认值/规范化、请求透传（三个 provider）、预算单开时注入钩子 + env、Claude matcher 含 PowerShell、池签名随预算变化。
- [x] 绿：schema / default-state / codex-chat-settings / state.ts / codex-safety.ts / providers.ts / App.tsx useMemo。

## Slice 3 — 设置面板（Tier 2）

- [x] i18n 中英；App.tsx 控件；index.css 网格。
- [x] `tests/theme-check.spec.ts` 计数 +1，`codex-safety-settings-{dark,light}` 快照有意刷新；截图 `D:\Temp\memory-budget-settings.png`。

## Slice 4 — 收尾

- [x] 真钩子实测退出码（超标 pnpm → 2；git / taskkill → 0）。
- [x] 窄测试 + `pnpm test:quality`；AGENTS.md pitfall。

## 验证记录（2026-11-27）

- 红：`tests/memory-budget-guard.test.ts`（模块不存在）、`tests/agent-memory-budget.test.ts` 5/5 失败；实现后全绿。
- 窄测试 10 个文件 219/219 通过；`tests/provider-system-prompt.test.ts` 136 条中 matcher 两条断言随改动更新后通过；`pnpm check` 通过；改动文件 eslint 干净（未跑全仓 eslint）。
- 真钩子（`powershell -Command "& 'pre-tool-use-guard.cmd'; exit $LASTEXITCODE"`）：不可能满足的预算下 Bash `pnpm test` / PowerShell `npx vitest run` / Gemini `node tools/sim.mjs 16` 退出码 2（约 0.8~0.9s），`git status`、`Stop-Process`、`taskkill` 退出码 0（约 0.2s，不探测）；默认 8/8/8 与宽松预算下 `pnpm test` 退出码 0（约 0.6s）。
- Playwright：`codex-safety-settings-{dark,light}` 有意刷新，连跑两轮稳定；`default-admin-{dark,light}-off` 为既有红（干净 HEAD 工作树同样 917→948 宽度不符），未动。
- 设置面板末尾的悬停说明向下弹会被分组卡片裁掉，改为向上弹（`.settings-hover-detail.is-note-above`）。
- 未做：没在真 Claude / Codex / Gemini 回合里看拦截提示（钩子链路与危险命令防护共用，已有真机先例）。
