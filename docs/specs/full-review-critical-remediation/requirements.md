# Requirements — Full Review Critical Remediation

## Goal

修复 2026-07-18 全量代码审查中已经用测试或独立脚本证实的关键故障，优先保证用户历史、当前状态、停止语义和 provider 进程隔离不会被静默破坏。

## Requirements

1. 首次归档超过主状态消息上限的会话时，必须在裁剪 renderer/state 预览前把完整正文写入 sidecar；恢复时仍能取回全部消息。
2. 旧版 `state.json` 中没有 `messageCount` / sidecar 的完整历史必须无损迁移；启动前的防 OOM 预裁剪不能改变原始总数或丢掉正文。
3. 任意显式高优先级保存（直接 save、reset、崩溃捕获、恢复选择）必须 supersede 更旧的 queued save；旧快照不得随后覆盖新状态。
4. 用户显式 reset 必须实际写入默认状态并在重启后保持；防止异常空状态覆盖的保护只适用于普通保存，不能伪装 reset 成功。
5. 用户在 provider child 尚未创建完成时停止任务，后续迟到的 child 必须立即终止，且不能继续发事件或修改工作区。
6. Claude keepalive 仅在完整进程身份一致时复用；身份必须覆盖路由环境、进程参数、workspace、model/effort/plan、附件授权目录和 session。
7. 被替换的 Claude 旧进程延迟关闭时，不得修改或结束同 card key 下的新 entry/turn。
8. 文件工具的 workspace 边界必须按真实文件系统路径执行；目录 symlink/junction 不得把读写、移动或删除带到 workspace/显式 agent-home 白名单之外。
9. 更新安装退出前必须有界等待 renderer flush 和主进程 pending state writes；超时可以继续更新，但必须记录失败。
10. sidecar 覆盖必须使用同目录临时文件加原子 rename，失败时旧正文仍可读取。
11. 每个高风险修复必须有先失败后通过的窄测试，并同步更新既有相关 SPEC。

## Non-goals

- 本 SPEC 不重做深度历史搜索功能；当前未完成的 WIP 搜索测试只作为独立发布门禁问题处理。
- 本 SPEC 不刷新全部视觉快照，也不改变 UI 样式。
- 本 SPEC 不重构完整 resilient proxy；下游 abort 传播作为后续独立切片。
- 本 SPEC 不解决大型 Git diff 的全部性能问题；该项保持独立性能修复任务。

## Acceptance

- 新增的窄测试全部通过，并在测试入口注册。
- `pnpm test:quality`、相关 unit/Electron 测试通过；若主分支既有 WIP 阻断全入口，必须先把该门禁恢复为可运行状态或明确隔离未完成测试。
- 合并后运行风险回归和 `pnpm electron:build`，提供 Windows zip 与可直接运行目录。
