# Compacted History Scroll Recovery Requirements

## Goal

让已经发生过 Codex `/compact` 的聊天卡片，在活动卡片消息被持久化上限裁剪后，仍能通过向上滚动查看更早的原始记录。

## Acceptance criteria

- 当当前卡片存在已完成的 Codex 压缩边界且归档 sidecar 有更早消息时，用户继续向上滚动可以进入这些消息。
- 当压缩边界本身已被活动消息上限裁掉、但 `messageCount` 仍显示历史更长时，归档仍能被加载并展示。
- 归档消息按消息 ID 去重，并保持原始时间顺序；当前卡片仍保留的消息不能重复显示。
- 回填只改变 renderer 的临时显示窗口，不修改 reducer 中的卡片消息、持久化 state 或 provider session。
- 回填失败、归档不存在或旧版本没有归档时，现有卡片消息和现有压缩提示仍正常工作，不阻塞聊天。
- 回填后的长历史继续使用现有性能窗口和分批展开机制，不能一次性强制挂载全部大历史。
- 归档加载请求不因新消息流入或 React StrictMode 重跑而丢失；同一卡片生命周期不重复发起无界请求。
- 继续向上滚动时，新增的更早消息不会把用户已经看到的位置跳回底部。
- 当持久化计数证明 compact boundary 已被裁掉时，即使 sidecar 与 live tail 没有共享消息，也能恢复前缀；没有该证据时不得盲拼旧归档。
- 显式重置会话后清理同 cardId 的 compacted-history sidecar，旧会话不得串入下一次 `/compact`。
- light/dark 主题和窄视口不新增特殊滚动条或破坏 composer 可见性。

## Non-goals

- 不把完整归档重新写回 `state.json`。
- 不把回填的历史重新作为新 transcript seed 发送给 Codex/Claude。
- 不实现独立的归档浏览器或跨卡片搜索。
