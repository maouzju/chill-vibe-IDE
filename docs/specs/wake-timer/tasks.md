# 计时唤醒 — 任务

- [x] 阅读 AGENTS、UI 原则、延后发送与自动鞭策相关规格。
- [x] 冻结需求与设计假设。
- [x] 增加并运行纯逻辑/归一化测试（接手当前工作区时生产实现与测试已同时存在，无法无损重放首次红测；改用聚焦测试和真实交互回归证明行为）。
- [x] 增加共享 schema、默认值与旧存档归一化。
- [x] 实现计时器纯逻辑、批次持久化和三种触发调度。
- [x] 接入设置总开关、composer 计时器模块和待唤醒状态操作。
- [x] 补齐 i18n、主题样式、memo props 与相关文档。
- [x] 运行定向测试、quality、双主题和窄屏验证。
- [x] 构建 Windows 应用并重启当前开发运行时。

## 验证记录（2026-07-25）

- `node --import tsx --test tests/wake-timer.test.ts`：12/12 通过。
- `node --import tsx --test --test-name-pattern='wake timer|wakeTimer' tests/state.test.ts tests/state-store.test.ts`：2/2 通过。
- `powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Specs 'tests/chat-interrupt.spec.ts'`：26/26 通过，其中计时批次整批释放、真正完成后唤醒均通过。
- `pnpm test:playwright`：36/36 通过。
- `pnpm test:quality`：通过。
- `pnpm test:theme`：计时器 dark/light、桌面/窄屏用例全部通过；整套 157 项中 12 个既有非计时器快照仍有差异，未盲目更新无关快照。
- `pnpm electron:build`：通过，产出 `dist/release-20260725-014058/Chill Vibe-0.18.17-win.zip` 和可直接运行目录。
- `pnpm dev:restart`：通过；开发 Electron 已连接 `http://localhost:5173`，健康检查返回 200。运行中的旧打包版未被关闭或重启。

## UI 切换兜底修复（2026-07-25）

- 新增“菜单打开后再启用计时器”的双主题窄高视口回归；修复前 dark/light 均稳定复现菜单越过底边，修复后 2/2 通过。
- 设置菜单现在会观察自身、锚点和卡片尺寸，内容展开或模式切换后立即重新定位；可用高度不足时改为菜单内部滚动。
- `pnpm exec playwright test --config playwright.config.ts tests/theme-check.spec.ts --grep 'wake timer'`：4/4 通过，现有计时器快照无意外变化。
- `pnpm test:quality`：通过。
- `pnpm test:theme`：本次计时器用例全部通过；整套 159 项中 11 个既有非计时器快照仍有差异，未盲目更新无关快照。
- `pnpm electron:build`：通过，产出 `dist/release-20260725-144641/Chill Vibe-0.18.17-win.zip` 和可直接运行目录。
- 当前正在运行的 `dist/release-20260725-014058` 打包版承载用户会话，按运行时安全规则未强行关闭或重启。

## 提前唤醒与内部标签修复（2026-07-25）

- [x] 增加失败测试，复现“等待名单为空但同工作区仍有 Agent 正在运行时错误释放”。
- [x] 工作区模式释放前增加实时运行态硬校验，不再只信持久化等待名单。
- [x] 批次合并仅发送用户原文，不再把“待唤醒消息 N / Scheduled message N”写进 Agent 请求。
- [x] 完成聚焦回归、quality、Windows 构建与安全运行时处理。

## 取消后复原消息（2026-07-27）

- [x] 红测证明取消批次会丢失待唤醒文字、附件或覆盖现有草稿。
- [x] 取消时把整批内容按原顺序放回 composer，并保留用户已开始编辑的新草稿。
- [x] 完成聚焦测试、quality、Windows 构建与当前开发运行时重启。

验证记录：

- 红测：`node --import tsx --test tests/wake-timer.test.ts` 因缺少取消复原逻辑稳定失败。
- 绿测：`node --import tsx --test tests/wake-timer.test.ts`：13/13 通过。
- `powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Specs 'tests/chat-interrupt.spec.ts'`：28/28 通过，覆盖取消后实时草稿与持久化草稿同时复原。
- `pnpm test:quality`：通过。
- `pnpm electron:build`：通过，产出 `dist/release-20260727-010022/Chill Vibe-0.18.19-win.zip` 与可直接运行目录。
- `pnpm dev:restart`：通过；开发 Electron 已重启，renderer `http://localhost:5173` 健康检查返回 200。运行中的旧打包版未被关闭或重启。

