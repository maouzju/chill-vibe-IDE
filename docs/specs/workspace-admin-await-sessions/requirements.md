# 超管 MCP：等待会话结束（wake_me_when_sessions_finish）

## 背景

用户原话（2026-08-17）：

> 超管模式需要能够自行注册每个会话的结束事件，这样他就能在派发的子节点完成之后知道并继续监工。

超管（被授予 `adminAccess` 的会话）现在有 6 个 `chill_vibe_workspace` 工具，但**没有一个能让它自己停下来等**。
它的回合一结束，这个 agent 就彻底不动了 —— 除非用户手动再说一句话。于是超管只有两种坏选择：

1. **原地空转轮询**：反复 `list_sessions` 直到子会话完成。这会烧光上下文与配额，而且模型没有 sleep，
   轮询就是连续的 tool call。
2. **一次性派完就退场**：`create_session` 之后回合结束，子会话交付时没有任何人在看 —— 监工只监了开头。

现有的 `set_session_wake_timer` 看起来像是答案，其实不是：

- 它作用于**别人**（必须传 `cardId`，而超管自己被刻意排除在 `list_sessions` 之外，它连自己的 cardId 都拿不到）；
- 它的执行器（`src/App.tsx:5464`）只 patch 了 `wakeTimerActive` / `wakeTimerMode`，**既不入队也不 arm**，
  而 `flushReadyWakeTimers`（`src/App.tsx:3002`）对 `wakeTimerQueuedSends` 为空的卡直接 `continue` ——
  也就是说这条命令目前是个**空操作**：它只是让那张卡「之后用户发的消息会被延后」，而不会在未来唤起任何人。

产品上真正缺的那块是：**超管能把「等这几张卡跑完」注册成一个事件，事件到达时它自己被重新唤起。**

## 目标

给超管 MCP 增加第 7 个工具 `wake_me_when_sessions_finish`，让超管注册「等指定会话结束再叫醒我」，
并复用既有的计划唤醒（wake timer）链路实现，不新造一条完成事件总线。

## 用户故事

1. 作为超管，我 `create_session` 派出 3 个子会话之后，注册「等这 3 张卡都跑完叫我」，
   然后干净地结束本回合；3 张卡陆续交付后我被自动唤起，逐个 `read_session` 验收。
2. 作为超管，我只关心其中 1 张卡（另外 2 张是长期任务），我能只指定它的 cardId。
3. 作为超管，我在唤醒时能读到自己留给自己的一句话（例如「验收 A/B/C 三张卡，通过就 move 到 done」），
   而不是醒来后不知道自己在等什么。
4. 作为用户，我在界面上能看见超管卡处于「待唤醒」状态、在等几个会话，并且能手动「立即唤醒」或「取消」。

## 验收标准

### 工具契约

- AC1：`workspaceAdminMcpToolDefinitions` 暴露 **7** 个工具，新增的叫 `wake_me_when_sessions_finish`，
  输入 schema 同样是 `additionalProperties: false` 的封闭 schema。
- AC2：必填参数只有 `note`（非空字符串）—— 唤醒时作为一条消息发进超管**自己**的对话。
  这条消息必填的理由：唤醒链路刻意不注入任何系统文案（wake-timer SPEC 明令禁止），
  没有 `note` 就等于醒来时收到一条空消息，模型无从知道自己为什么醒。
- AC3：可选参数 `cardIds`（字符串数组）—— 省略表示「本工作区当前所有其它 agent 会话」。
- AC4：可选参数 `timeoutMinutes`（1 ~ 10080，默认 60）—— 兜底上限。
  **这不是可选的设计冗余**：被打断、报错、或从未开跑（standby 泳道）的目标卡**永远不会发出完成广播**
  （`scheduleStableWakeTimerCompletion` 只在正常 terminal 完成时被调用，`src/App.tsx:4995`），
  没有兜底就是一次永久挂起。
- AC5：`note` 缺失或全空白、`cardIds` 含空串、`timeoutMinutes` 越界时返回可执行的错误文本，
  且**不投递任何命令**。
- AC6：这条命令的目标是**调用者自己**，参数里没有 `cardId`。因此它必须在
  `resolveWorkspaceAdminCommandFromToolCall` 的公共 `cardId` 必填校验**之前**分流
  （与 `create_session` 同一个坑，AGENTS.md pitfall 294）。

### 命令契约

- AC7：`workspaceAdminCommandSchema` 新增 `admin-await-sessions`，字段为
  `columnId` / `cardId`（超管自己）/ `targetCardIds` / `note` / `timeoutMinutes`。
- AC8：`cardId` 取自 MCP 子进程的 `CHILL_VIBE_ADMIN_MCP_SELF_CARD_ID` 环境变量，**不接受模型传入**。
  超管不能代替别的会话注册等待 —— 那是 `set_session_wake_timer` 的地盘，语义混在一起会让
  「谁被唤醒」变得不可预测。
- AC9：与其余写命令一致，返回的是「命令已投递」而非「已生效」。

### 唤醒行为（渲染进程执行器）

- AC10：命令落到超管自己那张卡上，打开逐卡 wake timer、写入等待目标、把 `note` 入队为待唤醒消息。
- AC11：等待目标**不按当前忙闲过滤**。刚 `create_session` 出来的卡可能还没进入 `streaming`，
  按忙闲过滤会让等待列表当场为空 → 立刻自唤醒，这个工具就废了。
- AC12：目标卡正常完成时，由既有的完成广播（`buildWakeTimerTargetReleaseActions`，`src/App.tsx:2750`）
  把它从等待列表里移除；列表清空即唤醒。
- AC13：等待列表清空**或**超过 `timeoutMinutes`，两者任一满足即唤醒（且超管自己必须是 idle）。
- AC14：唤醒 = 把 `note` 作为一条普通用户消息发进超管自己的会话，走既有的
  `origin: 'wake-timer-release'` 路径，不追加任何系统文案。
- AC15：等待期间超管卡在界面上显示为「待唤醒」，用户可以「立即唤醒」/「取消」，
  与用户自己挂的计时器完全同一套 UI。批次结束后逐卡开关自动关回去
  （`wakeTimerAutoActivated`，AGENTS.md 已记录的 2026-08-16 回归）。

### 系统提示

- AC16：`getWorkspaceAdminInstruction` 中英文两份都要把工具数改成 7 并描述新工具，
  且必须写清「派完活就注册等待、然后结束本回合」这条用法 —— 否则模型仍会选择原地轮询。

## 非目标

- 不做「等待任意条件」（如等某个文件出现、等某条正则匹配）。本次只等**会话结束**这一个事件。
- 不把 `set_session_wake_timer` 的空操作语义一并重写。那是独立缺陷，本次只在文档与提示里
  把两个工具的边界讲清楚（一个是给别人挂延后发送，一个是把自己叫醒），修复单独立项。
- 不新增「等待任意一个完成（any）」语义。首版只做 all（全部完成才唤醒）+ 超时兜底。
