# 多窗口流式性能兜底 — 任务

## 2026-08-01 未闭合 Markdown 链接卡死

- [x] 保全两次自动恢复产生的 `main.log` 与 native minidump，确认不是 GPU 饱和或系统 OOM。
- [x] 红测复现未闭合长 Windows Markdown 链接触发同步超时。
- [x] 修正 minidump Windows x64 `CONTEXT` 偏移，并用 Electron 36.9.5 symbols 指认 V8 RegExp 链。
- [x] 用线性链接边界扫描替换嵌套量词正则，保留图片、平衡括号和 reference link 行为。
- [x] 运行定向测试与 `pnpm test:quality`；构建新的 Windows zip 与可直接运行目录。

## 计划阶段

- [x] 阅读 `AGENTS.md`、UI 原则、长聊天窗口、焦点丢失、流恢复和排队发送文档。
- [x] 根据 Git 回归时间线和真实六流现场建立安全边界。
- [x] 定义分阶段实施、停止线、回滚点和验证矩阵。

## 第一实施切片：只建立门禁，不改生产行为

- [x] 新增确定性的 6-stream 聊天压力 fixture。
- [x] 新增隐藏 Electron 聊天 responsiveness 测试，采集 unresponsive、心跳和交互延迟。
- [x] 在 v0.18.8 基线运行，确认测试能区分旧问题而不是无条件通过。
- [x] 将该测试接入独立的聊天性能命令，避免和现有 Git 性能测试混淆。

## 第二实施切片：封住当前尾部窗口的回归面

- [x] 为流消息重放补充 reducer 幂等测试，避免同 ID 消息重复进入状态和持久化文件。
- [x] 补齐 streaming append、状态更新、折叠/展开、显示更早活动和 key 稳定性测试。
- [x] 证明 UI 窗口不改变保存状态、Provider 请求、archive recall 和恢复数据。
- [x] 增加输入、中文文本、tab 切换、滚动和 Ask User 的针对性交互回归。
- [x] 运行阶段 0 压力门禁；当前连续两次 5 分钟运行达标，在此停止，不继续改调度器。

## 第三实施切片：可见光栅复发后的流式背压

- [x] 让 Electron 门禁启用离屏绘制并消费 paint 帧，复现软件合成停帧。
- [x] 为统一调度器编写失败测试，覆盖 delta/activity 合并、交错 item 和按列抽取。
- [x] 实现单 lane、按列切片调度，不使用 `startTransition`。
- [x] 首版多流刷新自适应为 80/200/500ms，列之间让出 50ms；E 类复发后最终调整为 80/400/800ms。
- [x] Windows 恢复默认硬件加速，并保留强制软件渲染回退环境变量。
- [x] 重跑持久化、Electron runtime 与离屏聊天压力门禁。

## 第四实施切片：仅按 profile 继续

> 本次发布明确不包含此条件切片：第三切片后的性能门禁已达停止线，只有后续 profile 再次证明 layout/paint 超标时才启动。

- [ ] 若 layout/paint 仍超标，定位具体结构化明细，不做猜测式全局优化。
- [ ] 每次只窗口化一种昂贵明细并单独验证。
- [ ] 不到最后不得引入整页 transcript 虚拟化。

## 资源取证补充：不牺牲并行能力

- [x] 撤销 ChatManager provider 并发上限和 FIFO 排队；十几个会话保持立即启动。
- [x] 保留 Electron 资源心跳，硬退出前记录系统剩余内存和 Electron 进程内存证据。
- [ ] 基于下一次客观证据继续定位 Chill Vibe 相比 VSCode Codex 的额外资源放大点，不用并发限制代替根因修复。

## 2026-07-19 交互优先补强

- [x] 读取当前运行包、状态和进程证据：5 张卡 streaming 时 renderer / GPU 在 10 秒采样中分别占用约 60% / 74% 单核。
- [x] 红测覆盖交互保护窗、连续输入最大延迟和保护窗过期后的立即 flush。
- [x] 普通流式提交避开输入、IME、pointer、click、wheel 的关键帧；强制 flush 语义保持不变。
- [x] 重跑 focused 测试、质量检查和 Electron 聊天性能门禁。

