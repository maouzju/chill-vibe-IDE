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

const makeRoot = () => mkdtempSync(path.join(os.tmpdir(), 'cli-compat-'))
const launches = async () => true

describe('cli compat manager', () => {
  it('resolves nothing until a compat version is both installed and active', async () => {
    const root = makeRoot()
    assert.equal(await resolveCompatCommand('claude', root, launches), null)

    await writeActiveCompatVersion('claude', '2.1.280', root)
    // 激活了但二进制不在（被删/装一半）必须回落系统 CLI，不能返回一个不存在的路径
    assert.equal(await resolveCompatCommand('claude', root, launches), null)

    const bin = getCompatBinPath('claude', '2.1.280', root)
    mkdirSync(path.dirname(bin), { recursive: true })
    writeFileSync(bin, '')
    assert.equal(await resolveCompatCommand('claude', root, launches), bin)
    assert.equal(await resolveCompatCommand('codex', root, launches), null)
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
    const bin = getCompatBinPath('claude', '2.1.280', root)
    mkdirSync(path.dirname(bin), { recursive: true })
    writeFileSync(bin, 'broken')
    await writeActiveCompatVersion('claude', '2.1.280', root)

    let probes = 0
    const failing = async () => {
      probes += 1
      return false
    }
    assert.equal(await resolveCompatCommand('claude', root, failing), null)
    assert.equal(await resolveCompatCommand('claude', root, failing), null)
    assert.equal(probes, 1, 'probe result must be cached per binary')
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
