# Claude 子代理进度 UI — Design

## 结论：只缺一个翻译层

Codex 侧的整条链路已经齐备，Claude 侧缺的只是「把 CLI 的 `system:task_*` 事件翻译成 `agents` 活动」这一层：

| 层 | Codex | Claude（本次） |
| --- | --- | --- |
| 事件源 | `thread/started`、`item/*` 等 JSON-RPC 通知 | `system:task_started` / `task_progress` / `task_updated` / `task_notification` |
| 翻译层 | `server/codex-agent-status.ts` | **新增** `server/claude-agent-status.ts` |
| 数据结构 | `streamAgentsActivitySchema`（`shared/schema.ts` 1439 行附近） | 复用，零改动 |
| 渲染 | `StructuredAgentsCard`（`src/components/StructuredBlocks.tsx` 480 行附近） | 复用，零改动 |

## 字段映射

以 2026-08-09 实测样本为准：

| CLI 字段 | `StreamAgentEntry` 字段 | 说明 |
| --- | --- | --- |
| `task_id` | `threadId` | 子代理稳定标识，同一 `task_id` 的后续事件都归并到同一条目 |
| `description`（`task_started`） | `nickname` | 例：`Count .ts files in server dir` |
| `subagent_type` | `role` | 例：`Explore`；渲染为 `名称 [角色]` |
| `description`（`task_progress`） | `activity[]` 一行 | 例：`Running List top-level .ts files by name` |
| `last_tool_name` | 拼进同一条 `activity` 行 | 例：`· PowerShell`；与 `description` 相同或是其 `: <label>` 结尾时省略（Workflow 的 description 已含 agent 名，见下方 2026-09-27 记录） |
| `usage.tool_uses` / `usage.duration_ms` | 拼进同一条 `activity` 行 | 例：`· 2 次工具 · 17.8s` |
| `patch.status`（`task_updated`） | `status` | `completed` / `failed` / `cancelled` 等映射到 `StreamAgentStatus` |
| `status`（`task_notification`） | `status` | 同上，作为终态兜底 |

状态映射：`completed → completed`、`failed`/`error` → `errored`、`cancelled`/`interrupted` → `interrupted`、其余未知终态 → `completed`；未见终态前为 `running`。

## 模块设计

`server/claude-agent-status.ts` 导出 `createClaudeAgentStatusTracker()`，与 Codex 版保持同构：

- `handleEvent(event)` → `{ handled, activity? }`；只在状态真正变化时返回 `activity` 快照，避免无谓重渲染。
- `snapshot()` → `StreamAgentsActivity`，`view: 'status'`，`agents` 仅含运行中的条目（与 Codex 的 `isRunningStatus` 过滤一致）。
- `hasRunningAgents()` → 供调用方判断是否仍有子代理在跑。
- 活动预览上限沿用 Codex 的 `maxPreviewItems` 量级，按 `task_id` 各自保留最近若干条；同一动作（去掉工具数/时长后的行首，再去掉 ` (throttle-retry)` / ` (retry N)` 重试后缀）只留最新一行并挪到末尾，心跳不再堆出只差计数器的副本，重派也不会和被放弃的首次尝试并排。事件带 `workflow_progress` 时按 `type:index` 合并进该条目自己的一张表（与 CLI 同一合并规则），只保留表里正在跑（`progress`，或带 `agentId`/`startedAt` 的 `start`）的 agent 对应的行；刚结束或刚入队的 agent 不加行。
- Workflow 条目的 `activity` 顺序固定为「心跳行… → 汇总行 → ⏳ 已运行」。汇总行以 `📋` 开头，只报计数，例：`📋 已完成 3/4 · 在跑 1 · 失败 1 · 排队 2`（为 0 的计数省略）。不列名字：同日对抗审查按 `index.css` 在 Chromium 实测，列 3 个名字的汇总在 217~584px 的列里折成两行，而活动框限高 3 行、底部对齐，折行会把最新的心跳行挤出框；在跑的是谁由心跳行交代。收到过表后，心跳行的工具数与时长只取表里该 agent 自己的 `toolCalls` 与 `now − startedAt`（缺就省略该段），绝不退回心跳 `usage`：那是整个工作流的累计值，两种来源混用时同一行的工具数会倒退（探针回放实测 5 → 2）。从没收到过表（例如恢复出来的会话）时不出汇总行，行为与改动前一致。几个同名 agent 并行时（没给 label 时 CLI 取 prompt 前 60 字，模板化 prompt 会撞名），心跳只带 `${phaseTitle}: ${label}`、不带 index，认不出是谁发的：共用一行、行尾标 `×N`、不给计数，只剩一个同名在跑时计数恢复。条目进入终态就丢掉这张表——结束后没有路径再读它，而常驻进程的追踪器跨回合存活、从不淘汰条目。

