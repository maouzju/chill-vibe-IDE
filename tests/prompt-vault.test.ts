import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createDefaultState } from '../shared/default-state.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'

// 2026-09-29 用户报「更新后系统提示词被冲掉」，08-25 掉电之后在另一台电脑上又发生过至少一次，
// 现场拿不到。不管是哪条路径把设置写回了默认，自定义提示词都必须还能找回来。
describe('prompt vault', () => {
  let tmpDir: string

  const customState = () => {
    const state = createDefaultState('D:/prompt-vault')
    return {
      ...state,
      settings: {
        ...state.settings,
        systemPrompt: '1.说人话\n2.干就是了',
        modelPromptRules: [{ id: 'rule-1', modelMatch: 'gpt', prompt: '确认问题后直接修复' }],
      },
    }
  }

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `chill-vibe-vault-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('offers the last custom prompt after the settings on disk fell back to defaults', async () => {
    const { saveState, loadStateForRenderer } = await import('../server/state-store.ts')

    await saveState(customState())
    // 未知路径把设置冲回默认：直接改写盘上的 state.json。
    await writeFile(
      path.join(tmpDir, 'state.json'),
      `${JSON.stringify(createDefaultState('D:/prompt-vault'), null, 2)}\n`,
      'utf8',
    )

    const { state, recovery } = await loadStateForRenderer()

    assert.equal(state.settings.systemPrompt, defaultSystemPrompt)
    assert.equal(recovery.promptVault?.systemPrompt, '1.说人话\n2.干就是了')
    assert.deepEqual(recovery.promptVault?.modelPromptRules.map((rule) => rule.prompt), ['确认问题后直接修复'])
  })

  it('keeps the vault when a later save writes the default prompt back', async () => {
    const { saveState, loadStateForRenderer } = await import('../server/state-store.ts')

    await saveState(customState())
    await saveState(createDefaultState('D:/prompt-vault'))

    const { recovery } = await loadStateForRenderer()

    assert.equal(recovery.promptVault?.systemPrompt, '1.说人话\n2.干就是了')
  })

  it('stops offering a vault entry the user dismissed', async () => {
    const { saveState, loadStateForRenderer } = await import('../server/state-store.ts')

    await saveState(customState())
    const { recovery } = await (async () => {
      await saveState(createDefaultState('D:/prompt-vault'))
      return loadStateForRenderer()
    })()
    const savedAt = recovery.promptVault?.savedAt
    assert.ok(savedAt)

    const dismissed = createDefaultState('D:/prompt-vault')
    await saveState({ ...dismissed, settings: { ...dismissed.settings, promptVaultDismissedAt: savedAt } })

    assert.equal((await loadStateForRenderer()).recovery.promptVault ?? null, null)
  })

  it('does not offer anything while the current settings still carry the prompt', async () => {
    const { saveState, loadStateForRenderer } = await import('../server/state-store.ts')

    await saveState(customState())

    const { recovery } = await loadStateForRenderer()

    assert.equal(recovery.promptVault ?? null, null)
  })

  it('leaves no temp files behind and logs the fallback only once per vault entry', async () => {
    const { saveState } = await import('../server/state-store.ts')
    const { readdir } = await import('node:fs/promises')
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }

    try {
      await saveState(customState())
      const defaults = createDefaultState('D:/prompt-vault')
      await saveState(defaults)
      await saveState(defaults)
      await saveState(defaults)
    } finally {
      console.warn = originalWarn
    }

    assert.deepEqual((await readdir(tmpDir)).filter((name) => name.endsWith('.tmp')), [])
    assert.equal(warnings.filter((line) => line.includes('[prompt-vault] Saved settings carry')).length, 1)
  })
})
