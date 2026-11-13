# 上下文占用显示 + 快满自动压缩 — 任务

- [x] 1. `shared/schema.ts`：`StreamContextUsageEvent`、`StreamEventMap.context_usage`、两个设置字段（两处默认值）
- [x] 2. `shared/default-state.ts`：默认值 + `normalizeAppSettings`
- [x] 3. `server/provider-turn-telemetry.ts`：Claude / Codex 占用读取纯函数 + 测试
- [x] 4. `server/providers.ts`：`StreamSink.onContextUsage`、Claude `handleLine`、Codex 通知分支
- [x] 5. `server/chat-manager.ts`：两处 sink 接线 + backlog 合并键（`shared/context-usage.ts` 折叠）+ 测试
- [x] 6. `src/api.ts`：`onContextUsage` 回调
- [x] 7. `src/components/context-usage.ts`（纯函数）+ `context-usage-store.ts` + 测试
- [x] 8. `src/components/chat-card-compaction.ts`：App 发起的自动压缩边界 + 等待口径 + 测试
- [x] 9. `src/components/ContextUsageIndicator.tsx` + `src/index.css` + `ChatCard.tsx` 挂载
- [x] 10. `src/App.tsx`：流事件处理、落盘、发送前判定、`done` 静默、失败不重试
- [x] 11. 设置项：`settings-model.ts`、`src/state.ts`、`app-panel-text.ts`、`App.tsx` 设置面板
- [x] 12. `tests/index.test.ts` 注册、lint、类型检查、相关测试
- [x] 13. 同步 `docs/specs/deferred-send-queue` 的等待口径说明
- [x] 14. 界面快照（`tests/theme-check.spec.ts`）：圆环三档 × 明暗、按钮区位置、悬停气泡（含 360px 窄卡不出卡片）、
      设置项开 / 关 × 明暗；`tests/settings-hover-hints.spec.ts` 清单加 `auto-compact-toggle`
- [x] 15. 悬停气泡右半截被卡片裁掉 → 只改这一个气泡的定位（AGENTS.md Known Pitfalls #418）
- [x] 16. 设置项插在「对话行为」之后，排在它后面的条目整体亚像素下移：刷新 `model-picker-settings-{dark,light}`、
      `jev-settings-{dark,light}` 四张快照（先例：提交 `7b85768`），分类条目数断言 6 → 7（AGENTS.md Known Pitfalls #419）

独立审查（2026-11-12）查出的 5 个缺陷，每个先写失败测试再修：

- [x] 17. 压缩过的卡另开新会话丢了开场需求 → 只有带归档回查的 provider 才按压缩边界截断，两处都问
      `supportsArchiveRecall`（#421，补 #226 记下的缺口）；守卫 `tests/chat-request-seeding.test.ts`
- [x] 18. 自动压缩被放弃时提前唤醒等待方 → 两个出口统一走 `finishAbandonedAutoCompactRun`（#422）；
      守卫 `tests/app-helpers.test.ts`
- [x] 19. 改设置后已打开卡片的圆环不更新 → `areWorkspaceColumnPropsEqual` / `arePaneViewPropsEqual` 补比两个设置（#423）；
      守卫 `tests/context-usage-memoization.test.ts`
- [x] 20. 挂着的压缩边界被当成压过 → 占用回扫跳过 `compactPending` 的边界（#424）；守卫 `tests/context-usage.test.ts`
- [x] 21. 手机监工镜像隐藏的 `/compact`、为压缩回合响铃 → `chatRequestSchema.origin` 一路带到手机页（#425）；
      守卫 `tests/chat-manager-backlog.test.ts`、`tests/chat-stream-tap.test.ts`、`tests/remote-monitor.test.ts`、
      `tests/remote-monitor-page.test.ts`

## 验证记录（2026-11-12，本机 Windows）

- theme 套件 247 条：227 过、20 红。拿干净的 `HEAD` worktree 只重跑这 20 条做对照：
  - 16 条原版代码在本机就红，且两边截出的图逐像素相同 → 与本改动无关（本机与基线机器的渲染 / 布局差异），没动。
  - 4 条是上面第 16 项的位移，已刷新。其中 `model-picker-settings-dark` 原版在本机就差 1 个抗锯齿像素，
    所以这四张是「本机渲染」的基线，换机器可能要重新生成。
- 全量 Playwright 611 条（8 个 worker，刷新上面 4 张之后跑）：582 过、29 红。29 条都拿干净的 `HEAD` worktree
  对照过，与本改动无关：
  - 16 条：就是上面 theme 套件的常驻红。
  - 10 条截图类（`brainstorm-card-theme.spec.ts:158` / `:176`、`text-editor-card.spec.ts:160` / `:194`、
    `tool-card-settings.spec.ts:269`，各明 / 暗）：原版同样红，两边 10 张实际截图逐像素相同。
  - `repeat-loop.spec.ts:129`：原版在同一条断言（171 行 `.pane-tab` 的数量）同样失败；改动版单线程 3/3 通过。
  - `chat-interrupt.spec.ts:1468`、`:1595`：单线程两边都过，机器满载才红。原版与改动版同一时刻、同样负载
    各跑 72 次：`:1468` 原版挂 13、改动版挂 14；`:1595` 原版挂 58、改动版挂 64。给 mock 加探针记下每次保存，
    两边的保存序列形状一致，失败都是同一种（AGENTS.md Known Pitfalls #420）。
- Codex 的占用事件没有真实线上载荷可测（本机中转站 401），只按协议定义和单元测试验证。
- 没有在真实的 Electron 应用里手动验收过；「压缩回合进行中再发消息会排队」只有单元测试，没有浏览器用例。

## 验证记录（2026-11-13，改动重新放到上游 v0.21.26 之上，本机 Windows）

- ESLint、四份 `tsc --noEmit`（app / test / server / node）全过。
- 全量 Node 测试 3536 条：3533 过、2 跳过、1 红。红的是 `tests/electron-icon-asset.test.ts` 的打包图标用例，
  原版在本机同样红（本机环境原因）。
- Playwright（无头，2 个 worker）：`chat-interrupt` 43/43、`settings-hover-hints` 2/2、`composer-settings-hints` 3/3、
  `column-dock` 8/8 全过；`theme-check.spec.ts` 203 条：187 过、16 红，16 条就是上面「原版代码在本机就红」那 16 条。
  本功能的 10 条截图用例全过。
- 插曲：有一轮 3 条设置页截图（`settings-panel-narrow-dark`、`model-settings-no-recommendation-{dark,light}-390`）红了。
  原因是当时本机 8787 端口开着一个后端，这几条用例没 mock `/api/cli-compat/status`，Vite 把请求转给了它，
  拿到本机真实的 Claude 版本检测结果（「需要处理」），卡片变高。关掉后端重跑 3/3 过，与本改动无关；
  跑截图测试前先确认 8787 上没有后端。
