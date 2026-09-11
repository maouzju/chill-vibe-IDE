# 顶栏标签按住拖动窗口 — 任务

## 2026-09-11

- [x] 阅读 `AGENTS.md`、`docs/specs/workspace-column-dock/design.md`（顶栏 drag/no-drag 约定）、
      `electron/window-hit-test-rebuild.ts`（主进程窗口几何模块模式）。
- [x] 冻结需求与设计：CSS 不能解决，改为 pointer 手势 + IPC 移动窗口。
- [x] 红测：主进程几何纯函数与控制器、渲染侧手势状态机、桥接 API、主进程/preload 结构守卫。
- [x] 实现 `electron/window-pointer-drag.ts` 与 `main.ts` 三条 IPC。
- [x] 实现 `preload.ts` / `electron.d.ts` / `src/api.ts` 桥接。
- [x] 实现 `src/components/topbar-window-drag.ts` 并挂到 `App.tsx` 顶栏标签。
- [x] Playwright：拖动不切换标签、单击仍切换（github-shell.spec 3/3）；`pnpm test:quality` 绿。
- [x] `pnpm electron:build` 产出新包：dist/release-20260911-103201（asar 已含 pointer-drag IPC）。
- [x] 真机 Electron 运行时用例 `tests/electron-topbar-window-drag-runtime.test.ts`（已登记进
      `scripts/run-electron-runtime-tests.ps1`）：最大化窗口收到 begin 后 `unmaximize()` 紧接的
      `getBounds()` 已是还原尺寸（1000×700 实测同步），窗口落在真实光标下；end 之后的 move 不再动窗口；
      最小化窗口拒绝拖动。2/2 绿，单条约 13s。
- [x] 本轮本地复审：发现按住暂停超过 3 秒后拖动失效；新增定向测试先红后绿，
      用拖动期间 500 ms 合帧续期保留主进程失联保护，松手/取消/丢失捕获即停止。
- [x] 本轮定向 Node 测试 80/80；`github-shell.spec.ts` 4/4（亮/暗主题拖动与点击，
      桌面/窄屏既有外观检查，无样式或快照修改）；真实 Electron 用例 2/2。
- [x] `pnpm electron:build` 新包 `dist/release-20260911-155506/Chill Vibe-0.20.19-win.zip`，
      可直接运行 `win-unpacked/Chill Vibe.exe`；zip 单顶层目录 `Chill Vibe IDE`。
- [x] 全局质量检查已执行：ESLint 通过，app 类型检查通过；server 类型检查被当前工作区
      既有 `server/index.ts:936` 的 `ChatStreamStopResult.interrupted` 错误阻断。
      不改动其他任务的聊天中断逻辑；不能把本轮报告表述成全仓质量检查全部通过。
      单独补跑 node 类型检查通过；test 类型检查仅报现有聊天中断测试/状态测试错误
      （`tests/chat-manager-soft-interrupt.test.ts`、`tests/state.test.ts`）。
- [x] 检查活动运行面：用户仍运行 `dist/release-20260910-133457/win-unpacked/Chill Vibe.exe`。
      未经明确授权不关闭或重启这个打包版；交付新包路径，用户退出旧版后启动新版。
