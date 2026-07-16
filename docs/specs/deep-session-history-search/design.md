# Design — Deep session history search

## Current failure

- `sessionHistory` 每工作区最多保留 50 条，因此更早 sidecar 不会到 renderer。
- 每条 renderer preview 最多只有首 4 + 尾 4 条消息，因此会话中段正文也无法由前端过滤命中。

## Search path

1. 空查询继续使用现有 renderer 最近历史，保证菜单秒开。
2. 非空查询 debounce 后调用新的内部历史搜索 bridge。
3. 主进程按需加载或重建 `session-history/catalog.json`。目录只保存轻量摘要、sidecar 文件名和隐藏键，不保存消息正文。
4. 先用摘要字段匹配；仍未命中的当前工作区候选再以有界并发读取 sidecar，并只检查消息 `content`。
5. 返回最多 100 条轻量摘要及总命中数；renderer 与本地即时结果去重、倒序合并。

## Catalog lifecycle

- 首次搜索且目录缺失/文件数变化时，以有界并发扫描 sidecar，构建目录；普通启动不做这件事。
- 新归档写 sidecar 后，如果目录已经存在则增量 upsert。
- 恢复历史后，通过显式 bridge 记录隐藏 entry/session key。相同 provider session 再次归档时解除该 session key 的隐藏状态。
- 目录写入采用临时文件 + rename，失败时搜索可以回退到重新扫描。

## Safety and performance

- 搜索只扫描请求工作区的 sidecar；同一 session id 先保留最新副本，减少重复读取和重复结果。
- 文件读取使用固定并发，不 `Promise.all` 无上限打开数千文件。
- 重复查询使用小型 LRU 缓存；目录版本变化时清空缓存。
- 旧请求由 renderer request id 丢弃，避免快速输入时结果倒灌。
