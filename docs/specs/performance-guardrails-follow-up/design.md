# 性能门禁补强与大 Diff 预览减负 — 设计

## 切片 A：发布聊天性能阶段

在 `scripts/run-release-verification.mjs` 的 production build 之后增加 `chat-perf` 阶段。
阶段调用专用 package script，以 30 秒时长运行现有 6-stream Electron 夹具，并传入 `-SkipBuild`，
直接复用上一阶段生成的 `dist/client` 与 `dist/electron`。

`scripts/run-electron-chat-performance.ps1` 增加 `-SkipBuild` 开关：

- 默认路径保持原行为，先 `pnpm build` 再启动压力测试；
- 仅发布流水线在已经完成 build 后跳过重复构建；
- 若构建产物缺失，测试本身会启动失败，发布阶段保持红色，不伪造成功。

阶段仍进入 exact-tree 指纹和断点续跑状态；代码树变化会让该阶段与其他阶段一起失效。

## 切片 B：收紧真实绘制停顿门槛

现有测试已经对 renderer heartbeat 使用 500ms 目标，但对离屏真实绘制只在 2000ms 时失败。
将 frame hard gate 收紧到 500ms，与需求和历史稳定样本（约 170～305ms）一致。

不添加未经校准的 CPU/内存失败阈值。资源数据继续作为诊断输出，避免不同机器造成假红。

## 切片 C：有界内联 Diff 预览

将 Diff 预览行选择抽成纯函数：

- 按现有规则跳过 diff 元数据和 hunk header；
- 保持原顺序与 added/removed/context 分类；
- 收集到 80 行后立即停止扫描，不为预览构造剩余行；
- 详情弹层继续使用原始完整 patch，不受预览上限影响。

`StructuredPreviewBlock` 在提供自定义预览内容时不需要预先生成另一份去元数据全文；Diff 卡直接使用原始
patch 作为变化标识，从而避免每次渲染额外执行一次完整 `split/filter/join`。

这项优化只减少默认聊天视图的字符串遍历和 DOM 数量，不改变源消息与详情内容。

## 切片 D：重度多 Agent / 多 Tab 真实性能门禁

把现有夹具提升为用户真实重度形态；2026-07-23 的 20 Agent 校正取代此前 12 流规模，作为后续发布门禁基线：

- 保留 6 个 workspace column，继续覆盖多窗口横向 board；
- 每个 pane 生成 14 个 tab，形成稳定的 tab 条溢出，总计 84 个 tab；
- 6 个 pane 按 `4/4/3/3/3/3` 分布运行 tab，总计 20 条并发 Agent 流；运行 tab 均匀放在 tab 条首部、中部和尾部；
- 每列保持一个运行 tab 激活，使输入、中文文本插入和焦点测量都发生在“Agent 正在回答”的 composer 上；其余 14 条流处于后台；
- 期间反复切到同列另一条后台运行流，断言隐藏期输出立即可见，再切回原运行流；
- 每列至少一次在当前 Agent 仍 streaming 时填写消息并通过发送按钮右键走 `mode: 'defer'` 的真实排队发送路径，等待队列反馈绘制完成，同时保证 20 条现有流未被停止；
- 继续检查 paint frame、崩溃、持久化顺序、重复消息和后台消息完整性。

所有 Provider 流量由 `tests/fixtures/fake-codex-chat-stress.cjs` 在本机生成。该进程只模拟 Codex app-server JSON-RPC 与流式事件，
不访问网络、不调用真实模型、不读取线上凭据，因此不会产生模型 Token 费用。测试仍经过应用真实的 Electron、Provider 路由、状态、渲染和持久化路径。

### 新建会话首次输入长尾

已有 20 流循环只操作已经挂载的运行 tab，不能代表重度面板下创建新卡时的 reducer、pane tab、composer mount、焦点重试和草稿持久化成本。
当前用户打包版 `data/state.json` 约 3MB，而原夹具序列化后仅约 0.46MB。夹具因此用确定性合成历史消息扩到至少 4MB，
只复刻状态体积与卡片数量，不读取真实消息；这些历史主要放在未激活 tab，专门放大新建/草稿/关闭触发的状态克隆和持久化成本。
在稳定 20 流交互之后追加 60 次轮转采样：

