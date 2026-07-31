# Design: Archive Recall MCP

## Overview

归档召回分为两层：

1. **按卡片累计 sidecar**：状态保存前，从尚未被 500 条上限裁剪的原始卡片消息中提取最新压缩边界之前的内容，按消息 id 合并写入独立文件。
2. **单次运行临时快照**：Codex 开始运行时，把 sidecar 与 renderer 当前还能提供的压缩窗口合并，写入临时 JSON，并通过只读 MCP 暴露。

这样早期压缩内容不会为了保留召回能力而重新塞回 `state.json`，也不会因后续保存只剩最近 500 条而被覆盖。

## Storage

- 路径：`<dataDir>/compacted-card-history/<base64url(cardId)>.json`。
- 内容：卡片 id、更新时间、累计消息数组。
- 合并规则：以消息 id 去重；已有消息保持原顺序，新发现消息按当前转录顺序追加。
- 写入：`tmp -> rename` 原子替换。
- 只有真实 Codex 压缩边界之前的消息进入 sidecar；性能窗口隐藏不归档。

## Request Flow

- Renderer 继续通过 `buildArchiveRecallSnapshot()` 附带当前可见状态能推导出的压缩历史。
- Backend 使用 `cardId` 读取累计 sidecar，并与请求快照合并。
- 合并结果非空时才创建临时 MCP 快照并注入 Codex runtime。
- 临时快照在运行结束后清理；累计 sidecar 不随单次运行删除。
- sidecar 读取或写入失败时 fail-open：记录诊断，但不能阻止正常聊天。

## MCP Surface

- `search_compacted_history(query, limit?)`
- `read_compacted_history(itemId)`

工具保持只读、仅限当前卡片。图片只在显式 `read` 时以内联 MCP image block 返回，避免搜索结果膨胀。

## Boundaries

- 不改变 provider session 语义，也不自动触发 `/compact`。
- 不把性能折叠窗口误当成真实压缩归档。
- 不取消活动卡片 500 条持久化上限；完整早期压缩历史由 sidecar 承担。
- 已经被旧版本永久裁掉且从未写入 sidecar 的消息无法追溯恢复；修复保证升级后的新保存不再继续丢失。

## Verification

- 多次压缩的 renderer 快照包含第一轮压缩前的消息。
- 超过 500 条的活动卡片保存后，`state.json` 仍受限，但 sidecar 保留最早压缩消息。
- 重启语义下，请求不再携带最早消息时，Backend 仍能从 sidecar 构造 MCP 临时快照。
- 后续轻量保存不会缩短已有 sidecar。
- 运行 archive recall、state-store 定向测试与质量检查。
