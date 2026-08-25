# State Crash Recovery Hardening — Tasks

Tier 1 全程严格 red → green。2026-08-25 一次性跑出 5 红，逐 slice 转绿。

## Slice 1 — 快照纳入恢复候选（最高优先级）

- [x] 新增 `tests/state-store-crash-recovery.test.ts`
- [x] 跑出红：`loadState()` 返回默认空板（`workspacePath === ''`），快照从未被读
- [x] 跑出红：跨前缀排序实测让 08-24 的 backup 胜过 08-25 的 snapshot
- [x] `recoverFromBackups` 合并 backup + snapshot，按文件名 ISO 时间戳倒序
- [x] 转绿

## Slice 2 — 降级时冻结快照裁剪

- [x] 跑出红：**降级启动后一次保存即删 5 份快照（12 → 7）**
- [x] 加 `degradedStartupDirs`，`pruneStateSnapshots` 前置返回
- [x] 解除时机放在本次快照写完之后，且仅当保存的是非空状态
- [x] 留决策注释（否决「调大 retainedStateSnapshotCount」）
- [x] 转绿

## Slice 3 — 备份前校验

- [x] 跑出红：全 NUL 文件被存成 `state.backup-*`
- [x] `backupStateFile` 加 `looksParseable` 分流，不可解析者落 `state.corrupt-*`
- [x] 留决策注释（否决「只判空文件」：NUL 不是空白字符，trim 判空失效）
- [x] 转绿

## Slice 4 — atomicWriteFile 补 fsync

- [x] 跑出红：`atomicWriteFile` 未导出，且全程无 fsync
- [x] 引入 `writeFileSynced` / `syncExistingFile`，重排为 WAL → tmp → rename → sync → drop WAL
- [x] 留决策注释（否决「只在最后 fsync 一次」）
- [x] 转绿

## 收尾

- [x] 注册测试到 `tests/index.test.ts`（踩到 pitfall #3，否则全量 runner 根本不跑它）
- [x] 全量 `pnpm test`：2706 / 2706 通过
- [x] `pnpm test:quality`：lint + 四个 tsconfig 类型检查全过
- [x] `pnpm electron:build`：`dist/release-20260825-101739`，zip 154.37 MB，`app.asar` 193.28 MB
- [x] 产物抽检：三条修复特征字符串均在 asar 内
- [x] AGENTS.md Known Pitfalls 追加 #347 / #348

## 关联的用户数据恢复（不属于代码改动）

- [x] 在仓库外的一次性救援目录写 `restore-watcher.ps1`，等 Chill Vibe 退出后自动重建索引
- [x] 用 WMI `Win32_Process.Create` 启动（PID 7464，父进程 `WmiPrvSE.exe`），彻底脱离 Chill Vibe 进程树
- [x] 备好手动兜底入口 `restore-now.bat`
- [ ] **待用户关闭一次 Chill Vibe 后自动触发**，预期恢复 21 个工作区、471 条会话索引
- [ ] 活跃看板布局无法恢复（好快照已在事故中被轮转挤光），需用户手动重建

## 本次事故未被覆盖的残留风险

- 触发事故的 `0x139` KERNEL_SECURITY_CHECK_FAILURE 属内核层，不在本仓库范围；机器再崩仍会撕碎写入中的文件，只是这次有了 fsync + 快照恢复兜底。
