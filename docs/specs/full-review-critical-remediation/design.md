# Design — Full Review Critical Remediation

## Slice A — Lossless history before compaction

保存入口先从原始输入中提取可证明完整的历史正文，写入 sidecar 后再执行 renderer/state 裁剪。旧版迁移在预裁剪前记录完整 entry 或原始消息总数；不得从裁后的数组推断总数。sidecar 写入改为 `tmp -> rename`。

## Slice B — Monotonic state writes

给所有状态写请求分配单调 generation。queued save 只允许写入仍是最新 generation 的 payload。显式保存先提升 generation 并清除/取代旧 pending payload；reset 使用显式覆盖模式绕过普通空状态保护。普通自动保存仍保留防止异常空状态覆盖的 guard。

## Slice C — Stop and child startup

`ChatManager.startProvider` 在每个长 await 后及 child 返回时检查 stream 的 `stopRequested/terminal`。迟到 child 立即 kill/release，且不挂载到 terminal stream。测试用 deferred provider launch 精确覆盖 stop-before-child-assignment。

## Slice D — Claude pool identity and stale callbacks

keepalive signature 使用稳定序列化后的完整进程身份，包括经过排序/筛选的 runtime env、args 与附件授权目录。pool 的 turn attachment/end API 携带 entry identity 或 generation；旧 entry 的 close/settled 回调只有在 map 当前值仍是自身时才能影响当前 turn。相同 key 的并发 acquire 串行化。

## Slice E — Canonical filesystem boundary

对已有目标使用 `realpath`；对创建目标解析最近存在祖先的 realpath，再拼接尚不存在的尾部。workspace 和允许的 agent-home 根也 canonicalize。每次操作在实际访问前执行 canonical containment 检查，Windows 使用大小写不敏感比较。

## Slice F — Durable update exit

updater 不直接掌握 state store，而由 main 注入 `flushBeforeExit` 回调：先通知 renderer，再等待主进程 `desktopBackend.flushStateWrites()`，带总超时和日志，随后才 `app.exit(0)`。

## Verification strategy

- 严格红→绿：state-store、ChatManager、Claude pool、文件边界、updater。
- 故障注入：sidecar 写入失败、延迟 child close、旧 queued save 晚到、junction 指向外部目录。
- 合并前先跑每个测试文件，再跑 quality/unit/risk/build。
