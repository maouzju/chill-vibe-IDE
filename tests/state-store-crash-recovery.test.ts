import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, writeFile, rm, readdir, open as realOpen } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { createDefaultState, getFirstPane } from '../shared/default-state.ts'

// 2026-08-25 事故复现用例。掉电把 state.json 写成 4,704,124 字节全 NUL，
// 而崩溃前 8 份完整的 state.snapshot-* 就躺在同一目录里从未被读取，
// 随后又在约 2 分钟内被空看板快照挤光。详见
// docs/specs/state-crash-recovery-hardening/requirements.md
describe('state-store crash recovery', () => {
  let tmpDir: string

  const snapshotName = (isoLike: string) => `state.snapshot-${isoLike}.json`
  const listSnapshots = async () =>
    (await readdir(tmpDir)).filter((f) => f.startsWith('state.snapshot-') && f.endsWith('.json'))

  const getFirstCard = (state: ReturnType<typeof createDefaultState>) => {
    const column = state.columns[0]
    const firstTabId = column ? getFirstPane(column.layout).tabs[0] : ''
    return firstTabId ? column?.cards[firstTabId] : undefined
  }

  const withMessages = (workspacePath: string) => {
    const state = createDefaultState(workspacePath)
    const card = getFirstCard(state)
    assert.ok(card)
    card.messages = [
      {
        id: 'crash-recovery-1',
        role: 'user' as const,
        content: 'survived the power loss',
        createdAt: new Date(Date.UTC(2026, 7, 25, 1, 0, 0)).toISOString(),
      },
    ]
    return state
  }

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `chill-vibe-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  // Slice 1 —— 恢复候选必须包含 state.snapshot-*
  it('recovers the board from a snapshot when state.json is all-NUL', async () => {
    const { loadState } = await import('../server/state-store.ts')

    const good = withMessages('D:/recovered-from-snapshot')
    await writeFile(
      path.join(tmpDir, snapshotName('2026-08-25T01-03-54-000Z')),
      `${JSON.stringify(good, null, 2)}\n`,
      'utf8',
    )

    // 掉电产物：长度由 NTFS 日志恢复，数据页从未落盘。
    await writeFile(path.join(tmpDir, 'state.json'), Buffer.alloc(4096, 0))

    const loaded = await loadState()

    assert.equal(
      loaded.columns[0]?.workspacePath,
      'D:/recovered-from-snapshot',
      'loadState fell back to a default board instead of reading the surviving snapshot',
    )
  })

  // Slice 1 —— 跨前缀排序：较新的 snapshot 必须优先于较旧的 backup
  it('prefers the newest candidate across backup and snapshot prefixes', async () => {
    const { loadState } = await import('../server/state-store.ts')

    const older = withMessages('D:/older-backup')
    const newer = withMessages('D:/newer-snapshot')

    await writeFile(
      path.join(tmpDir, 'state.backup-2026-08-24T00-00-00-000Z.json'),
      `${JSON.stringify(older, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      path.join(tmpDir, snapshotName('2026-08-25T01-03-54-000Z')),
      `${JSON.stringify(newer, null, 2)}\n`,
      'utf8',
    )
    await writeFile(path.join(tmpDir, 'state.json'), Buffer.alloc(4096, 0))

    const loaded = await loadState()

    assert.equal(
      loaded.columns[0]?.workspacePath,
      'D:/newer-snapshot',
      'candidate ordering ignored timestamps and picked the older backup',
    )
  })

  // Slice 2 —— 降级启动后不得裁剪既有快照
  it('does not prune pre-existing snapshots after a degraded startup', async () => {
    const { loadState, saveState } = await import('../server/state-store.ts')

    // 12 份无法恢复的快照：数量刻意超过 retainedStateSnapshotCount (8)。
    for (let i = 0; i < 12; i += 1) {
      await writeFile(
        path.join(tmpDir, snapshotName(`2026-08-25T00-${String(i).padStart(2, '0')}-00-000Z`)),
        'not valid json at all',
        'utf8',
      )
    }
    await writeFile(path.join(tmpDir, 'state.json'), Buffer.alloc(4096, 0))

    const loaded = await loadState()
    assert.equal(loaded.columns[0]?.workspacePath !== 'D:/never', true)

    const before = await listSnapshots()
    assert.equal(before.length, 12)

    await saveState(withMessages('D:/after-degraded-start'))

    const after = await listSnapshots()
    const survivors = after.filter((f) => before.includes(f))
    assert.equal(
      survivors.length,
      12,
      `degraded startup pruned ${12 - survivors.length} pre-existing snapshot(s) — this is exactly how the 2026-08-25 data loss became permanent`,
    )
  })

  // Slice 3 —— 不可解析的内容不得进入 state.backup-* 命名空间
  it('quarantines an unparseable state file as state.corrupt-* instead of state.backup-*', async () => {
    const { saveState } = await import('../server/state-store.ts')

    await writeFile(path.join(tmpDir, 'state.json'), Buffer.alloc(200_000, 0))

    // 空看板 + 体积远大于新内容 → 触发 saveStateToDataDir 的空状态保护分支。
    await saveState(createDefaultState('D:/quarantine'))

    const files = await readdir(tmpDir)
    const corrupt = files.filter((f) => f.startsWith('state.corrupt-'))
    const backups = files.filter((f) => f.startsWith('state.backup-'))

    assert.equal(corrupt.length > 0, true, 'the all-NUL file was not preserved for forensics')
    assert.equal(
      backups.length,
      0,
      'an all-NUL file was filed as a recovery backup, poisoning the candidate pool',
    )
  })

  // Slice 4 —— 落盘顺序：WAL 的生命周期必须严格长于数据落盘
  it('fsyncs the wal, the temp file and the target before dropping the wal', async () => {
    const stateStore = await import('../server/state-store.ts')
    const atomicWriteFile = (stateStore as unknown as {
      atomicWriteFile?: (
        filePath: string,
        content: string,
        dataDir: string,
        deps?: { open: typeof realOpen },
      ) => Promise<void>
    }).atomicWriteFile

    assert.equal(typeof atomicWriteFile, 'function', 'atomicWriteFile is not exported for testing')

    const walPath = path.join(tmpDir, 'state.wal')
    const targetPath = path.join(tmpDir, 'state.json')
    const synced: Array<{ file: string; walStillPresent: boolean }> = []

    const trackingOpen = (async (filePath: string, flags: string) => {
      const handle = await realOpen(filePath, flags)
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'sync') {
            return async () => {
              synced.push({
                file: path.basename(String(filePath)),
                walStillPresent: existsSync(walPath),
              })
              await target.sync()
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    }) as unknown as typeof realOpen

    await atomicWriteFile!(targetPath, '{"version":1}\n', tmpDir, { open: trackingOpen })

    const syncedNames = synced.map((entry) => entry.file)
    assert.equal(syncedNames.includes('state.wal'), true, 'the WAL was never fsynced')
    assert.equal(
      syncedNames.some((name) => name.startsWith('state.tmp.')),
      true,
      'the temp file was never fsynced — this is the window the 2026-08-25 power loss fell into',
    )
    assert.equal(syncedNames.includes('state.json'), true, 'the renamed target was never fsynced')

    const targetSync = synced.find((entry) => entry.file === 'state.json')
    assert.equal(
      targetSync?.walStillPresent,
      true,
      'the WAL was dropped before the target reached the platter',
    )
    assert.equal(existsSync(walPath), false, 'the WAL should be removed once the write is durable')
  })
})
