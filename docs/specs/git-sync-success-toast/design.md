# Git 同步完成飘字 — Design

## 现状

- `src/components/git-operation-hub.ts` `runSyncPipeline()` 在 push 成功后写
  `syncStep: { kind: 'done', message: text.syncSuccess }`，面板保持 `syncPanelOpen = true`。
- `src/components/GitSyncPanel.tsx` 的 `done` 分支渲染一条成功 notice + 一个调用
  `closeSyncPanel()` 的按钮 —— 这就是"需要点击关闭的窗口"。
- `GitOperationSnapshot.notice` 已经是 Git 卡的通用提示通道（commit-new 成功/失败在用），
  渲染在 `GitToolCard.tsx` 顶部，常驻直到下一次自动刷新清掉。

## 方案

### 1. hub：push 成功直接收面板 + 发飘字

`runSyncPipeline()` push 成功分支改为：

```ts
patch(workspacePath, {
  lastStatus: latestStatus,
  syncPanelOpen: false,
  syncStep: { kind: 'idle' },
})
showTransientNotice(workspacePath, { tone: 'success', message: text.syncSuccess })
```

`GitSyncStep` 的 `done` 变体随之删除 —— 没有任何路径再产生它，留着就是死状态。

### 2. hub：`showTransientNotice` 负责自动过期

在 `WorkspaceSession` 上加 `noticeTimeout: ReturnType<typeof setTimeout> | null`：

- 设置 notice 时先清掉上一把计时器（避免两条飘字互相把对方的过期时间挤掉）。
- `TRANSIENT_NOTICE_MS = 2600`，到点若 notice 仍是同一条（用 `noticeToken` 递增序号比对）
  才清空，避免把期间新写入的 error notice 误清。
- `clearNotice()` 同时清计时器。

放在 hub 而不是组件里的原因：hub 是模块级 store，卡片切后台仍在跑同步（见文件头注释）。
过期逻辑若挂在组件 effect 上，用户切走再切回就会看到一条永不消失的旧飘字。

### 3. 渲染：飘字是浮层，不是横幅

`GitOperationNotice` 增加 `transient?: boolean`。`GitToolCard` 对 `transient` 的 notice
渲染成 `.git-tool-toast`（绝对定位在卡片顶部居中、不参与布局、`pointer-events: none`、
`git-tool-toast-in` 淡入 + 末尾淡出），普通 notice 仍走原来的 `.git-tool-notice` 横幅。

不占布局是关键：成功态不该把 Git 卡的内容往下顶一次再弹回来。

### 4. 失败态不动

`GitSyncPanel` 的 `error` 分支原样保留（重试 / 取消）。失败需要用户决策，不能飘走。

## 被否决的替代方案

- **只把按钮删掉、面板自己 setTimeout 关闭**：计时器活在组件里，切后台 unmount 后不执行，
  切回来还是一个挂着的成功面板。
- **复用现有常驻 notice 横幅不加过期**：用户要的是"飘字"，常驻横幅得等下一次自动刷新才消失，
  而自动刷新有节流，最长会挂很久。

## 验证

- Tier 1：`tests/git-operation-hub.test.ts` 补/改断言（push 成功后 `syncPanelOpen === false`、
  notice 为 transient success、虚拟时钟推进后自动清空；error 态面板仍开着）。
- Tier 2：`tests/theme-check.spec.ts` 已有 git 卡快照；飘字是新增浮层样式，跑 `pnpm test:theme` 确认无回归。
