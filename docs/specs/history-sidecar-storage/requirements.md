# Requirements — History sidecar storage

## Goal

历史会话不能再作为主 `state.json` 的大块正文反复保存、读取、IPC 传输。主状态只保留会话历史索引/预览；完整消息正文按需从独立归档文件读取。

## Requirements

1. 启动和普通保存路径必须只让主 `state.json` 携带轻量历史预览。
2. 完整历史消息必须持久化到 `session-history/` sidecar 文件，且恢复单个会话时按 entry id 读取对应正文。
3. 旧版 `state.json` 中已有的完整 `sessionHistory` 必须能无损迁移：第一次保存后写入 sidecar，同时主 `state.json` 变轻。
4. Renderer 只回传轻量 preview 时，不得覆盖或丢失 sidecar 里的完整正文。
5. 删除/恢复历史条目后，UI 中不再显示被移除条目；历史正文文件可以延迟清理，但不能重新污染主状态。
6. 对用户体验的要求：历史列表仍可显示标题、provider、时间、消息数量和少量预览；点击恢复时再读取完整正文。

## Non-goals

- 本切片不做全文搜索索引；历史搜索先基于标题、provider、model、workspace 和轻量预览。
- 本切片不改变 provider 网络请求逻辑，只做网络路径诊断。