- 在 6 个 pane 间轮转点击真实 `.pane-add-tab`；
- 从点击开始计时，等待 tab 数增加、active panel composer 出现且 `document.activeElement` 为新 textarea；
- 立即通过 Playwright 键盘 `insertText` 输入含中文的唯一草稿，等待受控/非受控输入值和下一绘制帧可见；
- 记录 ready/input 的 p95、max 和焦点失败次数，而不是只看平均值；ready/input 的 max 都以 `< 500ms` 作为硬门禁；
- 每次输入后切回该列原运行 tab，再切回新 tab 并核对唯一草稿，证明输入走过真实状态；
- 核对后清空草稿并关闭新 tab，让下一次仍从 84-tab 基线开始，避免把“累积新增 60 个 tab”混入单次新建响应指标。

若旧实现未触发 500ms 红线，不据此盲改生产代码；先把门禁保留为长期偶现防线，并结合现场 dump/main.log 再决定修复热点。

实际 5 分钟旧实现红测为：ready p95 707.5ms、max 802.3ms，heartbeat max 656.9ms、frame max 900.0ms；60 次焦点和草稿往返均成功，排除了焦点链路与状态丢失。
长时流把末尾助手正文持续扩到数万字符，而 `MessageBubble` 对每个 delta 都重新执行完整 Markdown 规范化和解析，形成与新建点击竞争的长提交。
修复不裁剪正文：当且仅当末尾普通助手消息仍在 streaming 且达到 16,000 字符时，改用一个 `white-space: pre-wrap` 的纯文本节点；
流结束后同一完整正文重新走 Markdown。该单点开关可直接回滚，不触碰 reducer、Provider、持久化和调度参数。

这能同时覆盖“多个 Agent 窗口”和“一排十几个 tab”，而不是用单张超大卡代替真实工作形态。

## 切片 E：后台聊天更新隔离

`PaneView` 当前 memo 比较会把 pane 内任意 card 对象引用变化都视为必须重绘。后台流每次追加消息都会更换 card 引用，
即使该 tab 的标题、图标、流式状态和未读点完全没变，也会让整个 tab 条、全部稳定 panel wrapper 和激活卡容器重新协调。

比较器改为按实际渲染依赖判断：

- 激活 tab 继续比较完整 card 引用；
- 需要后台保活的 Git tab 继续比较完整 card 引用；
- 普通后台聊天 tab 只比较 tab chrome 会读取的 `title`、`provider`、`model`、`status`、`unread`；
- tab 增删/重排、激活项变化、恢复状态或排队摘要在激活卡上的变化仍按原逻辑刷新；
- 切换 tab 会改变 pane 引用，因此新激活卡总能读取 column 中最新的完整 card，不会展示旧消息。

该切片不改变 reducer、流式调度、消息内容、Provider 并发或持久化，只跳过后台正文变化造成的无效 React 协调。

## 回滚点

- 发布阶段是一条独立 `RELEASE_STAGES` 记录，可单独移除。
- `-SkipBuild` 只扩展脚本参数，默认行为不变。
- Diff 预览上限集中在一个常量和纯函数中，可单独恢复。
- 重度夹具参数集中在测试 fixture 常量中，可单独调回旧规模。
- `PaneView` 比较器是单点优化；若发现 tab chrome 漏刷新，可独立回滚而不触碰状态数据。

## 验证

1. 先增加源契约/纯函数测试并确认旧实现失败。
2. 先用 comparator 单测证明后台正文更新会错误触发 pane 刷新，再实施隔离。
3. 把 Electron 夹具提升到 84 tab / 20 stream，并先确认旧实现下的契约测试失败。
4. 增加 60 次真实鼠标新建会话与首次输入长尾门禁；若未复现生产长停顿，不在无证据时修改运行时代码。
5. 实现各个独立小切片后运行 focused tests。
6. 运行 `pnpm test:quality`、30 秒聊天 Electron 门禁和必要的窄回归。
7. 最终运行发布级验证；性能修复确认后执行 `pnpm electron:build`。
