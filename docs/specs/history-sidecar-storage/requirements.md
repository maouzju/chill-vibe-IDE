# Requirements — History sidecar storage

## Goal

历史会话不能再作为主 `state.json` 的大块正文反复保存、读取、IPC 传输。主状态只保留会话历史索引/预览；完整消息正文按需从独立归档文件读取。

## Requirements

1. 启动和普通保存路径必须只让主 `state.json` 携带轻量历史预览。
2. 完整历史消息必须持久化到 `session-history/` sidecar 文件，且恢复单个会话时按 entry id 读取对应正文。
3. 旧版 `state.json` 中已有的完整 `sessionHistory` 必须能无损迁移：第一次保存后写入 sidecar，同时主 `state.json` 变轻。
4. Renderer 只回传轻量 preview 时，不得覆盖或丢失 sidecar 里的完整正文。
5. 删除/恢复历史条目后，UI 中不再显示被移除条目；历史正文文件可以延迟清理，但不能重新污染主状态。深度搜索启用后必须用持久隐藏记录维持这一语义。
6. 对用户体验的要求：历史列表仍可显示标题、provider、时间、消息数量和少量预览；点击恢复时再读取完整正文。
7. 历史列表必须直接标明会话状态：正常归档显示 **已结束**，最后一条消息是手动停止/用户打断标记时显示 **中断**，避免用户恢复前无法判断该会话是否完整。
8. 首次归档和旧版迁移不得因主状态的消息数量保护而截断 sidecar；sidecar 替换必须原子完成，失败时保留上一份有效正文。
9. 用户触发的显式保存或重置必须淘汰更早的排队快照；显式重置不得被“防空覆盖”保护误拦截。

## Non-goals

- 原始 sidecar 切片不做全文搜索索引；后续按需深度搜索见 `docs/specs/deep-session-history-search/`。
- 本切片不改变 provider 网络请求逻辑，只做网络路径诊断。
