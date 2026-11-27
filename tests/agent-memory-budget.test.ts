import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildCodexChatRequestOverrides, defaultCodexChatSettings } from '../shared/codex-chat-settings.ts'
import { createDefaultSettings, normalizeAppSettings } from '../shared/default-state.ts'
import { chatRequestSchema, type ChatRequest } from '../shared/schema.ts'
import { prepareDestructiveCommandGuardRuntime } from '../server/codex-safety.ts'
import { buildClaudeArgs, buildClaudeKeepaliveSignature } from '../server/providers.ts'

const memoryBudgetOff = {
  memoryBudgetEnabled: false,
  memoryBudgetMinFreeGb: 8,
  memoryBudgetMinCommitGb: 8,
  memoryBudgetMaxHeavyProcesses: 8,
}

test('memory budget settings default on with 8 GB / 8 GB / 8 processes and normalize bad values', () => {
  const defaults = createDefaultSettings()
  assert.equal(defaults.memoryBudgetEnabled, true)
  assert.equal(defaults.memoryBudgetMinFreeGb, 8)
  assert.equal(defaults.memoryBudgetMinCommitGb, 8)
  assert.equal(defaults.memoryBudgetMaxHeavyProcesses, 8)

  // 老存档没有这些字段：按默认补齐（默认开启）。
  const legacy = normalizeAppSettings({ language: 'zh-CN' } as never)
  assert.equal(legacy.memoryBudgetEnabled, true)
  assert.equal(legacy.memoryBudgetMinFreeGb, 8)

  const explicit = normalizeAppSettings({
    memoryBudgetEnabled: false,
    memoryBudgetMinFreeGb: 12,
    memoryBudgetMinCommitGb: 4,
    memoryBudgetMaxHeavyProcesses: 3,
  } as never)
  assert.equal(explicit.memoryBudgetEnabled, false)
  assert.equal(explicit.memoryBudgetMinFreeGb, 12)
  assert.equal(explicit.memoryBudgetMinCommitGb, 4)
  assert.equal(explicit.memoryBudgetMaxHeavyProcesses, 3)

  const garbage = normalizeAppSettings({
    memoryBudgetEnabled: 'yes',
    memoryBudgetMinFreeGb: Number.NaN,
    memoryBudgetMinCommitGb: 9999,
    memoryBudgetMaxHeavyProcesses: 0,
  } as never)
  assert.equal(garbage.memoryBudgetEnabled, true)
  assert.equal(garbage.memoryBudgetMinFreeGb, 8)
  assert.equal(garbage.memoryBudgetMinCommitGb, 256)
  assert.equal(garbage.memoryBudgetMaxHeavyProcesses, 1)
})

test('every provider request carries the memory budget only while it is enabled', () => {
  const enabled = {
    ...defaultCodexChatSettings,
    memoryBudgetEnabled: true,
    memoryBudgetMinFreeGb: 6,
    memoryBudgetMinCommitGb: 7,
    memoryBudgetMaxHeavyProcesses: 5,
  }
  for (const provider of ['claude', 'codex', 'gemini'] as const) {
    assert.deepEqual(
      buildCodexChatRequestOverrides(provider, enabled).memoryBudget,
      { minFreeGb: 6, minCommitGb: 7, maxHeavyProcesses: 5 },
      provider,
    )
    assert.equal(
      buildCodexChatRequestOverrides(provider, { ...defaultCodexChatSettings, ...memoryBudgetOff }).memoryBudget,
      undefined,
      provider,
    )
  }

  const parsed = chatRequestSchema.parse({
    provider: 'gemini',
    workspacePath: 'D:/repo',
    prompt: 'go',
    memoryBudget: { minFreeGb: 6, minCommitGb: 7, maxHeavyProcesses: 5 },
  })
  assert.deepEqual(parsed.memoryBudget, { minFreeGb: 6, minCommitGb: 7, maxHeavyProcesses: 5 })
})

const baseRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: 'claude',
  workspacePath: path.join(os.tmpdir(), 'chill-vibe-memory-budget-ws'),
  prompt: 'go',
  attachments: [],
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  agentOutsideWorkspaceWriteEnabled: true,
  codexDestructiveCommandProtectionEnabled: false,
  attackPatternProtectionEnabled: false,
  ...overrides,
} as ChatRequest)

