# Composer / Tab 聚焦失效 —— 深度调查报告

> **⚠️ 实证修正（2026-07-02 晚，取证器首战）**：取证 dump `stuck-pane-forensics-2026-07-02T13-52-09-883Z.json` 抓到复发现场，**推翻本报告对"新 tab 卡死/整 pane 锁死"形态的 stale hit-test 主线归因**。实测：20/20 pointerdown 的 event.target 与 elementFromPoint 完全一致（事件路由零病变）、救援系统零开火、焦点正常在 textarea（focus-visible 在），但 **9 个连续 1s 心跳采样返回同一 rAF 帧时间戳 = 渲染器 ≥9 秒零产帧**，把窗口带回前台的瞬间恢复。真实根因：**Chromium 120+ Windows 原生窗口遮挡误判（CalculateNativeWinOcclusion）→ 可见窗口停止产帧**，JS/事件/布局照常运转，用户面对死画面——"点击无反应"实为"点击全部生效但画面不更新"，caret 闪现即偶发单帧恢复。修复（commit 7ca3203）：禁用该 feature + `backgroundThrottling: false`（§2.2 点名的放大器）+ 主进程帧看门狗（10s 无帧且窗口可见 → `webContents.invalidate()` 强制重绘自愈）。第一/二层修复针对的事件层缺口独立存在、保留；但对本形态它们天然无感（无 misroute 信号可触发）。
>
> **多流输入卡顿跟进（2026-07-10）**：发布环境现场为 7 个可见 pane 同时 streaming，`state.json` 约 1.1MB，并非超大存档；但 Electron 关闭硬件加速后，渲染进程与软件 GPU 进程都持续占满约 1 个 CPU 核。两个可线性叠加的来源被确认：全卡 `box-shadow` 流式呼吸动画在每个 pane 上永久重绘，以及统一 80ms delta flush 让 7 张卡合计高频重渲染。修复改为：**后台 streaming 卡保留静态边框，只有当前获得键盘焦点的卡允许全卡呼吸；delta flush 随活跃流数量从 80ms 自适应退让到 120/180ms**。单会话仍保留打字机观感，多 pane 输入优先拿到主线程帧预算。
>
> **第十类根因定案（2026-07-11 15:19）**：dump `stuck-pane-forensics-2026-07-11T07-19-08-984Z.json`（旧包 `release-20260710-191818` 运行约 20 小时）用 07-10 新增的 connectivity 取证钉死上游：8 次 focusout(null) 全部 `connectedAtDispatch=true → connectedAfterMicrotask=false`，`detachedRootPath = div.pane-tab-panel.is-active`，focusout 同步栈反混淆后是 react-dom `commitDeletionEffects` 的 `removeChild(n.stateNode)`——**React commit 把当前活跃 tab 的整个 panel div 删除重建**，自愈 focusTextarea 拉回（landed=true）后 ~16ms 再次被删，3 秒内 8 次删建振荡。同窗口 composer 零属性突变（排除 disabled/hidden fixup）、无 became unresponsive、renderer 无报错（排除 ErrorBoundary）。**修正 07-09 的错误排除**：Chrome 移除聚焦子树时会派发 focusout（不派发 blur），"kick 有 focusout 所以不是 remount"不成立。数据层走查：流式窗口内 reducer 无任何删 tab/card 路径且 panel key=tabId 稳定 → 删除只能来自某次 commit 的 render 输出缺失该条目；应用内唯一 React lane 分裂源是 App.tsx 仅剩两处包 reducer 提交的 `startTransition`（delta flush / appendCardLogs），且仓库已有 transition lane 重负载下饿数秒的实证事故（活动 flush 注释）。**修复（同日）**：① 去掉这两处 `startTransition`，全 reducer 更新回归单 lane（flush 已 80-180ms 自适应节流，urgent commit 便宜）；② `PaneTabPanelUnmountProbe` 探针——panel unmount 瞬间比对数据层（appStateRef）是否仍含该 tab/card，dump 新增 `panelUnmounts` 字段（`dataLayerHasTab=true` 的 active unmount = render 丢了数据层还在的 tab = React lane 类实锤）；③ `appliedActions` 环形账本（每批 reducer action type+时间）供指认真实删 tab 的 action。测试：tests/stuck-pane-forensics.test.ts 40→44（红→绿）。
>
> **第十类复发定案（2026-07-10 12:23）**：dump `stuck-pane-forensics-2026-07-10T04-23-45-772Z.json` 在旧包 `release-20260709-180908` 运行约 17 小时后抓到 5 次 reactive focus kick。无 `became unresponsive`、rAF 正常、20/20 pointer 对账一致；每次 textarea `focusin` 后 11~18ms `focusout(null)`，`document.hasFocus()=true`、无 unfocusable 属性、无 `blur()` 调用，但调用栈落在 React commit 删除链。旧 blur rescue 又从 `textareaRef.current` 取节点并在 ref 已清空/旧节点断开时直接返回，导致新挂载的同 pane textarea 无人接力。修复改为：**用 `event.currentTarget` 保存被删节点，提交后重新查询同 pane 的 active textarea，并在下一帧 + 80ms 二次接力；仅限窗口仍聚焦、focusout 去向为空、无外部 pointer 离开、当前卡仍 active 的签名。** 取证同时新增 dispatch/微任务前后 connectivity 与 detached subtree 路径，下次可直接确认 React 删除了哪层。
>
> 2026-07-02。针对「使用久了之后，点击新 tab 或鼠标点击 agent 聊天输入框无法聚焦」的系统性审计。
> 方法：5 方向并行调查（git 考古 / rescue 系统审计 / tab 聚焦链路 / 合成层诱因 / 全局焦点竞争）+ 对每个根因候选做代码级对抗验证（14 个候选全部核实，其中若干被收窄或降级，无一凭空捏造）。
> 本文所有结论均带 `文件:行号` 或 commit 级证据，且以对抗验证后的修正表述为准。