## 左侧链式待唤醒（2026-07-28）

- [x] 红测证明左邻自己压着待唤醒批次时，right 卡把它当成“已完成”立即发车，链式接力断掉。
- [x] `left-tab` 模式把「左邻压着未释放批次」也算作未完成，形成 `A ← B ← C` 接力。
- [x] `workspace-agents` 明确不参与链式（全对全等待会互相死锁），并在代码留下决策注释。
- [x] 目标卡批次被取消时复用完成广播解锁下游，避免链断处永久卡死。

验证记录：

- 红测：`npx playwright test tests/chat-interrupt.spec.ts --grep 'chains onto a left neighbour'` 在回退实现后稳定失败（等待状态根本不出现，右侧卡立即发车）。
- 红测：`npx tsx --test tests/wake-timer.test.ts` 新增链式用例失败，防死锁的 workspace 用例同时通过。
- 绿测：`npx tsx --test tests/wake-timer.test.ts`：15/15 通过。
- 绿测：`npx tsx --test tests/wake-timer.test.ts tests/state.test.ts tests/state-store.test.ts tests/app-helpers.test.ts`：185/185 通过。
- 绿测：`npx playwright test tests/chat-interrupt.spec.ts`：33/33 通过，覆盖链式等待与取消后解锁。
- `pnpm test:quality`：通过。

## 左邻完成广播门控（2026-08-02）

- [x] 红测复现：左邻原回合结束并回到 `idle`，但它自己仍压着待唤醒批次时，下游会被完成广播错误唤醒。
- [x] 完成广播只对 `left-tab` 把“仍有待唤醒批次”视为未完成；只有左邻真正发车并完成后才解锁下游，工作区模式保持原语义以免死锁。
- [x] 保留取消批次的显式解锁语义，避免取消后下游永久等待。

验证记录：

- 红测：`node --import tsx --test tests/wake-timer.test.ts` 新增完成广播用例稳定失败，实际错误返回 `true`。
- 绿测：`node --import tsx --test tests/wake-timer.test.ts`：17/17 通过。
- `pnpm test:quality`：通过。
- `pnpm electron:build`：通过，产出 `dist/release-20260802-110921/Chill Vibe-0.18.21-win.zip` 与 `win-unpacked/Chill Vibe.exe`。
- `pnpm dev:restart`：通过；开发 Electron 已重启，renderer `http://localhost:5173` 返回 200。运行中的打包版未被关闭或重启。

验证记录：

- 红测：`node --import tsx --test tests/wake-timer.test.ts` 同时复现“运行中 Agent 未阻止释放”和“内部标签被注入请求”两项失败。
- 红测：`scripts/run-playwright-specs.ps1 -Specs tests/chat-interrupt.spec.ts` 新增恢复批次场景稳定复现提前释放。
- 绿测：`node --import tsx --test tests/wake-timer.test.ts`：12/12 通过。
- 绿测：`scripts/run-playwright-specs.ps1 -Specs tests/chat-interrupt.spec.ts`：27/27 通过。
- `pnpm test:quality`：通过。
- `pnpm electron:build`：通过，产出 `dist/release-20260725-222913/Chill Vibe-0.18.17-win.zip` 与 `win-unpacked/Chill Vibe.exe`。
- 用户当前运行的是旧的 `dist/release-20260725-014058` 打包版并承载活跃会话，按安全规则未强制关闭；新构建已放入独立时间戳目录，可在用户自行切换后生效。

## 默认启用与产品命名（2026-08-02）

- [x] 红测锁定：新设置与缺失旧字段默认开启，显式关闭值仍保留。
- [x] 设置页与会话输入设置中的中文名称统一改为“计划唤醒”。
- [x] 完成聚焦测试、quality、主题检查、Windows 构建与当前开发运行时重启。

验证记录：