test('the shared guard hook is injected for the memory budget even with every other protection off', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-memory-budget-'))
  const previous = process.env.CHILL_VIBE_DATA_DIR
  process.env.CHILL_VIBE_DATA_DIR = dataDir
  try {
    const off = await prepareDestructiveCommandGuardRuntime(baseRequest(), { PATH: process.env.PATH })
    assert.equal(off.hookCommand, undefined)
    assert.equal(off.env.CHILL_VIBE_MEMORY_BUDGET_ENABLED, undefined)

    const on = await prepareDestructiveCommandGuardRuntime(
      baseRequest({ memoryBudget: { minFreeGb: 6, minCommitGb: 7, maxHeavyProcesses: 5 } }),
      // 父进程残留的旧值必须被清掉，不能漏进 agent。
      { PATH: process.env.PATH, CHILL_VIBE_MEMORY_BUDGET_MIN_FREE_GB: '999' },
    )
    assert.ok(on.hookCommand)
    assert.equal(on.env.CHILL_VIBE_MEMORY_BUDGET_ENABLED, '1')
    assert.equal(on.env.CHILL_VIBE_MEMORY_BUDGET_MIN_FREE_GB, '6')
    assert.equal(on.env.CHILL_VIBE_MEMORY_BUDGET_MIN_COMMIT_GB, '7')
    assert.equal(on.env.CHILL_VIBE_MEMORY_BUDGET_MAX_HEAVY_PROCESSES, '5')
    assert.equal(on.env.CHILL_VIBE_DESTRUCTIVE_COMMAND_PROTECTION_ENABLED, '0')

    const stale = await prepareDestructiveCommandGuardRuntime(baseRequest(), {
      PATH: process.env.PATH,
      CHILL_VIBE_MEMORY_BUDGET_ENABLED: '1',
    })
    assert.equal(stale.env.CHILL_VIBE_MEMORY_BUDGET_ENABLED, undefined)
  } finally {
    if (previous === undefined) delete process.env.CHILL_VIBE_DATA_DIR
    else process.env.CHILL_VIBE_DATA_DIR = previous
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('Claude injects the PreToolUse hook for the memory budget alone and matches its PowerShell tool', () => {
  const request = baseRequest({ memoryBudget: { minFreeGb: 8, minCommitGb: 8, maxHeavyProcesses: 8 } })
  const args = buildClaudeArgs(request, [], {
    platform: 'win32',
    safetyHookCommand: "& 'D:\\safe path\\pre-tool-use-guard.cmd'; exit $LASTEXITCODE",
  })
  const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}') as {
    hooks?: { PreToolUse?: Array<{ matcher?: string }> }
  }
  const matcher = settings.hooks?.PreToolUse?.[0]?.matcher ?? ''
  assert.ok(matcher.split('|').includes('PowerShell'), matcher)
  assert.ok(matcher.split('|').includes('Bash'), matcher)

  const noBudgetArgs = buildClaudeArgs(baseRequest(), [], {
    platform: 'win32',
    safetyHookCommand: "& 'D:\\safe path\\pre-tool-use-guard.cmd'; exit $LASTEXITCODE",
  })
  const noBudgetSettings = JSON.parse(noBudgetArgs[noBudgetArgs.indexOf('--settings') + 1] ?? '{}') as {
    hooks?: unknown
  }
  assert.equal(noBudgetSettings.hooks, undefined)
})

test('Claude keepalive signature changes with the memory budget so a pooled CLI picks up new limits', () => {
  const runtime = { args: [], env: {} } as never
  const off = buildClaudeKeepaliveSignature(baseRequest(), true, runtime)
  const on = buildClaudeKeepaliveSignature(
    baseRequest({ memoryBudget: { minFreeGb: 8, minCommitGb: 8, maxHeavyProcesses: 8 } }),
    true,
    runtime,
  )
  const tighter = buildClaudeKeepaliveSignature(
    baseRequest({ memoryBudget: { minFreeGb: 8, minCommitGb: 8, maxHeavyProcesses: 4 } }),
    true,
    runtime,
  )
  assert.notEqual(off, on)
  assert.notEqual(on, tighter)
})