## 0. 一句话结论

这不是一个 bug，而是**一个从未根治的 Chromium 合成层老化机制（陈旧 hit-test 表面）× 一套有确定性缺口的救援系统 × 一条无验证无重试的聚焦链路**三层叠加。历代修复都在第二、三层打补丁，第一层的老化诱因（idle 常驻动画 + 每卡永久隔离合成上下文）仍在，而救援层的几个缺口让漏网事件表现为「点了没反应」。

## 1. 症状分解

用户报告的「无法聚焦」实际是至少 4 种可区分的失效，机制不同：

| # | 症状 | 主机制 |
|---|------|--------|
| S1 | 点击输入框，第一下没反应，再点一下才行 | 救援修层不补焦点（§3.2）+ 事件不重放（§3.5） |
| S2 | 点击输入框完全无效，怎么点都不行 | 陈旧 hit-test 漏网场景（§3.4/§3.6）或修复目标错位（§3.5） |
| S3 | 点击输入框没聚焦，tab 还自己跳了 | 复合失败链（§3.5） |
| S4 | 点 tab（含新建）后输入框不自动聚焦 | 聚焦链路单发无重试 + 已激活 tab 早退 + 键盘路径绕过（§4） |

另有一个认知混杂因素：composer 聚焦成功后**视觉上几乎不可见**（focus 样式被清空、无 caret-color 定制），叠加陈旧画面时「聚焦成功」与「失败」用户无法区分——部分「没聚焦」实际可能是「聚焦了但看不出来/画面没刷新」。

## 2. 根因层：为什么「用久了」才出现

### 2.1 陈旧合成层 hit-test 表面（pitfall #129 主线）从未根治
- 每张卡 shell 永久持有隔离合成上下文：`isolation: isolate + overflow: hidden + contain: layout style`（`src/index.css:2324-2341`）。
- 修复史三波：50b9f3c (04-21) 对动态状态局部去 paint containment → 0fb7860 (v0.16.8, 05-17) 全量把 `contain: layout style paint` 降为 `layout style`（**只降频**）→ fe8e04a (06-11) 引入运行时自愈（两帧 `translateZ(0)` 层重建，`src/index.css:2362-2370`）。当前是「降频 + 检测自愈」双层缓解，机制本身未消除。
- `src/index.css:2343-2354` 的覆盖规则现在与基础规则值相同，是历史残留（可清理）。

