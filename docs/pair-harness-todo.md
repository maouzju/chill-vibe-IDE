# Chill Vibe Pair Harness Todo

## 背景

Chill Vibe 现在已经有一些接近“结对编程”的基础：

- 默认板子里有 `development` 和 `review` 两列。
- 产品鼓励多 agent 并排工作。
- 现有 `Brainstorm` 更偏并行发散，而不是围绕同一改动做持续对抗式收敛。

当前缺的不是“再多一个聊天窗”，而是一个明确的 harness 机制：

- 一个 agent 负责推进实现。
- 一个 agent 负责持续挑刺、卡关、要证据。
- 用户能看见这种关系，而不是把 reviewer 藏在后台。

这份文档讨论的就是这个方向，可暂称：

- `Pair Mode`
- `Critic Mode`
- `Sparring Mode`
- 内部口语：`一打一喷`

## 要解决的问题

- 避免 agent 过快进入“看起来完成了”的假收敛。
- 把 review 从“可选人格”升级成“流程节点”。
- 让批评更结构化，减少空泛嘴炮。
- 让用户少做搬运工，不必手动把 plan、diff、失败日志反复转述给另一个 agent。
- 保持聊天为核心，而不是把产品做成传统 dashboard。

## 外部信号

截至 `2026-04-12`，这个方向已经有明显业界信号：

- Google Jules 已经公开过 `Critic Agent` 和 `Planning Critic`。
- OpenAI 在 harness engineering 文章里明确提到 self-review 和额外 agent review。
- Claude Code 文档里已有 `code-reviewer` 子代理模式。
- GitHub Copilot code review 已转向 agentic architecture。
- Cursor 的 `Bugbot` 也在把 reviewer 和修复流程串起来。

结论不是“大家都这么叫”，而是“实现 agent + reviewer/critic agent + 闭环修复”已经成为一条成熟方向。

## 产品原则

- 聊天优先：review 不应该把主界面变成表单系统。
- 证据优先：critic 必须指出缺什么证据，不只给情绪价值。
- 轻量默认：默认不把每次普通聊天都升级成三方辩论。
- 可见关系：用户应能看出谁是 driver，谁是 critic，谁在阻塞。
- 可切换强度：温和 review 和毒舌 review 应该是模式，不是 prompt 黑魔法。
- 可落地：先复用现有 board / review channel / chat card 结构。

## 方案脑暴

### 方案 A：并排双卡 Pair Mode

形态：

- 左边 `Driver`，右边 `Critic`。
- Driver 正常读代码、改代码、跑测试。
- Critic 不直接改代码，主要看 plan、diff、日志、测试结果。

优点：

- 最贴合 Chill Vibe 当前布局。
- 用户一眼能理解发生了什么。
- “一打一喷”的戏剧性和参与感最强。

风险：

- 两边如果都长篇输出，噪音会很高。
- 若没有固定触发点，critic 容易过度干扰执行。

适合：

- 作为第一版的可见产品形态。

### 方案 B：隐形副驾 Critic Gate

形态：

- 主卡仍然只有一个 agent。
- 在 `计划后`、`首个 patch 后`、`准备交付前` 自动调用 reviewer。
- reviewer 结果以内联卡片或状态条显示。

优点：

- 负担轻，不会破坏当前聊天流。
- 更适合默认开启。

风险：

- 产品感不够强，用户可能意识不到“review”真的存在。
- 容易退化成后台 lint，而不是结对体验。

适合：

- 作为默认模式，或给轻度用户用。

### 方案 C：回合制 Sparring Mode

形态：

- Driver 只能走一步。
- 每一步都要等 Critic 回应后才能继续。
- 更像“接力赛”，不是并行流。

优点：

- 审查力度最大。
- 特别适合高风险逻辑和复杂改动。

风险：

- 太慢。
- 对低风险任务会明显烦人。

适合：

- 高风险任务、修 bug、做架构变更时的强化模式。

### 方案 D：多喷法 Reviewer Matrix

形态：

- 不同 reviewer persona 专注不同维度：
- `代码质量`
- `测试充分性`
- `产品体验`
- `性能`
- `安全`

优点：

- reviewer 的批评更聚焦。
- 容易做成可切换的产品功能。

风险：

- 第一版如果维度太多，用户会选不过来。
- 需要比较清楚的 prompt contract。

适合：

- 在基础 pair 模式稳定后扩展。

### 方案 E：三角色 Author / Reviewer / Judge

形态：

- `Author` 负责实现。
- `Reviewer` 负责挑刺。
- `Judge` 决定是否放行。

优点：

- 流程清晰，适合正式任务和交付场景。
- 可以减少 reviewer 和 implementer 拉扯不清的问题。

风险：

- 角色过多，成本高。
- 很容易让产品变重。

适合：

- 后续企业化、任务编排化版本，不适合第一版。

## 推荐路线

推荐先做一个克制的 M1，而不是一开始就上多 agent 大辩论。

### 推荐的 M1 组合

- 前台形态：`并排双卡 Pair Mode`
- 后台节奏：`Plan Gate + Patch Gate + Ship Gate`
- reviewer 结论：`pass / warn / block`
- reviewer 输出结构：
- `问题是什么`
- `为什么是风险`
- `缺什么证据`
- `建议下一步`

### 为什么先做这个

- 有产品辨识度，不只是后台自动审。
- 复用现有 review column 成本最低。
- 允许后续平滑退化成 `隐形 Critic Gate`。
- 能和当前 `Brainstorm` 明确区分：
- `Brainstorm` 是并行发散。
- `Pair Harness` 是围绕同一改动的对抗式收敛。

## MVP 定义

### M1：看得见的 Pair Harness

用户可以：

