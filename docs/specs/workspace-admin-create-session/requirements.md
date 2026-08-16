# 超管 MCP：新建会话（create_session）

## 背景

工作区超管 MCP（`chill_vibe_workspace`）目前只有 5 个工具：`list_sessions` / `read_session` /
`send_session_message` / `move_session_to_lane` / `set_session_wake_timer`。

这 5 个工具**全部作用于已经存在的会话**。一个被授予超管权限的会话如果需要「再开一个 agent 去干这件事」，
它无路可走 —— 2026-08-16 用户实测到的现场原话：

> **我没有"新建会话"的工具。** 工作区的 MCP 只给了我列出/读取/发消息/移泳道/挂唤醒五个，全部作用于**已存在**的会话
> ——而这个工作区现在一张卡都没有。
> 需要你在 Chill Vibe 界面里手动建一张卡、模型选 Sonnet，第一句话粘这个：`/game-iterate`

超管被迫把活退回给用户手动操作，这与「超管代替用户看住整个工作区」的产品意图直接冲突，
也是空工作区场景下超管完全失能的原因（一张卡都没有时，其余 5 个工具全部无对象可用）。

## 目标

给超管 MCP 增加第 6 个工具 `create_session`，让超管能在自己的工作区列里**新开一个会话并派活**，
不需要用户手动建卡。

## 用户故事

1. 作为超管会话，当工作区里没有任何会话时，我能自己建一张卡、指定 provider/模型、把需求发进去，
   立刻开始执行。
2. 作为超管会话，当我判断当前需求需要拆成并行的两条线时，我能再开一个会话承接第二条线，
   而不是把两件事塞进同一个 agent。
3. 作为超管会话，我能先把新会话建成「待命」状态（需求进草稿不发送），等条件满足后再用已有的
   `move_session_to_lane` 把它推进执行中道。

## 验收标准

### 工具契约

- AC1：`workspaceAdminMcpToolDefinitions` 暴露 **6** 个工具，新增的叫 `create_session`，
  输入 schema 同样是 `additionalProperties: false` 的封闭 schema。
- AC2：`create_session` 的必填参数只有 `requirement`（非空字符串）。
- AC3：可选参数为 `lane`（`standby` | `running`，默认 `running`）、`provider`（`codex` | `claude`）、
  `model`（字符串）。
- AC4：`lane` **不接受** `done`。新建即完成没有任何语义，传 `done` 必须报错而不是被静默纠正。
- AC5：缺 `requirement`、`requirement` 为空白、`lane`/`provider` 取值非法时，工具返回可执行的错误文本，
  且**不投递任何命令**。

### 命令契约

- AC6：`workspaceAdminCommandSchema` 新增 `admin-create-session`，字段为
  `columnId` / `requirement` / `lane` / `provider?` / `model?`。
- AC7：这条命令**没有 `cardId`**（卡还不存在），因此现有「cardId 必填」的前置校验不能套用到它头上。
- AC8：与其余写命令一致，`create_session` 返回的是「命令已投递」，不是「已生效」；
  文案必须引导模型再调一次 `list_sessions` 确认。

### 落位行为（渲染进程执行器）

- AC9：本列**有**自动化看板卡时，新会话建成该看板的**看板项**，落在请求的泳道。
  看板的选择沿用 `move_session_to_lane` 的既有规矩：由渲染端解析，取本列第一张看板卡。
- AC10：本列**没有**看板卡时，新会话建成**普通 tab 会话**，落在第一个 pane 里，
  而不是失败。（用户实测现场正是"一张卡都没有"，这条路径不通就等于没解决问题。）
- AC11：`lane: 'running'` = 建卡并**立刻把 requirement 作为第一条消息发出去**；
  `lane: 'standby'` = 建卡但**只把 requirement 放进草稿**，不发送。这两条语义在看板项与普通 tab 两条路径上一致。
- AC12：`provider` / `model` 省略时，继承所在列的默认值，与用户在界面上手动新建 tab 的继承规则一致。

### 权限边界

- AC13：`create_session` **不能**给新会话授予超管权限（`adminAccess`）。超管权限只能由用户在界面上授予，
  不能由一个超管会话传染给它创建的下一个会话。

### 系统提示

- AC14：`getWorkspaceAdminInstruction` 的中英文两份提示都要把工具数从「5 个」改成「6 个」并描述
  `create_session`，包括「本列没有看板时会建成普通 tab 会话」这条落位规则。

## 非目标

- 不做「删除/关闭会话」工具。销毁性操作的误伤代价远高于新建，需要单独的确认语义，不在本次范围。
- 不做「停止某个会话的流式输出」工具（手机监工的 `stop-stream` 对应物）。这是另一个独立缺口，
  单独立项，不与本次混做。
- 不支持指定 `reasoningEffort` / `thinkingEnabled` / `planMode`。这些可以在建卡后由用户调整，
  先不扩大模型可控面。