### 2.2 最符合「用久了」的累积诱因：idle 常驻动画
- `is-complete-unread` 完成呼吸动画画在**覆盖整卡（含 composer）的 `inset:0` 伪元素层**上，idle 卡上无限期跑 2800ms 循环（completionGlow 只在用户交互时清除）。多 pane 长会话 = 数小时不间断的层重绘激励，直接作用在出问题的表面上。
- 环境放大器：天气系统雨天时全屏 `fixed + will-change + 0.8s 无限循环`合成层永久运行。
- `backgroundThrottling` 开启：窗口遮挡期间 rAF 停摆 → `is-hit-test-repair` 的移除滞留、聚焦 rAF 丢失（与 pitfall #111 同源）。

### 2.3 已排除项（对抗验证确认，防止未来重查）
- **无**任何 document/window 级 mousedown/pointerdown `preventDefault`、**无** `.blur()` 调用、Electron 主进程层干净（无 renderer 焦点操纵）——健康路由下不存在能系统性阻止原生聚焦的代码。
- composer textarea 非受控、无 key、无 disabled、流式开始/结束不重挂 composer 子树——React 竞态排除。
- 静态样式层无「透明 + pointer-events:auto」覆盖层直接压 composer；所有 inset:0 常驻层均 `pointer-events: none`。
- DOM 增长有界（消息窗口化 360-1200 条封顶；隐藏 tab 不挂载 ChatCard body，`src/components/PaneView.tsx:1052`）。

## 3. 救援层：现有 rescue 的确定性缺口（症状 S1-S3）

rescue 全链在 `src/components/ChatCard.tsx:560-730`（辅助函数）+ `1680-1828`（document 级 capture 监听）。静态安装无漏洞（凡渲染出的 textarea 必有 rescue），但运行期有以下已核实缺口：

### 3.1 保护区仅为 textarea 矩形
入口门槛 `isPointerInsideTextarea`（`ChatCard.tsx:1705,1721,1779`）。composer 的按钮群（发送/模型选择/设置）、**pane tab strip、卡头、消息区在 stale 路由下零保护**——症状 S4 里「点 tab 没反应」在现机制下既修不了也观测不到。

### 3.2 `misrouted-to-composer` 分支只修层、不补焦点、不重放（S1 直接原因）
`ChatCard.tsx:1795-1802`：只有 `misrouted-to-textarea` / 透明 blocker 分支补 `focus()`；`misrouted-to-composer` 只做 repair——**该次点击的语义（聚焦/按钮动作/caret 落点）必然丢失**，层重建只惠及下一次点击。全库无任何事件重放或按坐标设 caret 的代码。

### 3.3 1.5s 共享节流，失败也占窗口（次要放大器，已收窄）
`hitTestRepairThrottleMs=1500`（`ChatCard.tsx:636`），时间戳在动作前写入（`711-714`）、无有效性校验，hover 与 click 四个调用点共享（`1752/1761/1796/1813`）。一次无效 hover repair 会让随后 1.5s 内的层重建全部 no-op。注意：主导场景 `misrouted-to-textarea` 的 focus 补偿**不受**节流控制（有 Playwright 覆盖 `tests/card-title-editing.spec.ts:467-503`），所以节流只是把恢复推迟最多 1.5s，不造成「连点全部无效」。

### 3.4 忽略列表用不可信的 stale target 判定
`shouldIgnoreComposerFocusRescueTarget`（`ChatCard.tsx:568-585`）查询的是 stale 事件的 `event.target`。当误路由事件把 target 报成列表内长期存在的容器（如 `.git-agent-panel-shell`、任何打开中的 dialog）时，rescue 被**整体跳过**。正确做法是用 `elementFromPoint` 的布局真相判定「该点是否真的被菜单/对话框覆盖」。

### 3.5 修复目标错位 + 复合失败链（S3 的完整解释，已验证闭合）
- `repairStaleCardHitTest`（`ChatCard.tsx:701-728`）固定重建**受害卡自己的** `.card-shell`，而代码注释（`1734-1737`）自证 stale target 常是**别的子树**（另一卡 shell / tab panel）。重建范围严格窄于历史上真正清除 bug 的整 pane-tab-panel 卸载重挂，对异子树 offender 的疗效无任何证据。
- rescue 全程不 `stopPropagation`/`preventDefault`（有意设计），stale pointerdown 若点名某**非激活 pane tab 按钮**：`handleTabPointerDown`（`PaneView.tsx:637-651`）无坐标校验即调度 80ms 兜底激活（`PaneView.tsx:51,605-611`，测试钉死无需 pointerup）→ `activateTab` 切 tab → 受害卡被卸载（`PaneView.tsx:1052`）+ 新卡经 composerFocusRequest 抢焦点。**用户体感 = 「点输入框没聚焦，tab 还自己跳了」**。受害侧无任何手段取消这次幻影激活。

