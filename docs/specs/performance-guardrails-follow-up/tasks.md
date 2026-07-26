# 性能门禁补强与大 Diff 预览减负 — 任务

## 规格

- [x] 阅读多窗性能、发布流水线、长聊天窗口化和仓库验证规则。
- [x] 冻结为三个独立可回滚切片，不修改 Provider、状态语义和流式调度。

## 红测

- [x] 发布阶段契约：`chat-perf` 位于 build 后，使用 30 秒且跳过重复 build。
- [x] 聊天压力门禁契约：真实绘制最大停顿上限为 500ms。
- [x] 大 Diff 预览：超过 80 行时只返回前 80 个可见预览行，小 Diff 保持完整。
- [x] 结构化编辑 SSR：大 patch 默认标记中不挂载尾部 Diff 行，源 patch 不变。
- [x] 重度夹具：6 个 workspace column、每 pane 14 tab、12 条并发 Agent 流，且首尾 tab 可反复切换。
- [x] Pane memo：后台普通聊天仅正文变化时不刷新 pane；tab chrome、激活卡与 Git 保活卡变化仍刷新。

## 实现

- [x] 扩展聊天性能 PowerShell runner 的 `-SkipBuild`。
- [x] 将聊天性能短门禁接入 release verifier。
- [x] 收紧 frame gap 门槛并同步性能文档参数。
- [x] 对结构化 Diff 内联预览做有界、提前停止的行选择。
- [x] 将 Electron 聊天夹具升级为 84 tab / 12 stream 的重度使用形态。
- [x] 隔离普通后台 Agent 消息更新造成的无效 `PaneView` 重绘。

## 验证

- [x] focused Node tests：20/20 通过。
- [x] `pnpm test:quality`。
- [x] 30 秒 `test:perf:chat:electron`：84 tab / 12 stream，最大 heartbeat gap 180.2ms、最大 frame gap 199.9ms、输入 P95 73.7ms、切 tab P95 110.6ms，零 unresponsive / renderer gone。
- [x] `pnpm test:risk` 对应门禁已完成：quality、171 个 Node 文件、Playwright smoke（36/36）和 Electron runtime（12/12）均通过；聚合命令首次受孤儿 Vite 占用 5173 的清理噪声影响，随后按相同组成门禁逐项复核为绿。
- 最终发布门禁不在功能切片中预先勾选；由 `release-pipeline` 对最终版本化精确树执行 `pnpm test:release`，并以仓库外的 verifier evidence 为准，避免“勾选后改变指纹、再验证旧树”。
- [x] `pnpm electron:build`：产物位于 `dist/release-20260723-152853/`，ZIP 与解压可执行文件均已核验。
- [x] 检查当前运行时：未发现开发 Electron 或 5173 监听；按规则未触碰用户正在使用的旧打包版。

## 2026-07-23 20 个运行 Agent 真实性校正

- [x] 将夹具契约先改为 6 个 workspace、84 tab、20 个同时 streaming 的 Agent，并确认旧 12 流实现出现 3 个预期红灯。
- [x] 按 `4/4/3/3/3/3` 分布生成运行 tab，每列保持一个运行 Agent 激活，其余 14 条流在后台。
- [x] 在 20 流运行期间测量中文输入、焦点、运行 tab 切换，并让每列至少一次真实走延后发送交互。
- [x] 断言测试只启动本地 fake Codex CLI，不使用真实 Provider 或模型 Token。
- [x] 重跑 focused tests（21/21）、`pnpm test:quality`、30 秒 20 流 Electron 门禁：输入 P95 71.8ms、焦点 P95 69.3ms、延后发送反馈 P95 71.1ms、运行 tab 切换 P95 131.1ms、最大 frame gap 201.1ms，零 unresponsive / renderer gone。
- [x] 重新执行 `pnpm electron:build`；产物位于 `dist/release-20260723-172549/`，ZIP 根目录与解压可执行文件均已核验。

## 2026-07-23 偶发新建会话首次输入卡顿

- [x] 增加契约红测：20 流运行时至少重复 60 次真实鼠标新建 tab、自动聚焦、中文首次输入、切走切回核对草稿和清理 tab。
- [x] 将合成状态从约 0.46MB 提升到至少 4MB，匹配当前打包版约 3MB 的长期状态量级且不读取真实内容。
- [x] 记录新建 ready/首次输入的 p95、max 和焦点失败次数；ready/input max 都以 `< 500ms` 判定，旧门禁缺少这些指标时测试必须失败。
- [x] 每次切回新 tab 核对唯一草稿，随后清空并关闭，让 60 次采样保持相同 84-tab 基线。
- [x] 先跑旧实现获取真实长尾；旧实现 ready p95/max 707.5/802.3ms、frame max 900.0ms，确认红线后才修改生产代码。
- [x] 超长流式助手正文在 16,000 字符后临时走完整纯文本渲染，完成后恢复 Markdown；不改状态、Provider 或持久化内容。
- [x] 重跑 focused tests（19/19）、`pnpm test:quality`、5 分钟 20 流新建会话 Electron 门禁：60/60 次新建均完成，ready p95/max 113.7/179.2ms，首次输入 p95/max 25.4/38.4ms，零焦点失败、零草稿丢失、零 unresponsive / renderer gone。
- [x] 重新执行 `pnpm electron:build`；产物位于 `dist/release-20260723-201809/`，ZIP 与解压可执行目录均已生成。保留长期门禁，结论限定为已修复本次可稳定复现的超长流式 Markdown 热点，不把所有历史偶发卡死一并宣告根除。