`itemId` 取 `claude-agent-status`，保证整轮内是同一张卡片被就地更新，而不是每次进度都新开一张。

## 接线点

`server/providers.ts` 的 Claude stdout 折叠器中，紧邻既有 `system`/`init` 分支（2754 行附近）加入子代理分支：

```
if (event.type === 'system' && typeof event.subtype === 'string' && isClaudeAgentStatusEvent(event)) {
  const update = agentTracker.handleEvent(event)
  if (update.activity) sink.onActivity(...)
  return
}
```

要点：

- 必须放在 `parseClaudeStructuredOutput` 之前并直接 `return`，避免这些事件再落入通用活动路径。
- `init` 分支保持在最前，会话 ID 行为不变（NFR7）。
- 追踪器实例与折叠器同生命周期（每轮一个），轮次结束自然释放。

## 被否决的替代方案

- **解析 sidechain 行（`parent_tool_use_id` 非空的 assistant/user 事件）来推断进度**：实测一次简单派发只有 7 条 sidechain，且其语义是子代理的完整消息体，需要自建一套工具调用状态机；而 `system:task_progress` 已经是 CLI 归纳好的进度摘要，字段更稳、量更小。sidechain 留给后续的「子代理明细展开」需求。
- **新增独立的 `claude-agents` 活动种类**：会连带改 schema、i18n 与渲染层，且用户看到的是两套外观不一致的面板。复用 `agents` 更省且视觉统一。

## CLI 心跳节律（2026-08-09 实测，决定了静默兜底的必要性）

`task_progress` **不是定时心跳**，而是「子代理每完成一次工具调用」触发一次。实测一个子代理内部执行 `Start-Sleep -Seconds 100`：

```
 36.5s  task_started    Run sleep command and report output
 39.6s  task_progress   Running Sleep 100 seconds then print DONE   duration_ms=3100
        ← 整整 155 秒零事件 ←
195.1s  task_progress   Monitoring: Wait for ...                    duration_ms=158563
```

`usage.duration_ms` 是该子代理的**累计运行时长**（195.1 − 36.5 = 158.6s，与 158563ms 吻合）。

推论：面板忠实反映最后一次心跳是正确行为，但对用户而言与「卡死」无法区分。因此每个运行中的子代理额外挂一行本地推算的已运行时长，由宿主侧 15s 周期重发驱动。这一行必须排在 `activity` 末尾——渲染层对活动做 `slice(-3)` 尾切。

## 任务类型分流（2026-08-09 实测）

CLI 用同一套 `system:task_*` 上报后台 shell 命令：

| | `task_type` | `subagent_type` |
| --- | --- | --- |
| 子代理 | `local_agent` | 有（如 `Explore`） |
| 后台命令 | `local_bash` | 无 |

不分流会让一条普通后台命令在「正在运行的子智能体」面板里冒充成子代理。判定采用 `task_type.includes('agent')`，而非与 `local_agent` 全等——Agent 工具的远程隔离模式会带别的 agent 前缀，全等会漏掉整类远程子代理。终态事件（`task_updated` / `task_notification`）不带 `task_type`，靠 `task_id` 只对已登记的子代理生效，天然免疫。

## 风险

### 2026-09-08 修复切片设计

1. 追踪层认领 Workflow 的工具回执与原生任务 ID，保留最初启动时间；失败/终态按精确 ID 结算。
2. 新增进程级 Claude agent runtime，由 pool 的输出观察者驱动，生命周期等于 child，独立于短命 turn parser。
   parser 的原有本轮 tracker 保留给 single-shot；keepalive 启用外部追踪，避免双重登记。
3. pool 在过滤 sidechain 后将顶层行送观察者；观察者不消费/截断原行。移除、替换、关闭都 dispose。
   runtime 每 15 秒发轻量快照，后台启动回执/Stop 边界决定跨回合保留，真正终态才结算。
4. 复用桌面 unsolicited 推送传输，载荷新增可选 `agentStatus`（共享 Zod 校验）。有该字段时
   `streamId` 是稳定 runtime 标识，接收端只 upsert 状态卡，绝不 attach 聊天流。新 runtime 标识
   使旧进程迟到回调无法覆盖新实例；pool 用 expectedChild 拒绝旧实例发布。
5. 状态卡用 runtime 标识稳定寻址，跨回合只更新一张。旧版无可靠生命周期的运行记录在加载时
   标为 interrupted，保留原始时长作为历史记录，不用 Date.now 推测不存在的启动时间。