### 3.6 对 stale paint 系统性失明（条件命题已代码级证实）
所有 rescue 以主线程布局真相为坐标系（`getBoundingClientRect` 门槛 + `elementFromPoint` 分类）。若屏幕上画的是旧位置/旧尺寸的 composer（stale paint 变体），用户点向「看得见的幽灵」，坐标不在真实 rect 内 → `1721/1779` 门槛不过，**全部分支静默跳过**。tab 路径同理失明（事件按布局真相路由到别处，handler 根本不启动）。

### 3.7 retire 路径残余风险（gap，非现行主 bug）
- 恢复时写 `pointerEvents=''` 而非还原原 inline 值（`ChatCard.tsx:653`，当前无其它 inline 使用者，风险潜伏）。
- `healDisabledComposerAncestors` 删 map 条目不 `clearTimeout`（`667`），孤儿定时器可截断下一次 retire 的保护窗口（二阶竞态，良性）。
- 功能性透明面若真的盖住 textarea 点，会被「到期恢复→再 hover→再 retire」背靠背 2.5s 脉冲式失能。
- 不对称：pointerdown 的透明 blocker 分支（`1788,1799-1801`）不做 elementFromPoint 确认直接抢 focus（残余暴露仅限忽略列表外的透明点击目标）。
- 透明判定用字符串匹配（`backgroundColor.endsWith(', 0)')`，`597-624`），alpha 0.03 之类「近不可见但有绘制」的层会被误判为不透明真实面而落入静默分支（当前库内未找到此类实例，窄缺口）。

### 3.8 诊断盲区（为什么每次都说不清）
`'unrelated'` + heal 无命中的分支裸 return（`ChatCard.tsx:1809-1819`），全程零日志；`translateZ(0)` 两帧对真实 compositor staleness 的疗效**从未被验证**——所有 Playwright 测试用合成事件模拟误路由，验证的是分类/rescue 逻辑，不是层重建效果。`data-hit-test-repair-count` 已存在（`720-722`）但无人消费。

## 4. 聚焦链路层：点 tab / 新建 tab 不聚焦（S4）

### 4.1 点击「已激活 tab」永不聚焦（确定性，高价值）
`activateTab`（`PaneView.tsx:590-593`）对已激活 tab 早退，早退发生在 `requestComposerFocus`（`602`）之前；且左击 tab 按钮会**原生聚焦按钮本身**（`handleTabMouseDown` 只拦中键，`706-712`），把 composer 焦点抢走，无任何补偿。用户在 composer 已死时「点一下 tab 想找回焦点」的自然恢复手势被设计性吞掉。

### 4.2 聚焦通道是单发 rAF、无验证、无重试（自首日如此）
`ChatCard.tsx:1681-1693`：一次 `requestAnimationFrame` 后 `textareaRef.current?.focus()`——不带 `preventScroll`（与 `1800/1817` 不一致）、不校验 `document.activeElement`、不重试。生产窗口 `backgroundThrottling` 开启，长时运行的 Electron 渲染器确实会丢/节流 rAF（v0.17.5 修 tab 激活时已实证这类丢失，但只把「激活」改成同步，「聚焦」仍骑在 rAF 上）。另：commit 6c5221d 删除了全库唯一带 `activeElement` 校验 + setTimeout 重试队列的聚焦层（属于点击救援通道），自此全库不存在任何聚焦结果验证。

### 4.3 键盘路径完全绕过计数器
Ctrl+T 新建 / Ctrl+Tab 轮换直接 applyAction，不 bump `composerFocusRequest`——是否聚焦取决于该 pane 历史计数是否恰好 >0（emergent 行为）；PaneView 重挂载后计数器归零，新 pane 首次键盘操作必不聚焦。