- 红测：`node --import tsx --test tests/wake-timer.test.ts` 新增 3 项断言稳定失败，分别证明默认值、旧配置归一化和中文名称尚未更新。
- 绿测：`node --import tsx --test tests/wake-timer.test.ts tests/default-state.test.ts tests/state.test.ts tests/state-store.test.ts`：198/198 通过；最终聚焦复跑 `tests/wake-timer.test.ts`：18/18 通过。
- `pnpm test:quality`：通过。
- 定向主题快照：7/7 通过，已人工检查并仅更新本次默认开启与名称变化涉及的 dark/light 快照。
- `pnpm test:theme`：159 项中 158 项通过；唯一无关的 Git light 快照出现一次性波动，单项原样复跑 1/1 通过，未更新无关快照。
- `pnpm electron:build`：通过，产出 `dist/release-20260802-224227/Chill Vibe-0.18.21-win.zip` 与 `win-unpacked/Chill Vibe.exe`。
- `pnpm dev:restart`：通过；开发 Electron 已重启，renderer `http://localhost:5173` 返回 200。运行中的打包版承载活跃会话，按安全规则未强制关闭或重启。

## 空输入继续会话等待唤醒（2026-08-03）

- [x] 红测复现：逐卡计时器已开启时，空输入“继续会话”因没有文字/附件绕过待唤醒队列并立即运行。
- [x] 用显式 continuation 标记区分真实继续操作与会损坏存档的普通空队列项。
- [x] 条件满足后继续原会话且不追加空白用户消息；取消时保留当前草稿。
- [x] 完成聚焦测试、quality、Windows 构建与当前开发运行时重启。

验证记录：

- 红测：`node --import tsx --test tests/queued-send-persistence.test.ts`：6 项中 2 项按预期失败，分别证明空继续仍未入队、显式空继续仍被持久化 schema 丢弃。
- 绿测：`node --import tsx --test tests/queued-send-persistence.test.ts tests/wake-timer.test.ts`：24/24 通过。
- 交互回归：`scripts/run-playwright-specs.ps1 -Specs tests/chat-interrupt.spec.ts`：34/34 通过；空输入继续先显示“Waiting to wake”，立即唤醒后复用原 `sessionId`，且不产生空白用户气泡。
- `pnpm test:quality`：通过。
- `pnpm electron:build`：通过，产出 `dist/release-20260803-185146/Chill Vibe-0.18.22-win.zip` 与 `win-unpacked/Chill Vibe.exe`。
- `pnpm dev:restart`：通过；开发 Electron 已重启，renderer `http://localhost:5173` 返回 200，运行中的打包版未被关闭或重启。

## 右键即计划唤醒 + 记住唤醒方式（2026-08-14）

- [x] 红测复现：空闲卡右键发送被当成普通立即发送；新建 Tab 的唤醒方式总是回到 `workspace-agents`/30 分钟。
- [x] `shouldArmWakeTimerForDeferSend` 与 `collectWakeTimerDefaultPreference` 两个纯函数。
- [x] `enqueueWakeTimerSend` 支持原子激活逐卡开关。
- [x] settings 两个默认字段 + 归一化 + patch 白名单 + `addTab` 种子。
- [x] 发送按钮 tooltip 说明空闲态右键的新语义。
- [x] 聚焦测试、quality、Windows 构建。

验证记录：

- 红测：`node --import tsx --test tests/wake-timer.test.ts` 因缺少两个纯函数导出直接失败；补上函数后 settings 默认值断言继续红（`undefined` vs `workspace-agents`）。
- 红测：`node --import tsx --test --test-name-pattern='wake condition' tests/state.test.ts` 2/2 失败，分别证明新 Tab 不继承记住的条件、`updateSettings` 不认新字段。
- 红测：把 `armsWakeTimerFromDeferSend` 临时短路为 `false` 后，`tests/chat-interrupt.spec.ts` 的「右键空闲卡排入待唤醒」用例稳定失败（1 failed / 34 passed），恢复实现后 35 passed —— 证明该交互回归确实咬得住。
- 绿测：`node --import tsx --test tests/wake-timer.test.ts tests/state.test.ts tests/default-state.test.ts tests/deferred-send-queue.test.ts tests/wake-timer-settings-panel.test.tsx tests/queued-send-persistence.test.ts tests/state-store.test.ts`：231/231 通过。
- 绿测：`scripts/run-playwright-specs.ps1 -Specs tests/chat-interrupt.spec.ts`：36/36 通过，含右键空闲卡排队 + 选完条件写回全局默认两条新用例。
- `pnpm test:quality`：通过。
- 计划唤醒本身只改了发送按钮的 tooltip 文案，没有可见布局变化；但同一次发布里的自动化看板实验性开关改了「卡片类型」设置组，视觉快照随 v0.20.2 一起重新基线，见 `docs/specs/automation-board/tasks.md`。