6. 无 CSS/布局改动；单测覆盖时间推进、终态先于结束、桥接载荷、前端仅更新消息、不改卡片运行状态。

### Workflow 计时旧快照（2026-09-08）

用户截图中的两条 Workflow 停在 `1分34秒` / `30秒`。只读对拍用户存档与正在运行的
`release-20260908-181439` 包确认：该包 `markFinished()` 在内部结束 synthetic 条目后，
只停定时器，没有把结束快照推给 UI；前端因此永久保留最后一次 `running` 和耗时。
当前工作区已有结束快照推送，本次补测试验证，不重复改写并行工作中的生产文件。

- 收尾必须先 `sink.onActivity(snapshot())` 再通知回合结束，计时期间继续按 15 秒刷新。
- 测试模拟 90 秒静默、结束及再过 60 秒：时长前进、末尾空快照先于 done、结束后零刷新。
- 将当前解析器复制为临时探针并仅移除该推送，测试失败；当前解析器通过。探针已清理。
- 首次诊断只证明回合级兜底收尾：现场第一条调用返回文件不存在，第二条返回后台启动。
  用户要求修复后，已按下面进程级切片补齐失败即时结算与跨回合后台计时。
- 已落盘旧快照不能恢复精确历史耗时；新版本启动将失去追踪的 Claude 运行记录标为中断，保留时长。

- CLI 未来调整 `system:task_*` 字段名会导致面板静默失效。缓解：解析器对缺字段静默降级（NFR3），并由回归测试锁住实测样本的字段形状。

## 渲染层回归：面板被工具分组循环吞掉（2026-08-12 修复）

后端链路全通、`state.json` 里能搜到 `agent-status:claude` 的 agents 消息，但用户完全看不到面板。

根因在 `src/components/chat-card-parsing.ts` 的 `buildRenderableMessages`：派发子代理**必然**先产生一张 `Task`/`Agent` 工具卡，紧随其后的 agents 状态卡因而落进工具分组循环；该循环只认 `command` / `tool` / `edits`，其余一律交给 `isEmptySkippableMessage` 判定——而所有结构化卡片的 `content` 恒为空（`app-helpers.ts` 的 `createStructuredActivityMessage` 写死 `content: ''`），于是能正常解析的 agents 卡被当成「解析失败的坏卡」静默丢弃。`todo` 卡同病。

修复：分组循环里先用各自的 parse 函数判定，遇到可解析的 agents / todo 卡就 `break`，交回外层已有的 `if (todo || agents)` 分支渲染成独立卡片。

被否决：把 `'agents'` 从 `isEmptySkippableMessage` 的 kind 名单里删掉——那会让真正 `structuredData` 缺失的坏卡渲染成空气泡。

守卫：`tests/chat-card-parsing.test.ts` 三条——工具卡后、两张工具卡之间、以及「无 structuredData 的坏 agents 卡仍应丢弃」。

## 沉底单窗口（2026-09-10）

数据层与后端追踪器不动，只改渲染路由：

| 层 | 改动 |
| --- | --- |
| `src/components/chat-card-parsing.ts` | `buildRenderableMessages` 跳过 `view === 'status'` 的 agents 卡；新增 `selectDockedAgentStatus(messages)`，回溯最新一张状态快照，仅当其中含 `running` / `pendingInit` 条目时返回该快照（只含运行中条目），否则返回 `null`。 |
| `src/components/ChatCard.tsx` | `ChatTranscript` 在 `.message-transcript-shell` 之后、`StreamingIndicator` 之前渲染 `.subagent-dock`，内部复用 `StructuredAgentsCard` 的 status 视图。 |
| `src/index.css` | `.subagent-dock`：`flex: 0 0 auto`、限高 + 内部滚动，亮暗主题共用既有 `--structured-card-*` 令牌。 |

被否决：
- **聚合所有历史快照里的运行中条目**——旧包遗留的 `workflow:` 幻影条目会永久复活（见 2026-09-08 记录），最新快照即真相。
- **保留内联卡片再叠加沉底面板**——用户明确要「仅一个窗口」，且内联空卡正是被误读成「识别不了」的来源。
- **只隐藏空卡、保留内联位置**——跑起来后仍被正文顶走，问题依旧。

守卫：`tests/chat-card-parsing.test.ts`（状态卡不进转录、`selectDockedAgentStatus` 取最新且过滤空态、toolCall 视图不受影响）、`tests/theme-check.spec.ts`（沉底面板亮暗快照、无运行中子代理时不渲染）。