### 4.4 4-12px 原生拖拽死区
tab 按钮 `draggable`，Chromium ~4px 即触发原生 dragstart（吞掉后续 click、且 `handleTabPointerMove` 的自家 12px 阈值管不到），dragstart 也会取消 80ms 兜底——**手滑 4-12px 的点击 = tab 不激活也不聚焦**。80ms 兜底（2ee129a）同时部分复活了 d6c699c 修掉的「慢速拖拽误聚焦」（按住 >80ms 才开始拖 → 拖拽启动前已激活+请求聚焦）。

### 4.5 其它已核实缺口
- `pointercancel` 主动取消兜底且无重试（`PaneView.tsx:668-677`）——Electron 合成 pointercancel（pitfall #132 同类）时点击彻底静默。
- 聚焦 effect 无 `isActive` 依赖：今天不可达（inactive 聊天卡不渲染），但任何扩大 `keepInactiveRuntime` 的改动都会让它变成「后台卡抢焦点」地雷；且计数 >0 时**任何**新挂载卡都会被自动聚焦（emergent，非设计）。
- `'+'` 按钮直到 ff103f0 (v0.17.2) 才请求聚焦；tab 激活 80ms 兜底直到 2ee129a (v0.17.5)——用户长期形成的「不聚焦」印象部分来自旧版本已修的问题。

## 5. 为什么「修了很多次都没修好、还容易改出新问题」

1. **修错层**：6 代机制、8 次改版全部在救援/聚焦层打补丁，第一层老化诱因（idle 动画、隔离合成上下文）从未动过。
2. **疗效不可验证**：translateZ(0) 对真实 compositor bug 的效果无法在 CI 复现（合成事件测不到层重建），每代修复「看起来对」，上线才知道。
3. **无行为回归网**：`tests/pane-tab-activation.test.ts` 是**源码正则断言**而非行为测试，状态机取消路径、pointercancel、聚焦结果全部无覆盖——所以 2ee129a 能悄悄复活 d6c699c 修掉的问题。
4. **救援本身带武器**：往 DOM 写 inline `pointer-events:none` 的 retire 路径历史上真的杀过邻卡（692f442 引入、在野一周、3a15948 修正 = pitfall #129A）。现版已加 elementFromPoint 确认 + 2.5s 自恢复，但 §3.7 的残余竞态仍在。
5. **已被推翻的历史假设**（防重蹈）：「去掉 contain:paint 能根治」「重试梯队能保证聚焦」「永久禁用透明 blocker 是安全的」「header 控件应豁免 rescue」「lastFocusedCardId 门控可靠」。

## 6. 修复建议（分级）

> **实施状态（2026-07-02）**：第一层 F1-F6 已全部实施并合并（分支 `worktree-fix-composer-focus-tier1`），红→绿 TDD：`tests/composer-focus.test.ts`（新增，12 项：6 项重试 driver 行为测试 + 6 项布线断言）+ `tests/pane-tab-activation.test.ts`（新增 2 项）。核心新模块：`src/components/composer-focus.ts`（`startComposerFocusAttempt` 验证+有界重试 driver、`shouldSkipComposerRescueForIgnoredSurface` 布局真相判定、`chill-vibe:composer-focus-request` 跨树聚焦事件）。
>
> **第二层 F7-F9 已实施（2026-07-02 同日，分支 `worktree-fix-composer-focus-tier2`）**，触发动机：第一层上线后用户复现新形态——新建会话 tab 偶发无法关闭/无法聚焦、重症整 pane 锁死、点击任意处坏 tab 输入框 caret 闪现（§3.6 stale paint/帧冻结指纹，第一层不覆盖）。实施内容经 3 路对抗审查修正：F8 落地为 `src/components/pane-tab-rescue.ts`（document capture + 坐标/布局真相双确认，关闭判定用 elementFromPoint 布局真相而非几何——隐藏 X 的 pointer-events:none 使其不可命中，点非激活 tab 右缘正确判激活；救援动作先激活 pane；click/auxclick/close 路径补幻影坐标守卫，键盘 detail=0 豁免）；F9 落地为 repair scope 升级（`decideHitTestRepairScope`：1.5s 节流→5s 窗口内二次升级 `pane-tab-panel` 级 translateZ 重建；救援死路径与聚焦梯队耗尽强制升级且不被节流吞；耗尽后一轮无升级 followUp；vacant 判定扩展本 pane chrome 可重试）；F7 落地为呼吸动画 infinite→8 次 + 静态规则补 0% 帧样式（fill-mode none 播完 keyframes 失效，无静态样式光环会整体消失——对抗审查拦下）。测试：`tests/pane-tab-rescue.test.ts`（16 项）+ `tests/composer-focus.test.ts` 扩展（12 项）+ `tests/idle-animation-budget.test.ts`（2 项守护）；theme 视觉回归 136/136。F10 与第三层未实施。已知取舍：聚焦梯队耗尽腿在「DOM focus 成功但画面冻结」形态下不触发（focus settled 即停，对抗审查证实该形态 focus 必成功）——它只兜「textarea 真不可聚焦」的罕见形态，主力自愈是死路径/重复修复触发的 pane 级重建。

