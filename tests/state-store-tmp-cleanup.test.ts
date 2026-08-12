import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, writeFile, rm, readdir, utimes } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// 症状：数据目录 2026-08-11 实测积压 100 个 state.tmp.*/sidecar .tmp 残留，共 556.8 MB，
// 最早可追到 2026-04-13，且体积全部卡在 512KB 的整数倍上（写到一半被强杀的特征）。
// 根因：atomicWriteFile 只在 catch 分支 unlink 临时文件，进程被外部强杀时根本走不到；
// 而全仓库没有任何一处在启动时回收这些孤儿。
// 不能按文件名时间戳判定：sidecar 的 `<file>.tmp` 名里没有时间戳，只有 mtime 是通用的。
describe('orphaned temp file cleanup', () => {
  let tmpDir: string

  const dayMs = 24 * 60 * 60 * 1000

  const writeAged = async (filePath: string, contents: string, ageMs: number) => {
    await writeFile(filePath, contents, 'utf8')
    const when = new Date(Date.now() - ageMs)
    await utimes(filePath, when, when)
  }

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `chill-vibe-tmp-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('reclaims stale temp files while sparing live data and in-flight writes', async () => {
    const { pruneOrphanedTempFiles } = await import('../server/state-store.ts')

    const historyDir = path.join(tmpDir, 'session-history')
    await mkdir(historyDir, { recursive: true })

    await writeAged(path.join(tmpDir, 'state.tmp.1776013290495'), 'x'.repeat(1024), 30 * dayMs)
    await writeAged(path.join(tmpDir, 'state.tmp.1776047675954'), 'x'.repeat(1024), 2 * dayMs)
    await writeAged(path.join(historyDir, 'abc.json.tmp'), 'x'.repeat(1024), 5 * dayMs)

    // 正在进行中的写入：必须留着，否则会打断一次正常保存。
    await writeAged(path.join(tmpDir, 'state.tmp.9999999999999'), 'x', 5 * 1000)
    // 真实数据：一个字节都不能碰。
    await writeAged(path.join(tmpDir, 'state.json'), '{"columns":[]}', 30 * dayMs)
    await writeAged(path.join(tmpDir, 'state.wal'), '{"columns":[]}', 30 * dayMs)
    await writeAged(path.join(historyDir, 'abc.json'), '{}', 30 * dayMs)

    const removed = await pruneOrphanedTempFiles(tmpDir)

    assert.equal(removed, 3)

    const rootEntries = (await readdir(tmpDir)).sort()
    assert.deepEqual(rootEntries, ['session-history', 'state.json', 'state.tmp.9999999999999', 'state.wal'])

    const historyEntries = (await readdir(historyDir)).sort()
    assert.deepEqual(historyEntries, ['abc.json'])
  })

  it('never throws when the data directory is missing', async () => {
    const { pruneOrphanedTempFiles } = await import('../server/state-store.ts')

    const missing = path.join(tmpDir, 'does-not-exist')
    assert.equal(await pruneOrphanedTempFiles(missing), 0)
  })

  // 光有回收函数不算修好：真实档案里那 556.8 MB 是靠启动时自动触发才收得回来的。
  it('reclaims orphans on the first state load without blocking startup', async () => {
    const { loadState } = await import('../server/state-store.ts')

    const orphan = path.join(tmpDir, 'state.tmp.1776013290495')
    await writeAged(orphan, 'x'.repeat(1024), 30 * dayMs)

    await loadState()

    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (!(await readdir(tmpDir)).includes('state.tmp.1776013290495')) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }

    assert.fail('the stale temp file was still there after loading state')
  })
})
