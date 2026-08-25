# State Crash Recovery Hardening — Design

全部改动集中在 `server/state-store.ts`。不新增模块，不改 schema，不触碰渲染层。

## 1. 统一恢复候选池

现状：

```ts
const recoverFromBackups = async (dataDir) => {
  const backups = files.filter((f) => f.startsWith('state.backup-') && f.endsWith('.json'))
    .sort().reverse()
  // ...
}
```

改为 `recoverFromDiskCandidates`，候选来源合并两类文件：

- `state.backup-*.json`
- `state.snapshot-*.json`

排序不能再依赖文件名字典序跨两种前缀比较（`backup-` 与 `snapshot-` 前缀不同，`sort()` 会先按前缀分堆，导致较旧的 backup 排在较新的 snapshot 之前）。改为解析文件名中的 ISO 时间戳后按时间倒序；时间戳解析失败的条目排到末尾，仍然参与尝试。

逐个候选：`readFile` → `JSON.parse` → `appStateSchema.safeParse` → 通过则 `sanitizeState` 返回。全部失败返回 `null`。

保留原函数名作为薄封装，避免调用点散弹式修改。

## 2. 冻结快照轮转

新增模块级 `degradedStartupDirs: Set<string>`。

- 进入任何降级路径（走候选恢复、或落回 `createDefaultState`）时 `degradedStartupDirs.add(dataDir)`。
- `pruneStateSnapshots(dataDir)` 开头检查：若该 dataDir 处于降级态，直接返回，不删除任何快照。
- 解除条件：`saveStateToDataDir` 成功写出一次**非空**状态（`state.columns.length > 0`）后 `delete`。

这样既保住了崩溃前的快照，又不会让冻结永久化——用户一旦恢复正常使用，轮转自动回到 8 份上限。

写快照本身不冻结：新快照仍要写，只是不删旧的。短暂超出 8 份上限是可接受代价，远小于丢失全部历史。

## 3. 备份前校验

`backupStateFile` 读取源文件内容后判断：

```ts
const looksParseable = (content: string) => {
  if (content.trim().length === 0) return false
  try { JSON.parse(content); return true } catch { return false }
}
```

- 可解析 → 落 `state.backup-<ts>.json`（不变）。
- 不可解析 → 落 `state.corrupt-<ts>.json`。

全 NUL 内容 `trim()` 后长度不为 0（NUL 不是 JS 的空白字符），因此必须靠 `JSON.parse` 兜住；两条判据都保留。

取证价值不丢失，但 `state.corrupt-*` 不在候选池的匹配范围内，不会再污染恢复。

## 4. 补 fsync

`atomicWriteFile` 改为用 `FileHandle` 显式落盘：

```ts
const writeFileSynced = async (target: string, content: string) => {
  const handle = await open(target, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
```

顺序调整为：

1. `writeFileSynced(wal, content)` — WAL 落盘，此时崩溃可从 WAL 恢复。
2. `writeFileSynced(tmp, content)` — 临时文件落盘。
3. `rename(tmp, filePath)` — 原子替换。
4. `syncPath(filePath)` — 重开目标文件 `sync()`，确保 rename 后的内容可见于物理介质。
5. `removeWal()` — 只有到这一步才允许丢弃 WAL。

Windows 上 `fsync` 目录不被支持（`open(dir)` 会 EISDIR/EPERM），因此第 4 步同步的是目标文件而非目录。这在 NTFS 上足以保证文件数据落盘；目录项的持久化由 NTFS 自身的元数据日志保证。

`syncPath` 的失败不能吞掉——它必须冒泡进既有的 `maxRetries` 重试循环，否则"补了 fsync"只是装饰。

### 为什么不能只加一次 fsync

只在 rename 后同步目标文件，无法覆盖"WAL 已删、tmp 数据未落盘"的窗口。本次事故正是死在这个窗口：WAL 的删除是元数据操作、先行落盘，而 4.7 MB 的数据页还在 page cache 里。必须让 WAL 的生命周期严格长于数据落盘。

## Decision comments

按 AGENTS.md「注释即 ADR」，以下三处必须留 3 行注释（症状 / 根因带日期实测数字 / 被否决方案）：

- `pruneStateSnapshots` 的冻结分支 —— 否决"直接调大 retainedStateSnapshotCount"：治标，写入频率一高照样挤光。
- `backupStateFile` 的校验分支 —— 否决"只判空文件"：全 NUL 文件长度 4.7 MB 非空，判空判不出来。
- `atomicWriteFile` 的 fsync 顺序 —— 否决"只在最后 fsync 一次"：见上节。

## Test plan

`tests/state-store-crash-recovery.test.ts`（新增），四组，全部 `CHILL_VIBE_DATA_DIR` 隔离：

1. 写一份全 NUL 的 `state.json` + 一份内容完好的 `state.snapshot-*` → `loadState()` 必须返回快照里的看板，而非默认空板。
2. 降级启动后调用快照写入 → 既有快照数量不得减少（即便超过 8 份）。
3. 对全 NUL 的 `state.json` 触发备份 → 目录中必须出现 `state.corrupt-*` 且不得出现 `state.backup-*`。
4. 替身 `FileHandle.sync` 计数 → 一次 `saveState` 必须至少同步 WAL、tmp、目标文件三次，且 WAL 的删除发生在最后一次 sync 之后。