## 2026-07-19 晚间复发：transcript 观测器降频

- [x] 核对现场包、main.log、state 规模和进程资源：确认是 E 类 unresponsive，JS 栈为空、非 OOM。
- [x] 红测证明内容更新不应改变 transcript 结构签名，新增/重排条目必须改变签名。
- [x] 让 sticky/scroll/ResizeObserver effect 只在 transcript 结构变化时重建。
- [x] 重跑 focused 测试、质量检查和 Electron 聊天性能门禁。

## 2026-07-21 E 类复发：持续合成负载降档

- [x] 核对现场包、unresponsive 日志、空调用栈和资源曲线，排除旧包与系统 OOM。
- [x] 现场四流采样确认 renderer / GPU 各持续约 43% 单核。
- [x] 红测禁止流式卡片和流式 tab 使用无限 box-shadow 动画。
- [x] 红测把 2～3 流刷新窗口放宽到 400ms、4 流以上放宽到 800ms。
- [x] 重跑 focused 测试、quality、主题相关检查和 5 分钟 Electron 流式压力门禁。
- [x] 构建新的 Windows zip 与可直接运行目录。

## 2026-07-21 发送后短时卡顿：持久化压缩去重

- [x] 红测证明连续发送时，未变化的巨型历史工具消息不应重复生成压缩快照。
- [x] 使用弱引用缓存复用已压缩消息，并校验源 `structuredData` 防止原地变更返回旧数据。
- [x] 重跑 focused 测试、quality 和 Electron 聊天性能门禁。
- [x] 构建新的 Windows zip 与可直接运行目录。

## 发布门禁

- [x] 相关 focused Node 测试通过。
- [x] `pnpm test:quality` 的 ESLint 与生产 TypeScript 通过；测试 TypeScript 仅被未完成的深度历史搜索 WIP 阻断，已确认与本切片无关。
- [x] `pnpm test:perf` 与新的聊天 Electron 性能门禁通过。
- [x] 焦点、tab、滚动、Ask User、排队发送、恢复和持久化回归通过。
- [x] 双主题和窄视口检查通过。
- [x] 30 分钟隐藏窗口 soak：零 unresponsive、零数据不一致。
- [x] 打包到新时间戳目录，保留上一可运行包作为即时回滚。

## 2026-07-23 重度多 Agent / 十几个 Tab 补强

- [x] 将聊天 Electron 门禁扩展到 6 个 workspace column、每 pane 14 tab、12 条并发 Agent 流。
- [x] 红测证明后台普通聊天只有正文变化时不应让 `PaneView` 重绘。
- [x] 保留标题、Provider、模型、状态、未读、激活卡和 Git 保活卡的刷新语义。
- [x] 重跑 focused tests、quality、30 秒 Electron 重度聊天门禁：最大 heartbeat gap 180.2ms、最大 frame gap 199.9ms、输入 P95 73.7ms、切 tab P95 110.6ms，零 unresponsive / renderer gone。

## 2026-07-23 20 个运行 Agent 校正

- [x] 将门禁从 12 条并发流提升到 20 条，保持 6 个 workspace、每 pane 14 tab。
- [x] 让输入、中文文本插入和焦点采样发生在正在 streaming 的 Agent composer 上。
- [x] 每列至少一次通过真实右键发送交互加入延后发送队列，并验证 20 条现有流继续运行。
- [x] 反复切换同列的前台/后台运行 tab，验证隐藏期输出和切换反馈。
- [x] 重跑 focused tests、quality、30 秒 Electron 20 流门禁与 Windows 打包：最大 frame gap 201.1ms，输入/延后发送/切 tab P95 分别为 71.8/71.1/131.1ms，零 unresponsive / renderer gone。

## 2026-07-23 新建会话首次输入长尾