### 后台 Agent 跨回合保留与 Stop 钩子编码（2026-09-10）

- 「后台启动回执」对 Workflow 是 `Workflow launched in background. Task ID: …`，对 Agent/Task 是 `Async agent launched successfully`；两者都必须登记为跨回合保留，根回合 `result` 只结算本回合的前台条目。此前只登记 Workflow，后台 Agent 在模型停止输出的瞬间被结算、沉底面板消失且不再恢复。
- Windows Stop 钩子读 stdin 必须走 `[Console]::OpenStandardInput()` 字节流按 UTF-8 解码；`[Console]::In` 在新起的 powershell.exe 里按系统 ANSI 代码页解码，含中文的快照会损坏成不可解析的 JSON，边界退化为 `unknown`。
- 边界为 `unknown` 时跨回合保留退回到追踪器自身的后台登记；两层各自独立，任一失效都不能让后台条目在回合末被结算。

### Workflow 进度行重复（2026-09-27）

用户截图的 Workflow 条目显示两行「Drafts: draft:concept (throttle-retry) · draft:concept (throttle-retry) · 149/150 tools · 65m23s」。对拍该工作流 journal：脚本只有一个 `draft:concept`，首次尝试被 CLI 判为限流后以 `(throttle-retry)` 标签重派，截图时刻只有它在跑。抠 claude 2.1.280 的发射点：Workflow 的 `task_progress` 里 `description = ${phaseTitle}: ${label}`、`last_tool_name = label`、`usage` 是整个工作流的累计值。于是同名出现两次是我们把 `last_tool_name` 又拼了一遍；两行近似副本是每次心跳都新增一行。修法见上方字段表与「活动预览」一条，守卫在 `tests/claude-agent-status.test.ts` 的 Workflow 进度用例。

同日对抗审查补出第二层：只按动作去重后，被放弃的首次尝试（`draft:concept`）和已跑完的上一阶段会一直钉在可见的第二行——改前的滚动列表两次心跳就能冲掉它们。CLI 重派时 index 不变、只改 label 加后缀；agent 结束只体现在 `workflow_progress`（按 `type:index` 合并的整张表，每次 start/done/error 批次必附带）里的 `state`。所以键去掉重试后缀，并按该表的活跃集合裁剪。没选"按心跳次数淘汰"：它分不清上一阶段已结束与并行 agent 正卡在一条长命令里。

同日第三层（用户第二张截图）：标题「四模块并行」，条目只有一行 `Wave1: A3:rig · 1074 tools · 118m`。对拍 toy-blade 的 journal，core / data+rpg / render 早已跑完，只剩 rig——面板没错，但从不交代"四个里完成了几个"，而 1074 tools / 118m 是整个工作流的累计值，读着像 rig 一个人的。`scripts/probe-claude-workflow-progress.mjs`（claude 2.1.280 实跑 3 个并行 agent，27 次心跳里 8 次附带表）证实：

- 表是按 `type:index` 合并的整张快照，结束的 agent 仍以 `done`（带 `durationMs`/`resultPreview`/`toolCalls`）留在表里；
- 排队的 agent 是 `state: 'start'` 但没有 `agentId`/`startedAt`；
- 开跑后每个 agent 带自己的 `toolCalls`，心跳 `usage.tool_uses` 是它们的总和；
- 两次附带之间最多 10 秒（`Xr=1e4` 节流），中间的心跳不带表。

于是追踪器按同一规则合并表，汇总行放在 ⏳ 之前；心跳行改用 agent 自己的计数。失去追踪的落盘快照（重启后 `retireUntrackedClaudeAgents` 收成 `interrupted`）只保留汇总第一段「已完成 x/y」，后面几段是生成那一刻的实时计数，留着会和中断状态自相矛盾。被否决：放宽渲染层 `slice(-3)`——桌面与手机监工页（`server/remote-monitor-page.ts`）都尾切 3 行，还要动 Tier 2 快照；每个 agent 各画一行——并行十几个时真正的心跳行会被挤出可见窗口。守卫在 `tests/claude-agent-status.test.ts` 的 summary / 同名 agent / 释放表用例与 `tests/claude-agent-push.test.ts` 的汇总收尾用例。

已知残留：限流重派（`throttle-retry`）时 CLI 先把首次尝试报成 `done`，睡 45 秒后才以同一 index 重新 `start`，`done` 条目不带任何"暂定"标记，这段时间汇总会显示全部完成、随后倒回。正常结束的 `stop` 不受影响（追踪器随即推送空快照覆盖），`src/state.ts` 里流被停止时的收尾仍原样保留汇总行。