- 一键把当前 chat 卡升级成 pair 模式。
- 自动生成一个绑定的 critic 卡。
- 在关键节点触发 review，而不是每条消息都乱喷。
- 看到 reviewer 给出的 `pass / warn / block`。
- 一键把 reviewer 的阻塞意见喂回 driver 继续修。

M1 不做：

- 不做三角色裁判系统。
- 不做多个 reviewer 并行投票。
- 不做复杂的组织级权限和审核流。
- 不把所有普通聊天默认都变成 pair。

### M2：更强的 Critic 能力

- 支持 reviewer 风格切换：温和 / 严格 / 毒舌 / 安全红队。
- 支持 reviewer 专项模式：测试 / UX / 安全 / 性能。
- 支持从 diff、失败日志、截图里抽取证据进行批评。
- 支持“被 block 后必须补证据才能继续交付”。

### M3：更完整的 harness 编排

- 支持 `Planner -> Driver -> Critic` 三段式。
- 支持 `Reviewer` 直接生成可执行修复任务。
- 支持统计哪类 review 最有效，减少噪音 reviewer。

## 待办清单

### P0：产品定义

- [ ] 确定对外命名：`Pair Mode`、`Critic Mode`、`Sparring Mode` 三选一，保留内部别名 `一打一喷`
- [ ] 明确 M1 是否默认复用现有 review column
- [ ] 明确 pair 模式是卡级能力、列级能力，还是 workspace 级能力
- [ ] 明确 critic 是否允许直接改代码，M1 建议默认不允许
- [ ] 明确哪些任务默认推荐开启 pair mode
- [ ] 明确哪些任务不适合开启 pair mode，避免过度打扰

### P0：交互定义

- [ ] 设计“开启 Pair Mode”的入口位置
- [ ] 设计 pair 卡和普通 chat 卡的视觉区别
- [ ] 设计 driver / critic 关系的可见标识
- [ ] 设计 `pass / warn / block` 的展示方式
- [ ] 设计“把 review 意见回灌给 driver”的一键动作
- [ ] 设计 mode 退出和解绑方式

### P0：流程定义

- [ ] 明确触发节点：`plan`、`first patch`、`before handoff`
- [ ] 明确 reviewer 在每个节点能看到哪些上下文
- [ ] 明确 reviewer 输出格式，禁止空泛长文
- [ ] 明确 `block` 的含义，是硬阻塞还是建议阻塞
- [ ] 明确用户能否跳过 block，以及如何留下痕迹

### P1：数据与 schema

- [ ] 定义 pair session 的持久化结构
- [ ] 定义 driver card 和 critic card 的绑定关系
- [ ] 定义 review verdict 结构
- [ ] 定义 evidence / missing evidence 结构
- [ ] 定义 review 历史如何进入 session history
- [ ] 设计旧状态升级和 normalize 路径

### P1：orchestration / harness

- [ ] 在 harness 层增加 driver / critic 角色概念
- [ ] 增加 reviewer prompt contract，限制其输出结构
- [ ] 增加关键节点自动触发 review 的 baton 逻辑
- [ ] 增加把 diff、测试结果、计划摘要喂给 reviewer 的组装逻辑
- [ ] 增加 `block` 后回灌 driver 的标准 prompt 模板
- [ ] 增加 reviewer 超时、空输出、低质量输出的降级策略

### P1：UI 实现

- [ ] 在 board 中支持显式展示 pair 关系
- [ ] 支持从单卡快速生成 critic 卡
- [ ] 支持 review verdict 的状态徽标或浮层
- [ ] 支持查看“最近一次被 block 的原因”
- [ ] 支持把 review 结果浓缩成简短结构块，而不是巨长聊天
- [ ] 检查 light / dark theme 下的默认、hover、selected、disabled 状态

### P1：验证

- [ ] 为 reducer / schema / restore 路径补最小必要单测
- [ ] 为 pair mode UI 补最小视觉回归覆盖
- [ ] 验证 default、hover、focus、selected、empty、disabled 状态
- [ ] 验证桌面宽屏和窄视口
- [ ] 验证 review column 复用时不会破坏普通多卡工作流

### P2：高级模式

- [ ] 支持 reviewer 风格档位：温和 / 严格 / 毒舌
- [ ] 支持 reviewer 专项模式：测试 / UX / 安全 / 性能
- [ ] 支持高风险任务自动推荐进入 pair mode
- [ ] 支持从 reviewer 结论直接拆出 todo
- [ ] 支持统计 reviewer 命中率、噪音率、阻塞转修复率

## 需要优先回答的开放问题

- Pair mode 是默认开启更好，还是用户显式进入更好。
- Critic 是否必须和 driver 使用不同 provider / model。
- 如果 reviewer 也能改代码，是否会破坏“谁负责推进、谁负责挑刺”的边界。
- `block` 是否真的阻断 handoff，还是只在 UI 上强提示。
- 用户是否需要“毒舌”这种明确人格包装，还是只需要“严格 review”。
- 是否要把 reviewer 输出限制成结构块，而不是普通聊天消息。

## 一版产品文案方向

- `Pair Mode`: 让一个 agent 写，另一个 agent 专门盯风险和证据。
- `Critic Mode`: 在关键节点自动拉起 reviewer，避免假完成。
- `Sparring Mode`: 用对抗式协作把方案打磨到能交付。

## 当前建议

如果现在就要开始排期，建议顺序如下：

1. 先定名字和 M1 边界。
2. 再定 `pass / warn / block` 和 reviewer 输出 contract。
3. 再做 card 绑定和关键节点触发。
4. 最后补视觉表达和轻量指标。

先把“一个人干活，一个人挑刺，并且能闭环修复”做顺，再考虑多人投票、裁判、专项 reviewer 等更重的编排能力。