## 待唤醒卡回显批次摘要（2026-08-15）

- [x] 红测复现：`summarizeWakeTimerBatch` / `text.wakeTimerQueuePreview` 不存在，待唤醒状态行只有「N 条消息 · 条件」。
- [x] `summarizeWakeTimerBatch` 复用 `mergeWakeTimerRequests` + `getQueuedSendPreview`（整批合并预览，不是「下一条」）。
- [x] i18n 新增 `wakeTimerQueuePreview`（中英，纯附件批次退化为「图片消息」并带张数）。
- [x] 状态行拆成独立组件 `src/components/WakeTimerStatus.tsx`，空状态卡与 composer 两处共用。
- [x] `.composer-wake-timer-preview` 次要色 + 两行 line-clamp + `title` 全文。

验证记录：

- 红测：`node --import tsx --test tests/wake-timer.test.ts` 因缺少 `summarizeWakeTimerBatch` 导出直接失败；实现后 29/29 通过。
- 绿测：`node --import tsx --test tests/wake-timer-status.test.tsx` 2/2 通过（SSR 断言摘要行与 `title`，无摘要时不渲染空行）。
- 绿测：`scripts/run-playwright-specs.ps1 -Specs tests/chat-interrupt.spec.ts` 36/36 通过，含新增的真实浏览器断言「待唤醒状态行显示合并后的正文」。
- `pnpm test:quality`：通过。
- 视觉：dark 空状态卡实截确认摘要为次要色两行、超出省略；颜色只用 `--ink-3` token，两套主题共用。CSS 特异性坑已记在注释里（`.composer-wake-timer-copy span` 的 nowrap 会压掉未加父类的 line-clamp）。

## 待唤醒卡上直接换唤醒方式（2026-08-15）

- [x] 红测复现：`rearmWakeTimerBatchForPatch` 不存在，挂起批次改条件不会重算等待目标/到点时间。
- [x] 纯函数 `rearmWakeTimerBatchForPatch`：无批次或 patch 不含条件时返回 `null`，`left-tab` 无左邻时返回 `ok:false` 并保持原条件。
- [x] App 侧统一入口 `patchCardWithWakeTimerRearm`：composer 设置菜单、待唤醒状态行、看板抽屉、超管 MCP 四条 patch 路径共用；只有 composer 那条会顺带写「新会话默认」偏好。
- [x] 状态行内嵌唤醒方式下拉 + duration 分钟输入（`WakeTimerStatus`），设置面板不再禁用控件，改文案为「改条件会立刻给当前这批消息改期」（`wakeTimerBatchRearms`）。
- [x] 无有效左邻时 `left-tab` 选项在两个入口都 disabled。

验证记录：

- 红测：`node --import tsx --test tests/wake-timer.test.ts` 因缺少 `rearmWakeTimerBatchForPatch` 导出失败；实现后 34/34 通过（含改期重算、duration 从改动时刻重新计时、拒绝无左邻切换三条）。
- 红测：`tests/wake-timer-settings-panel.test.tsx` 的锁定用例改成「保持可编辑」后先红（仍渲染 `disabled`），解锁后 10/10 通过。
- 红测：`tests/wake-timer-status.test.tsx` 新增三条下拉用例先红，组件补上后 5/5 通过。
- 绿测：`scripts/run-playwright-specs.ps1 -Specs tests/chat-interrupt.spec.ts,tests/automation-board-layout.spec.ts` 49/49 通过，含新增用例「待唤醒卡上把 duration 换成 workspace-agents 后重新绑定到正在跑的同事，且消息不发车」。
- `pnpm test:quality`：通过。
- 视觉：空状态卡 22rem 横排放不下下拉，实截发现标题折行、条件被截断；改为文案独占一行 + 控件另起一行（`is-empty-state` 内 `flex-wrap`），宽度放到 24rem 后复测正常。CSS 特异性坑记进 AGENTS 第 90 条。
