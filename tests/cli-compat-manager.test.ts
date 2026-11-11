import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  CliCompatManager,
  getCompatBinPath,
  readActiveCompatVersions,
  resolveCompatCommand,
  writeActiveCompatVersion,
} from '../server/cli-compat-manager.ts'
import { compatibleCliVersions } from '../shared/cli-compat.ts'

const makeRoot = () => mkdtempSync(path.join(os.tmpdir(), 'cli-compat-'))
const launches = async () => true
const supportedClaudeVersion = compatibleCliVersions.claude.minVersion

describe('cli compat manager', () => {
  it('resolves nothing until a compat version is both installed and active', async () => {
    const root = makeRoot()
    assert.equal(await resolveCompatCommand('claude', root, launches), null)

    await writeActiveCompatVersion('claude', supportedClaudeVersion, root)
    // 激活了但二进制不在（被删/装一半）必须回落系统 CLI，不能返回一个不存在的路径
    assert.equal(await resolveCompatCommand('claude', root, launches), null)

    const bin = getCompatBinPath('claude', supportedClaudeVersion, root)
    mkdirSync(path.dirname(bin), { recursive: true })
    writeFileSync(bin, '')
    assert.equal(await resolveCompatCommand('claude', root, launches), bin)
    assert.equal(await resolveCompatCommand('codex', root, launches), null)
  })

  it('automatically promotes an active compat CLI that fell below the current support floor', async () => {
    const root = makeRoot()
    const staleVersion = '2.1.284'
    const pinnedVersion = compatibleCliVersions.claude.version
    const staleBin = getCompatBinPath('claude', staleVersion, root)
    const pinnedBin = getCompatBinPath('claude', pinnedVersion, root)
    mkdirSync(path.dirname(staleBin), { recursive: true })
    mkdirSync(path.dirname(pinnedBin), { recursive: true })
    writeFileSync(staleBin, 'stale')
    writeFileSync(pinnedBin, 'pinned')
    await writeActiveCompatVersion('claude', staleVersion, root)

    assert.equal(await resolveCompatCommand('claude', root, launches), pinnedBin)
    assert.deepEqual(await readActiveCompatVersions(root), { claude: pinnedVersion })
  })

  it('reports the promoted pinned version as active after a stale pointer is repaired', async () => {
    const root = makeRoot()
    const staleVersion = '2.1.284'
    const pinnedVersion = compatibleCliVersions.claude.version
    const staleBin = getCompatBinPath('claude', staleVersion, root)
    const pinnedBin = getCompatBinPath('claude', pinnedVersion, root)
    mkdirSync(path.dirname(staleBin), { recursive: true })
    mkdirSync(path.dirname(pinnedBin), { recursive: true })
    writeFileSync(staleBin, 'stale')
    writeFileSync(pinnedBin, 'pinned')
    await writeActiveCompatVersion('claude', staleVersion, root)

    const manager = new CliCompatManager(async () => null, async () => null, { root, probe: launches })
    const claude = (await manager.getStatus()).entries.find((entry) => entry.provider === 'claude')
    assert.equal(claude?.active, true)
    assert.equal(claude?.activeVersion, pinnedVersion)
  })

  it('deactivating falls back to the system CLI', async () => {
    const root = makeRoot()
    const bin = getCompatBinPath('codex', '0.156.1', root)
    mkdirSync(path.dirname(bin), { recursive: true })
    writeFileSync(bin, '')
    await writeActiveCompatVersion('codex', '0.156.1', root)
    assert.equal(await resolveCompatCommand('codex', root, launches), bin)

    await writeActiveCompatVersion('codex', null, root)
    assert.equal(await resolveCompatCommand('codex', root, launches), null)
    assert.deepEqual(await readActiveCompatVersions(root), {})
  })

  it('falls back to the system CLI when the active compat CLI cannot launch', async () => {
    const root = makeRoot()
    const bin = getCompatBinPath('claude', supportedClaudeVersion, root)
    mkdirSync(path.dirname(bin), { recursive: true })
    writeFileSync(bin, 'broken')
    await writeActiveCompatVersion('claude', supportedClaudeVersion, root)

    let probes = 0
    const failing = async () => {
      probes += 1
      return false
    }
    assert.equal(await resolveCompatCommand('claude', root, failing), null)
    assert.equal(await resolveCompatCommand('claude', root, failing), null)
    assert.equal(probes, 1, 'probe result must be cached per binary')
  })

  // 2026-09-29 用户截图：「切换到兼容版」点了没反应 —— 包装得在但起不来，激活后照样回落系统 CLI，按钮原地不动。
  it('reports an unlaunchable compat install as not installed so the UI offers a re-download', async () => {
    const root = makeRoot()
    const pinned = compatibleCliVersions.claude.version
    const bin = getCompatBinPath('claude', pinned, root)
    mkdirSync(path.dirname(bin), { recursive: true })
    writeFileSync(bin, 'broken-dead-switch')
    const manager = new CliCompatManager(async () => null, async () => null, {
      root,
      probe: async () => false,
    })
    const claude = (await manager.getStatus()).entries.find((entry) => entry.provider === 'claude')
    assert.equal(claude?.installed, false)
    await assert.rejects(manager.setActive('claude', true), /cannot launch/)

    const healthyRoot = makeRoot()
    const healthyBin = getCompatBinPath('claude', pinned, healthyRoot)
    mkdirSync(path.dirname(healthyBin), { recursive: true })
    writeFileSync(healthyBin, '')
    const healthy = new CliCompatManager(async () => null, async () => null, {
      root: healthyRoot,
      probe: async () => true,
    })
    const ok = (await healthy.getStatus()).entries.find((entry) => entry.provider === 'claude')
    assert.equal(ok?.installed, true)
    assert.equal(ok?.minCompatibleVersion, compatibleCliVersions.claude.minVersion)
  })

  it('tolerates a corrupt active file', async () => {
    const root = makeRoot()
    writeFileSync(path.join(root, 'active.json'), '\0\0\0')
    assert.deepEqual(await readActiveCompatVersions(root), {})
  })

  it('re-reads the system CLI version after a refresh instead of serving a permanent cache', async () => {
    let version = '2.1.280'
    const manager = new CliCompatManager(async () => 'claude', async () => version)
    const first = await manager.getStatus()
    version = '2.1.281'
    const second = await manager.getStatus()
    assert.notEqual(
      first.entries.find((entry) => entry.provider === 'claude')?.systemVersion,
      second.entries.find((entry) => entry.provider === 'claude')?.systemVersion,
    )
  })
})