- [x] 20 流运行时重复 60 次真实鼠标新建 tab → composer 聚焦 → 中文首次输入 → 切回运行 tab → 切回新 tab核对草稿 → 清理 tab。
- [x] 用合成历史把状态扩到至少 4MB，覆盖长期状态下的新建与保存成本。
- [x] 记录 ready/input p95、max 和焦点失败，ready/input max 均以 `< 500ms` 判定。
- [x] 核对 60 个新 tab 的唯一草稿在切走切回后完整，并保持每次采样从 84-tab 基线开始。
- [x] 先运行旧实现取证；旧实现 ready p95/max 707.5/802.3ms、frame max 900.0ms，确认真实失败。
- [x] 超长流式助手正文超过 16,000 字符后暂用完整纯文本，流结束后恢复 Markdown，避免每个 delta 重解析整段长文本。
- [x] 修复后 5 分钟 20 流门禁完成 60/60 次新建会话探针：ready p95/max 113.7/179.2ms、首次输入 p95/max 25.4/38.4ms，零焦点失败、零草稿丢失、零 unresponsive / renderer gone；Windows ZIP 位于 `dist/release-20260723-201809/`。

## 2026-07-23 长时运行状态动画复发

- [x] 核对 `release-20260723-223152`：23:32 与 23:36 两次 unresponsive，JS 栈为空且资源数据不支持 OOM。
- [x] 为长期运行的 streaming、command-running 和 busy 点增加失败测试，禁止无限动画。
- [x] 将隐藏 pane 与通用 busy 状态点改为静态透明度层级；根据现场反馈恢复当前可见 pane 的流式与命令三点动效，不改 Provider 并发和状态语义。
- [x] 运行定向测试、quality 与 light/dark 主题验证；相关 streaming tab / Codex 状态面板双主题快照通过，完整主题套件另有 11 个既有脏分支快照差异。
- [x] 运行真实可绘制 Electron 多流长时门禁，确认零 unresponsive / renderer gone；30 秒复核门禁完成 20 流与 60/60 新建会话探针，frame max 228.7ms，ready/input max 73.3/24.8ms。
- [x] 构建并交付新的 Windows ZIP 与可直接运行目录：`dist/release-20260724-003914/Chill Vibe-0.18.17-win.zip` 与 `dist/release-20260724-003914/win-unpacked/Chill Vibe.exe`。

## 2026-07-25 持续无响应自动恢复

- [x] 核对现场日志：22:48:38 明确进入 E 类 `BrowserWindow unresponsive`，调用栈为空、内存充足，用户随后人工关闭；现场包为 `release-20260725-014058`，不是旧取证包。
- [x] 红测覆盖无响应武装、恢复取消、销毁取消、禁用配置和只触发一次恢复。
- [x] 实现 renderer 自动重新加载兜底，并保留主进程/后端/Provider 进程。
- [x] 运行 focused tests、quality、Electron runtime/聊天性能门禁，并构建新的 Windows ZIP 与可直接运行目录：`dist/release-20260725-230759/Chill Vibe-0.18.17-win.zip`、`dist/release-20260725-230759/win-unpacked/Chill Vibe.exe`。

## 2026-07-26 自动恢复假绿修正

- [x] 现场确认自动恢复连续四次触发，但 renderer PID 始终为 `45156`，普通 reload 没有重新加载页面，用户仍只能关闭应用。
- [x] 红测要求持续无响应恢复必须调用 `forcefullyCrashRenderer()`，并只在 `render-process-gone` 后 reload。
- [x] 实现强制替换 renderer 进程，保留 main/backend/ChatManager/Provider CLI。
- [x] 新增真实 Electron 运行时测试，主动触发 unresponsive，证明 renderer PID 变化且 UI/desktop bridge 恢复。
- [x] 定向 Electron/Node 测试与 `tsconfig.node` 通过；30 秒 20-stream / 84-tab 聊天压力门禁零 unresponsive、frame max 266.7ms。全量 `test:quality` 仅被并行的 all-agents-done-sound WIP 测试字段名不一致阻断。
- [x] 构建新的 Windows ZIP 与可直接运行目录：`dist/release-20260726-192017/Chill Vibe-0.18.18-win.zip`、`dist/release-20260726-192017/win-unpacked/Chill Vibe.exe`。