### 第一层：低风险确定性修复（每条独立、可红→绿 TDD、互不依赖）——已实施
| # | 修复 | 对应症状 | 位置 |
|---|------|---------|------|
| F1 | 点击已激活 tab 也触发 `requestComposerFocus`（移除聚焦早退），并抑制 tab 按钮左击的原生抢焦点（mousedown preventDefault 仅左键 + 手动聚焦 composer） | S4 + 给 S1-S3 一个**官方恢复手势** | `PaneView.tsx:590-604,706` |
| F2 | `misrouted-to-composer` 且点击坐标在 textarea rect 内时补 `focus({preventScroll:true})` | S1 | `ChatCard.tsx:1795-1802` |
| F3 | 聚焦通道加验证+有界重试：rAF focus 后校验 `document.activeElement`，未命中则 setTimeout 梯队重试 ≤3 次；统一 `preventScroll` | S4 | `ChatCard.tsx:1681-1693` |
| F4 | 键盘 Ctrl+T/Ctrl+Tab 路径 bump `composerFocusRequest` | S4 | App 键盘 handler |
| F5 | 忽略列表改用 `elementFromPoint` 布局真相判定（保留 target 判定作为快速通过路径） | S2 | `ChatCard.tsx:1775,1722` |
| F6 | 观测性：`'unrelated'` 死路径与 repair 触发补 dev 日志/计数（消费已有 `data-hit-test-repair-count`），让未来复发可归因 | 诊断 | `ChatCard.tsx:1809-1819` |

### 第二层：消减诱因（中风险，Tier 2 视觉回归验证）——F7-F9 已实施（见上方实施状态）
- F7 idle 呼吸动画限次/限时（如 N 个循环后停），或把动画从覆盖整卡的 `inset:0` 伪元素挪到卡头小元素——直接削减长时层激励。**已实施：8 次限次 + 静态基线样式。**
- F8 tab strip 增加同款误路由兜底：pane 级 pointerdown capture，坐标在某 tab rect 内但 target 不是它 → 直接激活该 tab。**已实施：`pane-tab-rescue.ts` + 幻影坐标守卫全家桶。**
- F9 repair 分级升级：同一坐标 1.5s 内二次 misroute → 升级为对 `pane-tab-panel` 级祖先做 contain/overflow 瞬时切换（模拟真 tab 切换的清层效果）。**已实施：translateZ 两帧变体 + 死路径/耗尽强制升级。**
- F10 修 §3.7 小项：heal 时 clearTimeout、retire 恢复还原原值、pointerdown 透明分支补 elementFromPoint 确认。**未实施。**

### 第三层：结构性（长期）
- 行为级测试补网（真 pointer 序列 + 聚焦断言替换源码正则断言）。
- composer 聚焦视觉指示（caret-color / 边框），让「聚焦成功但看不见」不再与「失败」混淆。
- 跟踪 Electron/Chromium 升级对合成器 bug 的修复。

## 7. 本次调查的元数据
- Workflow run: `wf_d6135504-89b`（19 subagents，545 tool uses）。
- 对抗验证：14 个根因候选全部核实为至少部分成立（0 个被完全反驳），其中「1.5s 节流导致连点全无效」「'unrelated' 死路径是根因」两条被显著收窄/降级，本文采用收窄后的表述。
