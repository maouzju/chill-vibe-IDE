# Compacted History Scroll Recovery Design

## Data flow

1. ChatCard 检测到当前 Codex 卡片存在已完成的 compact boundary，或持久化的 `messageCount` 大于当前活动消息数时，按需请求同卡片的 `compacted-card-history` sidecar。
2. Electron bridge 直接调用 server 的定点读取函数；web server 使用对应的定点 HTTP 路由。读取结果为空或失败时 fail-open。
3. renderer 用纯函数把 sidecar 消息与当前卡片消息按 ID 合并。sidecar 中只保留当前卡片没有的前缀，当前卡片消息顺序优先保持不变；若双方零重叠，只有持久化 `messageCount` 明确大于 live tail 时才允许把 sidecar 作为已裁掉前缀接回。
4. 合并后的数组仅作为 `getCompactMessageWindow()` 的 renderer 输入；provider 请求、reducer state 和保存 payload 继续使用原始 `card.messages`。
5. 现有 banner、32 条 reveal batch 和 scroll-height anchor 继续负责向上展开。归档加载后若列表已经在用户操作中，保留当前滚动锚点，不重新钉到底部；加载请求只按卡片/provider 生命周期执行，消息流更新不会取消它。

## API boundary

- request 只包含 `cardId`，服务端按当前 data dir 定点读取，不枚举所有归档。
- response 复用 compact history snapshot 的消息形状；没有归档返回 `null`。
- 该接口不允许写入，不暴露任意文件路径。

## Safety

- 归档消息不会写入 AppState，避免重复 IPC、WAL 或 state.json 膨胀。
- sidecar 读取异常只记录诊断并回退到现有 UI。
- 归档回填仍受性能窗口约束；短会话不会因为单个大 payload 自动折叠。
- 会话重置先通过主状态的空写保护并完成原子落盘，再定点删除同 cardId sidecar；不能让一次损坏的空保存先删归档。
