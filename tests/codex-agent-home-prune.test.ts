import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { pruneStaleCodexAgentHomes } from '../server/codex-agent-home-prune.ts'

const dayMs = 24 * 60 * 60 * 1000

const createRoot = async () => mkdtemp(path.join(tmpdir(), 'cv-agent-homes-'))

const createHome = async (root: string, name: string, ageDays: number) => {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  // 目录里放点内容，确保删除走的是递归路径而不是只对空目录有效。
  await writeFile(path.join(dir, 'marker.txt'), name, 'utf8')
  const stamp = new Date(Date.now() - ageDays * dayMs)
  await utimes(dir, stamp, stamp)
  return dir
}

const listNames = async (root: string) => (await readdir(root)).sort()

test('prunes codex agent homes that have been idle past the age limit', async () => {
  const root = await createRoot()
  try {
    await createHome(root, 'stale-a', 30)
    await createHome(root, 'stale-b', 8)
    await createHome(root, 'fresh', 1)

    const result = await pruneStaleCodexAgentHomes({ rootDir: root, nowMs: Date.now() })

    assert.equal(result.removed, 2)
    assert.deepEqual(await listNames(root), ['fresh'], '只应删掉超过保留期且闲置的隔离 HOME')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// 症状：正在运行的 Codex 子代理 HOME 被回收会让那一轮直接失败。
// 根因：回收只看 mtime，而一轮长任务期间该目录可能长时间不被写入。
// 为什么必须有 protectedKeys：本轮 runtimeKey 是调用方唯一确知"正在使用"的信息，
// 光靠时间阈值无法表达它。
test('never removes a home that is currently in use', async () => {
  const root = await createRoot()
  try {
    await createHome(root, 'active-key', 30)
    await createHome(root, 'stale-key', 30)

    const result = await pruneStaleCodexAgentHomes({
      rootDir: root,
      nowMs: Date.now(),
      protectedKeys: ['active-key'],
    })

    assert.equal(result.removed, 1)
    assert.deepEqual(await listNames(root), ['active-key'], '正在使用的隔离 HOME 必须保留')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('leaves loose files alone and only reclaims directories', async () => {
  const root = await createRoot()
  try {
    await createHome(root, 'stale-dir', 30)
    const filePath = path.join(root, 'notes.txt')
    await writeFile(filePath, 'keep me', 'utf8')
    const stamp = new Date(Date.now() - 30 * dayMs)
    await utimes(filePath, stamp, stamp)

    const result = await pruneStaleCodexAgentHomes({ rootDir: root, nowMs: Date.now() })

    assert.equal(result.removed, 1)
    assert.deepEqual(await listNames(root), ['notes.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('honours a custom retention window', async () => {
  const root = await createRoot()
  try {
    await createHome(root, 'three-days', 3)

    const untouched = await pruneStaleCodexAgentHomes({ rootDir: root, nowMs: Date.now() })
    assert.equal(untouched.removed, 0, '默认 7 天保留期内不应回收')

    const pruned = await pruneStaleCodexAgentHomes({
      rootDir: root,
      nowMs: Date.now(),
      maxAgeMs: 2 * dayMs,
    })
    assert.equal(pruned.removed, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// 回收是尽力而为的后台清理，绝不能因为目录不存在或被占用而让一次正常的 Codex 启动失败。
test('is a no-op when the root directory does not exist', async () => {
  const missing = path.join(tmpdir(), `cv-agent-homes-missing-${process.pid}`)
  const result = await pruneStaleCodexAgentHomes({ rootDir: missing, nowMs: Date.now() })
  assert.equal(result.removed, 0)
})
