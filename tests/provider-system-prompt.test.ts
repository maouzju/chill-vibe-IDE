import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDefaultState } from '../shared/default-state.ts'
import { chatRequestSchema, type ChatRequest, type StreamActivity } from '../shared/schema.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildProviderSystemPrompt,
  isCodexNativeReconnectPlaceholderForTesting,
  launchProviderRun,
  normalizeProviderExitCode,
  setProviderRuntimeSettingsOverride,
} from '../server/providers.ts'
import { prependPathEntry, writeNodeEntrypointShim } from './test-shell-helpers.ts'

const createRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: overrides.provider ?? 'codex',
  workspacePath: overrides.workspacePath ?? 'D:/Git/chill-vibe',
  model: overrides.model ?? 'gpt-5.5',
  reasoningEffort: overrides.reasoningEffort ?? 'medium',
  thinkingEnabled: overrides.thinkingEnabled ?? true,
  planMode: overrides.planMode ?? false,
  streamId: overrides.streamId,
  sessionId: overrides.sessionId,
  language: overrides.language ?? 'zh-CN',
  systemPrompt: overrides.systemPrompt ?? defaultSystemPrompt,
  modelPromptRules: overrides.modelPromptRules ?? [],
  crossProviderSkillReuseEnabled: overrides.crossProviderSkillReuseEnabled ?? true,
  prompt: overrides.prompt ?? '修复这个问题',
  attachments: overrides.attachments ?? [],
  archiveRecall: overrides.archiveRecall,
  sandboxMode: overrides.sandboxMode,
  approvalPolicy: overrides.approvalPolicy,
  networkAccessEnabled: overrides.networkAccessEnabled,
  codexDestructiveCommandProtectionEnabled: overrides.codexDestructiveCommandProtectionEnabled,
  codexIsolatedHomeEnabled: overrides.codexIsolatedHomeEnabled,
  personality: (overrides as Partial<ChatRequest> & { personality?: 'none' | 'friendly' | 'pragmatic' }).personality,
  serviceTier: (overrides as Partial<ChatRequest> & { serviceTier?: 'priority' }).serviceTier,
})

test('provider system prompt prepends the zh-CN language instruction', () => {
  const prompt = buildProviderSystemPrompt('zh-CN', defaultSystemPrompt)

  assert.match(prompt, /简体中文/)
  assert.match(prompt, /已解决/)
  assert.match(prompt, /尚未解决：/)
})

test('provider system prompt preserves the built-in default for English sessions', () => {
  const prompt = buildProviderSystemPrompt('en', defaultSystemPrompt)

  assert.equal(prompt, defaultSystemPrompt)
})

test('codex runs include the final resolution marker instruction', () => {
  const args = buildCodexArgs(
    createRequest({
      provider: 'codex',
      language: 'en',
      systemPrompt: 'Always leave a clear final status line.',
    }),
    [],
  )
  const instructionsArg = args.find((arg) => arg.startsWith('instructions='))

  assert.ok(instructionsArg)
  assert.match(instructionsArg, /Always leave a clear final status line\./)
  assert.match(instructionsArg, /ask-user-question/)
  assert.match(instructionsArg, /request_user_input/i)
})

test('codex instructions warn Windows PowerShell not to double-quote patterns with embedded quotes', () => {
  const args = buildCodexArgs(
    createRequest({
      provider: 'codex',
      language: 'en',
      systemPrompt: 'Base.',
    }),
    [],
  )
  const instructionsArg = args.find((arg) => arg.startsWith('instructions='))

  assert.ok(instructionsArg)
  assert.match(instructionsArg, /PowerShell/)
  assert.match(instructionsArg, /TerminatorExpectedAtEndOfString/)
  assert.match(instructionsArg, /single quotes/i)
  assert.match(instructionsArg, /rg --fixed-strings/)
})

test('claude runs include the final resolution marker instruction', () => {
  const args = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      language: 'en',
      systemPrompt: 'Always leave a clear final status line.',
    }),
    [],
  )
  const promptIndex = args.indexOf('--append-system-prompt')

  assert.notEqual(promptIndex, -1)
  const promptValue = args[promptIndex + 1] ?? ''
  assert.match(promptValue, /Always leave a clear final status line\./)
  assert.match(promptValue, /ask-user-question/)
})

test('claude ultracode tier sends --effort xhigh (the CLI rejects "ultracode")', () => {
  const args = buildClaudeArgs(
    createRequest({ provider: 'claude', model: 'claude-opus-4-8', reasoningEffort: 'ultracode' }),
    [],
  )
  const effortIndex = args.indexOf('--effort')
  assert.notEqual(effortIndex, -1)
  // --effort only accepts low/medium/high/xhigh/max; ultracode maps to xhigh.
  assert.equal(args[effortIndex + 1], 'xhigh')
  // The literal string "ultracode" must never reach the --effort flag.
  assert.notEqual(args[effortIndex + 1], 'ultracode')
})

test('claude ultracode tier activates via --settings instead of prompt keyword injection', () => {
  const ultracodeArgs = buildClaudeArgs(
    createRequest({ provider: 'claude', model: 'claude-opus-4-8', reasoningEffort: 'ultracode' }),
    [],
  )
  const settingsIndex = ultracodeArgs.indexOf('--settings')
  assert.notEqual(settingsIndex, -1)
  const settings = JSON.parse(ultracodeArgs[settingsIndex + 1] ?? '{}')
  // Official channel (Claude Code v2.1.157+): a session-level settings key.
  assert.equal(settings.ultracode, true)
  // The old keyword-injection hack depended on workflowKeywordTriggerEnabled
  // staying on and polluted the system prompt; it must be gone.
  const sysIndex = ultracodeArgs.indexOf('--append-system-prompt')
  assert.notEqual(sysIndex, -1)
  assert.doesNotMatch(ultracodeArgs[sysIndex + 1] ?? '', /ultracode/i)

  // A non-ultracode tier must carry neither the settings key nor the keyword.
  const maxArgs = buildClaudeArgs(
    createRequest({ provider: 'claude', model: 'claude-opus-4-8', reasoningEffort: 'max' }),
    [],
  )
  const maxSettings = JSON.parse(maxArgs[maxArgs.indexOf('--settings') + 1] ?? '{}')
  assert.equal('ultracode' in maxSettings, false)
  const maxSysIndex = maxArgs.indexOf('--append-system-prompt')
  assert.equal(maxArgs[maxArgs.indexOf('--effort') + 1], 'max')
  assert.doesNotMatch(maxArgs[maxSysIndex + 1] ?? '', /ultracode/)
})

test('claude fable 5 never sends --effort none because thinking cannot be turned off', () => {
  // Thinking toggled off on Fable 5 degrades to its official high default.
  const fableThinkingOffArgs = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-fable-5',
      reasoningEffort: 'max',
      thinkingEnabled: false,
    }),
    [],
  )
  assert.equal(fableThinkingOffArgs[fableThinkingOffArgs.indexOf('--effort') + 1], 'high')

  // Persisted auto tiers degrade to the Fable default as well.
  const fableAutoArgs = buildClaudeArgs(
    createRequest({ provider: 'claude', model: 'claude-fable-5', reasoningEffort: 'auto' }),
    [],
  )
  assert.equal(fableAutoArgs[fableAutoArgs.indexOf('--effort') + 1], 'high')

  // An explicitly chosen tier still passes through unchanged.
  const fableXhighArgs = buildClaudeArgs(
    createRequest({ provider: 'claude', model: 'claude-fable-5', reasoningEffort: 'xhigh' }),
    [],
  )
  assert.equal(fableXhighArgs[fableXhighArgs.indexOf('--effort') + 1], 'xhigh')

  // Other Claude models keep the legacy thinking-off contract.
  const opusArgs = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-opus-4-8',
      reasoningEffort: 'max',
      thinkingEnabled: false,
    }),
    [],
  )
  assert.equal(opusArgs[opusArgs.indexOf('--effort') + 1], 'none')
})

test('claude ask-user instruction avoids raw XML examples that prime text tool calls', () => {
  const enArgs = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      language: 'en',
      systemPrompt: 'Base.',
    }),
    [],
  )
  const enPrompt = enArgs[enArgs.indexOf('--append-system-prompt') + 1] ?? ''

  assert.match(enPrompt, /ask-user-question/)
  assert.doesNotMatch(enPrompt, /streams reliably/i)
  assert.doesNotMatch(enPrompt, /does not depend on tool availability/i)
  assert.doesNotMatch(enPrompt, /<ask-user-question>/)
  assert.doesNotMatch(enPrompt, /<invoke/i)
  assert.doesNotMatch(enPrompt, /<function_calls/i)
  assert.match(enPrompt, /native tool calls/i)
  assert.match(enPrompt, /Do not write tool calls as text/i)

  const zhArgs = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      language: 'zh-CN',
      systemPrompt: 'Base.',
    }),
    [],
  )
  const zhPrompt = zhArgs[zhArgs.indexOf('--append-system-prompt') + 1] ?? ''

  assert.match(zhPrompt, /ask-user-question/)
  assert.doesNotMatch(zhPrompt, /<ask-user-question>/)
  assert.doesNotMatch(zhPrompt, /<invoke/i)
  assert.doesNotMatch(zhPrompt, /<function_calls/i)
})

test('codex args append matching model prompt rules before provider execution', () => {
  const args = buildCodexArgs(
    createRequest({
      provider: 'codex',
      model: 'gpt-5.5',
      language: 'en',
      systemPrompt: 'Base system prompt.',
      modelPromptRules: [
        {
          id: 'rule-gpt',
          modelMatch: 'gpt',
          prompt: 'Use GPT-specific guidance.',
        },
        {
          id: 'rule-claude',
          modelMatch: 'claude',
          prompt: 'Should not reach Codex.',
        },
      ],
    }),
    [],
  )
  const instructionsArg = args.find((arg) => arg.startsWith('instructions='))

  assert.ok(instructionsArg)
  assert.match(instructionsArg, /Base system prompt\./)
  assert.match(instructionsArg, /Use GPT-specific guidance\./)
  assert.doesNotMatch(instructionsArg, /Should not reach Codex\./)
})

test('claude args append matching model prompt rules before provider execution', () => {
  const args = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      language: 'en',
      systemPrompt: 'Base system prompt.',
      modelPromptRules: [
        {
          id: 'rule-claude',
          modelMatch: 'claude',
          prompt: 'Use Claude-specific guidance.',
        },
        {
          id: 'rule-gpt',
          modelMatch: 'gpt',
          prompt: 'Should not reach Claude.',
        },
      ],
    }),
    [],
  )
  const promptIndex = args.indexOf('--append-system-prompt')

  assert.notEqual(promptIndex, -1)
  const promptValue = args[promptIndex + 1] ?? ''
  assert.match(promptValue, /Base system prompt\./)
  assert.match(promptValue, /Use Claude-specific guidance\./)
  assert.doesNotMatch(promptValue, /Should not reach Claude\./)
})

test('claude runs pin the permission default mode so spawned subagents inherit it', () => {
  const args = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      language: 'en',
    }),
    [],
  )
  const settingsIndex = args.indexOf('--settings')

  assert.notEqual(settingsIndex, -1)
  const settingsArg = args[settingsIndex + 1] ?? ''
  const parsedSettings = JSON.parse(settingsArg) as {
    skipDangerousModePermissionPrompt?: boolean
    permissions?: { defaultMode?: string }
  }

  assert.equal(parsedSettings.permissions?.defaultMode, 'bypassPermissions')
  assert.equal(parsedSettings.skipDangerousModePermissionPrompt, true)
})

test('claude runs pre-authorize the resolved global .claude directory for tool access', async () => {
  const tempRoot = path.join(
    os.tmpdir(),
    `chill-vibe-claude-permissions-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const homeDir = path.join(tempRoot, 'home')
  const claudeDir = path.join(homeDir, '.claude')

  await mkdir(claudeDir, { recursive: true })

  try {
    const args = buildClaudeArgs(
      createRequest({
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        language: 'en',
        crossProviderSkillReuseEnabled: false,
      }),
      [],
      {
        env: {
          HOME: homeDir,
        },
        homeDir,
      },
    )
    const addDirIndex = args.indexOf('--add-dir')
    const settingsIndex = args.indexOf('--settings')

    assert.notEqual(addDirIndex, -1)
    assert.equal(args[addDirIndex + 1], claudeDir)
    assert.notEqual(settingsIndex, -1)

    const settingsArg = args[settingsIndex + 1] ?? ''
    const parsedSettings = JSON.parse(settingsArg) as {
      permissions?: { additionalDirectories?: string[] }
    }

    assert.deepEqual(parsedSettings.permissions?.additionalDirectories, [claudeDir])
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
})

test('claude runs pre-authorize the resolved global .codex directory when cross-provider skill reuse is enabled', async () => {
  const tempRoot = path.join(
    os.tmpdir(),
    `chill-vibe-claude-codex-skill-permissions-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const homeDir = path.join(tempRoot, 'home')
  const claudeDir = path.join(homeDir, '.claude')
  const codexDir = path.join(homeDir, '.codex')

  await mkdir(claudeDir, { recursive: true })
  await mkdir(codexDir, { recursive: true })

  try {
    const args = buildClaudeArgs(
      createRequest({
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        language: 'en',
        crossProviderSkillReuseEnabled: true,
      }),
      [],
      {
        env: {
          HOME: homeDir,
        },
        homeDir,
      },
    )
    const addDirIndex = args.indexOf('--add-dir')
    const settingsIndex = args.indexOf('--settings')

    assert.notEqual(addDirIndex, -1)
    assert.deepEqual(args.slice(addDirIndex + 1, addDirIndex + 3), [claudeDir, codexDir])
    assert.notEqual(settingsIndex, -1)

    const settingsArg = args[settingsIndex + 1] ?? ''
    const parsedSettings = JSON.parse(settingsArg) as {
      permissions?: { additionalDirectories?: string[] }
    }

    assert.deepEqual(parsedSettings.permissions?.additionalDirectories, [claudeDir, codexDir])
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
})

test('claude does not pre-authorize the global .codex directory when cross-provider skill reuse is disabled', async () => {
  const tempRoot = path.join(
    os.tmpdir(),
    `chill-vibe-claude-codex-skill-permissions-off-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const homeDir = path.join(tempRoot, 'home')
  const claudeDir = path.join(homeDir, '.claude')
  const codexDir = path.join(homeDir, '.codex')

  await mkdir(claudeDir, { recursive: true })
  await mkdir(codexDir, { recursive: true })

  try {
    const args = buildClaudeArgs(
      createRequest({
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        language: 'en',
        crossProviderSkillReuseEnabled: false,
      }),
      [],
      {
        env: {
          HOME: homeDir,
        },
        homeDir,
      },
    )
    const settingsIndex = args.indexOf('--settings')

    assert.notEqual(settingsIndex, -1)

    const settingsArg = args[settingsIndex + 1] ?? ''
    const parsedSettings = JSON.parse(settingsArg) as {
      permissions?: { additionalDirectories?: string[] }
    }

    assert.deepEqual(parsedSettings.permissions?.additionalDirectories, [claudeDir])
    assert.equal(parsedSettings.permissions?.additionalDirectories?.includes(codexDir), false)
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
})

test('codex app-server injects opposite-provider workspace skills when cross-provider reuse is enabled', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-cross-skill-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) => {
        const skillDir = path.join(workspacePath, '.claude', 'skills', 'agent-reach')
        await mkdir(skillDir, { recursive: true })
        await writeFile(
          path.join(skillDir, 'SKILL.md'),
          [
            '---',
            'name: agent-reach',
            'description: Search the web and supported platforms',
            '---',
            '',
            '# Agent Reach',
          ].join('\n'),
          'utf8',
        )

        return captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            crossProviderSkillReuseEnabled: true,
          }),
        )
      },
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const threadStart = requests.find((request) => request.method === 'thread/start')
    const baseInstructions = String(threadStart?.params?.baseInstructions ?? '')

    assert.match(baseInstructions, /Cross-provider skill reuse is enabled\./)
    assert.match(baseInstructions, /agent-reach \(claude\)/)
    assert.match(baseInstructions, /Search the web and supported platforms/)
    assert.match(baseInstructions, /SKILL\.md/)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server does not inject a claude skill shadowed by a same-name codex skill', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-cross-skill-shadow-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    let claudeShadowedSkillPath = ''

    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) => {
        const codexSkillDir = path.join(workspacePath, '.codex', 'skills', 'shared-review')
        const claudeSkillDir = path.join(workspacePath, '.claude', 'skills', 'shared-review')
        const claudeUniqueSkillDir = path.join(workspacePath, '.claude', 'skills', 'claude-only')
        await mkdir(codexSkillDir, { recursive: true })
        await mkdir(claudeSkillDir, { recursive: true })
        await mkdir(claudeUniqueSkillDir, { recursive: true })
        await writeFile(
          path.join(codexSkillDir, 'SKILL.md'),
          '---\nname: shared-review\ndescription: Codex-native review workflow\n---\n',
          'utf8',
        )
        claudeShadowedSkillPath = path.join(claudeSkillDir, 'SKILL.md')
        await writeFile(
          claudeShadowedSkillPath,
          '---\nname: shared-review\ndescription: Claude duplicate review workflow\n---\n',
          'utf8',
        )
        await writeFile(
          path.join(claudeUniqueSkillDir, 'SKILL.md'),
          '---\nname: claude-only\ndescription: Claude-only workflow\n---\n',
          'utf8',
        )

        return captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            crossProviderSkillReuseEnabled: true,
          }),
        )
      },
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const threadStart = requests.find((request) => request.method === 'thread/start')
    const baseInstructions = String(threadStart?.params?.baseInstructions ?? '')

    assert.match(baseInstructions, /claude-only \(claude\)/)
    assert.doesNotMatch(baseInstructions, /shared-review \(claude\)/)
    assert.ok(!baseInstructions.includes(claudeShadowedSkillPath))
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('explicit cross-provider skill invocation is not repeated in system instructions', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-cross-skill-explicit-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    let skillPath = ''

    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) => {
        const skillDir = path.join(workspacePath, '.claude', 'skills', 'agent-reach')
        await mkdir(skillDir, { recursive: true })
        skillPath = path.join(skillDir, 'SKILL.md')
        await writeFile(
          skillPath,
          '---\nname: agent-reach\ndescription: Search supported platforms\n---\n',
          'utf8',
        )

        return captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            prompt: '/agent-reach Find the latest docs.',
            crossProviderSkillReuseEnabled: true,
          }),
        )
      },
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const threadStart = requests.find((request) => request.method === 'thread/start')
    const turnStart = requests.find((request) => request.method === 'turn/start')
    const baseInstructions = String(threadStart?.params?.baseInstructions ?? '')
    const input = Array.isArray(turnStart?.params?.input) ? turnStart.params.input : []
    const promptText =
      input.length > 0 && typeof input[0] === 'object' && input[0] !== null && 'text' in input[0]
        ? String((input[0] as { text?: unknown }).text ?? '')
        : ''

    assert.ok(promptText.includes(skillPath))
    assert.match(promptText, /Use \$agent-reach at /)
    assert.doesNotMatch(baseInstructions, /agent-reach \(claude\)/)
    assert.ok(!baseInstructions.includes(skillPath))
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server skips opposite-provider skill injection when cross-provider reuse is disabled', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-cross-skill-off-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) => {
        const skillDir = path.join(workspacePath, '.claude', 'skills', 'agent-reach')
        await mkdir(skillDir, { recursive: true })
        await writeFile(
          path.join(skillDir, 'SKILL.md'),
          [
            '---',
            'name: agent-reach',
            'description: Search the web and supported platforms',
            '---',
            '',
            '# Agent Reach',
          ].join('\n'),
          'utf8',
        )

        return captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            crossProviderSkillReuseEnabled: false,
          }),
        )
      },
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const threadStart = requests.find((request) => request.method === 'thread/start')
    const baseInstructions = String(threadStart?.params?.baseInstructions ?? '')

    assert.doesNotMatch(baseInstructions, /Cross-provider skill reuse is enabled\./)
    assert.doesNotMatch(baseInstructions, /agent-reach \(claude\)/)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})


test('codex skill slash prompts expand to an explicit SKILL.md instruction before launch', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-skill-slash-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    let skillPath = ''

    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) => {
        const skillDir = path.join(workspacePath, '.claude', 'skills', 'agent-reach')
        await mkdir(skillDir, { recursive: true })
        skillPath = path.join(skillDir, 'SKILL.md')
        await writeFile(
          skillPath,
          [
            '---',
            'name: agent-reach',
            'description: Search the web and supported platforms',
            '---',
            '',
            '# Agent Reach',
          ].join('\n'),
          'utf8',
        )

        return captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            prompt: '/agent-reach Find the latest project docs.',
          }),
        )
      },
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const turnStart = requests.find((request) => request.method === 'turn/start')
    const input = Array.isArray(turnStart?.params?.input) ? turnStart.params?.input : []
    const promptText =
      input.length > 0 && typeof input[0] === 'object' && input[0] !== null && 'text' in input[0]
        ? String((input[0] as { text?: unknown }).text ?? '')
        : ''

    assert.match(promptText, /Use \$agent-reach at /)
    assert.ok(promptText.includes(skillPath), `expected prompt to include ${skillPath}, got ${promptText}`)
    assert.match(promptText, /Search the web and supported platforms/)
    assert.match(promptText, /Find the latest project docs\./)
    assert.doesNotMatch(promptText, /^\/agent-reach\b/)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('claude skill slash prompts expand to an explicit SKILL.md instruction before launch', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-claude-skill-slash-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    let skillPath = ''

    const outcome = await withFakeProviderCommand(
      'claude',
      buildFakeClaudeCapturePromptScript(capturePath),
      async (workspacePath) => {
        const skillDir = path.join(workspacePath, '.codex', 'skills', 'check-all')
        await mkdir(skillDir, { recursive: true })
        skillPath = path.join(skillDir, 'SKILL.md')
        await writeFile(
          skillPath,
          [
            '---',
            'name: check-all',
            'description: Run the broad validation workflow',
            '---',
            '',
            '# Check All',
          ].join('\n'),
          'utf8',
        )

        return captureProviderOutcome(
          createRequest({
            provider: 'claude',
            model: 'claude-sonnet-4-6',
            language: 'en',
            workspacePath,
            prompt: '/check-all Validate the release candidate.',
          }),
        )
      },
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const launches = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[])

    assert.equal(launches.length, 1)
    const argv = launches[0] ?? []
    const systemPromptIndex = argv.indexOf('--append-system-prompt')
    assert.notEqual(systemPromptIndex, -1)

    const trailing = argv.slice(systemPromptIndex + 2)
    assert.equal(
      trailing.length,
      1,
      `expected exactly one positional prompt after the system prompt flag, got ${JSON.stringify(trailing)}`,
    )

    const promptArg = trailing[0] ?? ''
    assert.match(promptArg, /Use \$check-all at /)
    assert.ok(promptArg.includes(skillPath), `expected prompt to include ${skillPath}, got ${promptArg}`)
    assert.match(promptArg, /Run the broad validation workflow/)
    assert.match(promptArg, /Validate the release candidate\./)
    assert.doesNotMatch(promptArg, /^\/check-all\b/)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server injects archive recall MCP config and instruction for compacted history', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-archive-recall-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexArchiveRecallScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            archiveRecall: {
              hiddenReason: 'compact',
              hiddenMessageCount: 1,
              messages: [
                {
                  id: 'hidden-user',
                  role: 'user',
                  content: 'Earlier screenshot is attached here.',
                  createdAt: '2026-04-18T01:09:00.000Z',
                  meta: {},
                },
              ],
            },
          }),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const events = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { kind?: string; argv?: string[]; method?: string; params?: Record<string, unknown> })
    const startup = events.find((event) => event.kind === 'startup')
    const argv = startup?.argv ?? []
    const joinedArgs = argv.join(' ')

    assert.match(joinedArgs, /mcp_servers\.chill_vibe_archive\.command=/)
    assert.match(joinedArgs, /archive-recall-mcp\.js/)
    assert.match(joinedArgs, /CHILL_VIBE_ARCHIVE_RECALL_FILE=/)

    const snapshotArg = argv.find((arg) =>
      arg.startsWith('mcp_servers.chill_vibe_archive.env.CHILL_VIBE_ARCHIVE_RECALL_FILE='),
    )
    assert.ok(snapshotArg)

    const snapshotPath = snapshotArg
      ?.slice('mcp_servers.chill_vibe_archive.env.CHILL_VIBE_ARCHIVE_RECALL_FILE='.length)
      .replace(/^"/, '')
      .replace(/"$/, '')
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"')
    assert.ok(snapshotPath)

    const threadStart = events.find((event) => event.method === 'thread/start')
    const baseInstructions = String(threadStart?.params?.baseInstructions ?? '')
    assert.match(baseInstructions, /search_compacted_history/)
    assert.match(baseInstructions, /Do not say an older attachment is unavailable/)

    const snapshotStillExists = await readFile(snapshotPath!, 'utf8').then(() => true).catch(() => false)
    assert.equal(snapshotStillExists, false)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('chat requests allow resuming a saved session without a new prompt', () => {
  const parsed = chatRequestSchema.safeParse({
    ...createRequest({
      provider: 'codex',
      language: 'en',
      prompt: '',
      attachments: [],
      sessionId: 'resume-session-1',
    }),
  })

  assert.equal(parsed.success, true)
})

test('resume args omit an empty prompt when continuing a codex session', () => {
  const args = buildCodexArgs(
    createRequest({
      provider: 'codex',
      language: 'en',
      sessionId: 'resume-session-1',
      prompt: '',
      attachments: [],
    }),
    [],
  )

  assert.deepEqual(args.slice(0, 4), [
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
  ])
  assert.ok(args.includes('resume-session-1'))
  assert.ok(!args.includes(''))
})

test('claude streaming-input args keep the user prompt off argv', () => {
  const longPrompt = 'line\n'.repeat(2000)
  const args = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      language: 'en',
      prompt: longPrompt,
      attachments: [],
    }),
    [],
    { streamingInput: true },
  )

  assert.ok(args.includes('--input-format'))
  assert.ok(args.includes('stream-json'))
  assert.ok(!args.includes(longPrompt), 'streaming-input prompt must be sent over stdin, not argv')
  const systemPromptIndex = args.indexOf('--append-system-prompt')
  assert.notEqual(systemPromptIndex, -1)
  assert.deepEqual(args.slice(systemPromptIndex + 2), [])
})

test('resume args include a fallback prompt when continuing a claude session with no new input', () => {
  const args = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      language: 'en',
      sessionId: 'resume-session-1',
      prompt: '',
      attachments: [],
    }),
    [],
  )

  assert.equal(args[0], '-r')
  assert.equal(args[1], 'resume-session-1')
  assert.ok(!args.includes(''))
  // The Claude CLI treats the trailing positional argument as the user prompt.
  // When resuming a session with no new input we must still pass a non-empty
  // fallback prompt so the CLI has something to continue with — otherwise it
  // errors out with "No deferred tool marker found in the resumed session."
  const systemPromptIndex = args.indexOf('--append-system-prompt')
  assert.notEqual(systemPromptIndex, -1)
  const trailing = args.slice(systemPromptIndex + 2)
  assert.equal(
    trailing.length,
    1,
    `expected exactly one positional prompt after the system prompt flag, got ${JSON.stringify(trailing)}`,
  )
  assert.ok(trailing[0].trim().length > 0, 'fallback prompt must be non-empty')
})

test('claude image attachment prompts follow the documented image-path format', () => {
  const attachmentPath = path.join('D:/tmp', 'screenshots', 'claude image.png')
  const args = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      language: 'en',
      prompt: 'Please inspect the image.',
    }),
    [attachmentPath],
  )
  const promptArg = args.at(-1) ?? ''

  assert.match(promptArg, /^Analyze this image:\n/)
  assert.match(promptArg, /Please inspect the image\./)
  assert.ok(promptArg.includes(attachmentPath))
  assert.ok(!promptArg.includes('Read tool'))
  assert.ok(!promptArg.includes('[Attached image:'))
})

test('claude image runs pre-authorize the attachment directory for native vision reads', () => {
  const attachmentPath = path.join(os.tmpdir(), 'chill-vibe-data', 'attachments', 'claude image.png')
  const args = buildClaudeArgs(
    createRequest({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      language: 'en',
      prompt: 'Please inspect the image.',
    }),
    [attachmentPath],
    {
      env: {
        HOME: path.join(os.tmpdir(), 'chill-vibe-home'),
      },
      homeDir: path.join(os.tmpdir(), 'chill-vibe-home'),
    },
  )
  const addDirIndex = args.indexOf('--add-dir')
  const settingsIndex = args.indexOf('--settings')

  assert.notEqual(addDirIndex, -1)
  assert.ok(args.includes(path.dirname(attachmentPath)))
  assert.notEqual(settingsIndex, -1)

  const settingsArg = args[settingsIndex + 1] ?? ''
  const parsedSettings = JSON.parse(settingsArg) as {
    permissions?: { additionalDirectories?: string[] }
  }

  assert.ok(parsedSettings.permissions?.additionalDirectories?.includes(path.dirname(attachmentPath)))
})

test('codex exec args default to danger-full-access sandbox for normal chats', () => {
  const args = buildCodexArgs(
    createRequest({
      provider: 'codex',
      language: 'en',
    }),
    [],
  )

  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.match(args.join(' '), /--ask-for-approval never --sandbox danger-full-access/)
})

test('normalizes Windows unsigned exit codes back to signed values', () => {
  assert.equal(normalizeProviderExitCode(4294967295), -1)
  assert.equal(normalizeProviderExitCode(1), 1)
  assert.equal(normalizeProviderExitCode(null), null)
})

const writeTestState = async (dataDir: string, workspacePath: string) => {
  const state = createDefaultState(workspacePath, 'en')
  state.settings.cliRoutingEnabled = false
  await writeFile(path.join(dataDir, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
}

const withFakeProviderCommand = async <T>(
  provider: 'codex' | 'claude',
  scriptSource: string,
  run: (workspacePath: string) => Promise<T>,
) => {
  const tempRoot = path.join(
    os.tmpdir(),
    `chill-vibe-provider-run-${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const binDir = path.join(tempRoot, 'bin')
  const dataDir = path.join(tempRoot, 'data')
  const workspacePath = path.join(tempRoot, 'workspace')
  const entrypointPath = path.join(binDir, `${provider}-cli.js`)
  const originalPath = process.env.PATH
  const originalDataDir = process.env.CHILL_VIBE_DATA_DIR
  const originalPlaceholderTimeout = process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
  const originalLocalFirstByteTimeout = process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS
  const originalLocalStallTimeout = process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS

  await mkdir(binDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(workspacePath, { recursive: true })
  await writeTestState(dataDir, workspacePath)
  await writeFile(entrypointPath, scriptSource, 'utf8')
  await writeNodeEntrypointShim({
    dir: binDir,
    name: provider,
    entrypointPath,
  })

  process.env.PATH = prependPathEntry(binDir, originalPath ?? '')
  process.env.CHILL_VIBE_DATA_DIR = dataDir

  try {
    return await run(workspacePath)
  } finally {
    if (typeof originalPath === 'string') {
      process.env.PATH = originalPath
    } else {
      delete process.env.PATH
    }

    if (typeof originalDataDir === 'string') {
      process.env.CHILL_VIBE_DATA_DIR = originalDataDir
    } else {
      delete process.env.CHILL_VIBE_DATA_DIR
    }

    if (typeof originalPlaceholderTimeout === 'string') {
      process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = originalPlaceholderTimeout
    } else {
      delete process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
    }

    if (typeof originalLocalFirstByteTimeout === 'string') {
      process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS = originalLocalFirstByteTimeout
    } else {
      delete process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS
    }

    if (typeof originalLocalStallTimeout === 'string') {
      process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS = originalLocalStallTimeout
    } else {
      delete process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS
    }

    setProviderRuntimeSettingsOverride(null)

    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

const captureProviderOutcome = async (request: ChatRequest) =>
  new Promise<{ kind: 'done' } | { kind: 'error'; message: string }>((resolve, reject) => {
    void launchProviderRun(request, {
      onSession: () => undefined,
      onDelta: () => undefined,
      onLog: () => undefined,
      onAssistantMessage: () => undefined,
      onActivity: () => undefined,
      onDone: () => resolve({ kind: 'done' }),
      onError: (message) => resolve({ kind: 'error', message }),
    }).then((child) => {
      if (!child) {
        reject(new Error('Expected fake provider command to launch.'))
      }
    }).catch(reject)
  })

const captureProviderEvents = async (request: ChatRequest) =>
  new Promise<
    Array<
      | { kind: 'delta'; content: string; itemId?: string }
      | { kind: 'assistant_message'; itemId: string; content: string }
      | { kind: 'activity'; activity: StreamActivity }
      | { kind: 'done' }
      | { kind: 'error'; message: string }
    >
  >((resolve, reject) => {
    const events: Array<
      | { kind: 'delta'; content: string; itemId?: string }
      | { kind: 'assistant_message'; itemId: string; content: string }
      | { kind: 'activity'; activity: StreamActivity }
      | { kind: 'done' }
      | { kind: 'error'; message: string }
    > = []

    void launchProviderRun(request, {
      onSession: () => undefined,
      onDelta: (content, itemId?: string) => {
        events.push({ kind: 'delta', content, ...(itemId ? { itemId } : {}) })
      },
      onLog: () => undefined,
      onAssistantMessage: (message) => {
        events.push({
          kind: 'assistant_message',
          itemId: message.itemId,
          content: message.content,
        })
      },
      onActivity: (activity) => {
        events.push({ kind: 'activity', activity })
      },
      onDone: () => {
        events.push({ kind: 'done' })
        resolve(events)
      },
      onError: (message) => {
        events.push({ kind: 'error', message })
        resolve(events)
      },
    }).then((child) => {
      if (!child) {
        reject(new Error('Expected fake provider command to launch.'))
      }
    }).catch(reject)
  })

const captureProviderActivities = async (request: ChatRequest) =>
  new Promise<
    Array<
      | { kind: 'activity'; activity: StreamActivity }
      | { kind: 'done' }
      | { kind: 'error'; message: string }
    >
  >((resolve, reject) => {
    const events: Array<
      | { kind: 'activity'; activity: StreamActivity }
      | { kind: 'done' }
      | { kind: 'error'; message: string }
    > = []

    void launchProviderRun(request, {
      onSession: () => undefined,
      onDelta: () => undefined,
      onLog: () => undefined,
      onAssistantMessage: () => undefined,
      onActivity: (activity) => {
        events.push({ kind: 'activity', activity })
      },
      onDone: () => {
        events.push({ kind: 'done' })
        resolve(events)
      },
      onError: (message) => {
        events.push({ kind: 'error', message })
        resolve(events)
      },
    }).then((child) => {
      if (!child) {
        reject(new Error('Expected fake provider command to launch.'))
      }
    }).catch(reject)
  })


const captureProviderStatsWithin = async (request: ChatRequest, timeoutMs = 500) =>
  new Promise<
    | { kind: 'stats'; event: string; endpoint?: string; errorType?: string; alreadyRecorded?: boolean }
    | { kind: 'timeout' }
  >((resolve, reject) => {
    let settled = false
    let child: Awaited<ReturnType<typeof launchProviderRun>> | null = null
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child?.kill()
      resolve({ kind: 'timeout' })
    }, timeoutMs)

    void launchProviderRun(request, {
      onSession: () => undefined,
      onDelta: () => undefined,
      onLog: () => undefined,
      onAssistantMessage: () => undefined,
      onActivity: () => undefined,
      onStats: (payload: { event: string; endpoint?: string; errorType?: string; alreadyRecorded?: boolean }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child?.kill()
        resolve({ kind: 'stats', ...payload })
      },
      onDone: () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('Expected provider run to emit a stats event.'))
      },
      onError: (message) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`Expected stats before provider error: ${message}`))
      },
    } as Parameters<typeof launchProviderRun>[1] & {
      onStats: (payload: {
        event: string
        endpoint?: string
        errorType?: string
        alreadyRecorded?: boolean
      }) => void
    }).then((launchedChild) => {
      child = launchedChild
      if (!launchedChild && !settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('Expected fake provider command to launch.'))
      }
    }).catch((error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })

const captureProviderRecoveryFailureWithin = async (request: ChatRequest, timeoutMs = 500) =>
  new Promise<
    | { kind: 'error'; message: string; recovery: { recoverable?: boolean; recoveryMode?: 'reattach-stream' | 'resume-session'; transientOnly?: boolean } }
    | { kind: 'timeout' }
  >((resolve, reject) => {
    let settled = false
    let child: Awaited<ReturnType<typeof launchProviderRun>> | null = null
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child?.kill()
      resolve({ kind: 'timeout' })
    }, timeoutMs)

    void launchProviderRun(request, {
      onSession: () => undefined,
      onDelta: () => undefined,
      onLog: () => undefined,
      onAssistantMessage: () => undefined,
      onActivity: () => undefined,
      onDone: () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error('Expected provider run to fail.'))
      },
      onError: (message, _hint, recovery) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: 'error', message, recovery: recovery ?? {} })
      },
    }).then((launchedChild) => {
      child = launchedChild
      if (!launchedChild && !settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('Expected fake provider command to launch.'))
      }
    }).catch((error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })

const captureProviderRecoveryFailure = async (request: ChatRequest) =>
  new Promise<{
    kind: 'error'
    message: string
    recovery: { recoverable?: boolean; recoveryMode?: 'reattach-stream' | 'resume-session'; transientOnly?: boolean }
  }>((resolve, reject) => {
    void launchProviderRun(request, {
      onSession: () => undefined,
      onDelta: () => undefined,
      onLog: () => undefined,
      onAssistantMessage: () => undefined,
      onActivity: () => undefined,
      onDone: () => reject(new Error('Expected provider run to fail.')),
      onError: (message, _hint, recovery) => resolve({ kind: 'error', message, recovery: recovery ?? {} }),
    }).then((child) => {
      if (!child) {
        reject(new Error('Expected fake provider command to launch.'))
      }
    }).catch(reject)
  })

const captureProviderLogs = async (request: ChatRequest) =>
  new Promise<
    Array<
      | { kind: 'log'; message: string }
      | { kind: 'done' }
      | { kind: 'error'; message: string }
    >
  >((resolve, reject) => {
    const events: Array<
      | { kind: 'log'; message: string }
      | { kind: 'done' }
      | { kind: 'error'; message: string }
    > = []

    void launchProviderRun(request, {
      onSession: () => undefined,
      onDelta: () => undefined,
      onLog: (message) => {
        events.push({ kind: 'log', message })
      },
      onAssistantMessage: () => undefined,
      onActivity: () => undefined,
      onDone: () => {
        events.push({ kind: 'done' })
        resolve(events)
      },
      onError: (message) => {
        events.push({ kind: 'error', message })
        resolve(events)
      },
    }).then((child) => {
      if (!child) {
        reject(new Error('Expected fake provider command to launch.'))
      }
    }).catch(reject)
  })

const buildFakeCodexAppServerScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    'const rejectUnsupported = (request, keys) => {',
    '  if (keys.some((key) => hasOwn(request.params, key))) {',
    "    reply({ id: request.id, error: { message: 'thread/start.persistFullHistory requires experimentalApi capability' } })",
    '    return true',
    '  }',
    '  return false',
    '}',
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    if (rejectUnsupported(request, ['persistExtendedHistory', 'experimentalRawEvents'])) {",
    '      return',
    '    }',
    "    reply({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'thread/resume' && request.id) {",
    "    if (rejectUnsupported(request, ['persistExtendedHistory'])) {",
    '      return',
    '    }',
    "    reply({ id: request.id, result: { thread: { id: request.params.threadId, status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexSafetyHandshakeScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "let trusted = false",
    "appendMessage({ kind: 'startup', argv: process.argv.slice(2), env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, hookCommand: process.env.CHILL_VIBE_CODEX_SAFETY_HOOK_COMMAND } })",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    "  if (!line.trim()) return",
    "  const request = JSON.parse(line)",
    "  appendMessage(request)",
    "  if (request.method === 'initialize' && request.id) { reply({ id: request.id, result: {} }); return }",
    "  if (request.method === 'hooks/list' && request.id) {",
    "    reply({ id: request.id, result: { data: [{ cwd: request.params.cwds[0], hooks: [{ key: '<session-flags>/config.toml:pre_tool_use:0:0', eventName: 'pre_tool_use', handlerType: 'command', isManaged: false, matcher: 'Bash|apply_patch|Edit|Write', command: process.env.CHILL_VIBE_CODEX_SAFETY_HOOK_COMMAND, timeoutSec: 5, statusMessage: 'Chill Vibe safety check', sourcePath: '<session-flags>/config.toml', source: 'sessionFlags', pluginId: null, displayOrder: 0, enabled: true, currentHash: 'sha256:chill-vibe-safety', trustStatus: trusted ? 'trusted' : 'untrusted' }], warnings: [], errors: [] }] } })",
    "    return",
    "  }",
    "  if (request.method === 'config/batchWrite' && request.id) { trusted = true; reply({ id: request.id, result: { status: 'ok' } }); return }",
    "  if (request.method === 'thread/start' && request.id) { reply({ id: request.id, result: { thread: { id: 'thread-safety', status: { type: 'active' } } } }); return }",
    "  if (request.method === 'turn/start' && request.id) { reply({ id: request.id, result: {} }); reply({ method: 'turn/completed', params: {} }) }",
    "})",
  ].join('\n')

const buildFakeCodexArchiveRecallScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "appendMessage({ kind: 'startup', argv: process.argv.slice(2) })",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexIdleResumeScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/resume' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: request.params.threadId, status: { type: 'idle' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexActiveResumeScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/resume' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: request.params.threadId, status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexEmptyRolloutResumeScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/resume' && request.id) {",
    "    reply({ id: request.id, error: { message: 'failed to load rollout C:\\\\Users\\\\tester\\\\.codex\\\\sessions\\\\2026\\\\04\\\\17\\\\rollout-stale.jsonl: empty session file' } })",
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-fresh', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')


const buildFakeCodexMissingSessionPathResumeScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\n`, "utf8")',
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/resume' && request.id) {",
    "    reply({ id: request.id, error: { message: 'No session path found for thread id stale-rollout-session' } })",
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-fresh', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexNoRolloutFoundResumeScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/resume' && request.id) {",
    "    reply({ id: request.id, error: { message: 'no rollout found for thread id 082eba38-c11f-4a90-b577-54bc312faac3' } })",
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-fresh', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexDeltaThenAssistantMessageScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'First paragraph Second paragraph' } })",
    "    reply({ method: 'item/completed', params: { item: { id: 'assistant-item-1', type: 'agentMessage', text: 'First paragraph\\n\\nSecond paragraph' } } })",
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexDeltaWhitespaceChunksScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'First paragraph' } })",
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: '\\n\\n' } })",
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'Second paragraph' } })",
    "    reply({ method: 'item/completed', params: { item: { id: 'assistant-item-1', type: 'agentMessage', text: 'First paragraph\\n\\nSecond paragraph' } } })",
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexCommentaryDeltaScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    `    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: ${JSON.stringify('{"commentary":[{"text":"先确认 JSON 结构，再精确读取锻炉和候选效果。"}]}')} } })`,
    `    reply({ method: 'item/completed', params: { item: { id: 'assistant-item-1', type: 'agentMessage', text: ${JSON.stringify('{"commentary":[{"text":"先确认 JSON 结构，再精确读取锻炉和候选效果。"}]}')} } } })`,
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexDuplicateCompactionScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    "    reply({ method: 'item/completed', params: { item: { id: 'compact-item-1', type: 'contextCompaction' } } })",
    "    reply({ method: 'thread/compacted', params: { turnId: 'turn-1' } })",
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexLegacyAppServerScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    "const argv = process.argv.slice(2)",
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "if (argv.includes('--listen')) {",
    "  process.stderr.write(\"error: unexpected argument '--listen' found\\n\")",
    "  process.exit(2)",
    '}',
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-legacy', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexLegacyTurnEffortScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-turn-effort-legacy', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    "    if (hasOwn(request.params, 'effort')) {",
    "      reply({ id: request.id, error: { message: 'turn/start.effort requires newer Codex CLI support' } })",
    '      return',
    '    }',
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexLegacyAgentParamsScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key)",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) return',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    "    if (hasOwn(request.params, 'personality') || hasOwn(request.params, 'serviceTier')) {",
    "      reply({ id: request.id, error: { message: 'turn/start.personality requires newer Codex CLI support' } })",
    '      return',
    '    }',
    '    reply({ id: request.id, result: {} })',
    "    reply({ method: 'turn/completed', params: {} })",
    '  }',
    '})',
  ].join('\n')

const buildFakeClaudeLegacyEffortScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    "const argv = process.argv.slice(2)",
    "fs.appendFileSync(capturePath, `${JSON.stringify(argv)}\\n`, 'utf8')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "if (argv.includes('--effort')) {",
    "  process.stderr.write(\"error: unknown option '--effort'\\n\")",
    '  process.exit(1)',
    '}',
    "reply({ type: 'assistant', message: { content: [{ type: 'text', text: 'Legacy fallback reply' }] } })",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')

const buildFakeClaudeStaleSessionScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    "const argv = process.argv.slice(2)",
    "fs.appendFileSync(capturePath, `${JSON.stringify(argv)}\\n`, 'utf8')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "if (argv.includes('-r')) {",
    "  process.stderr.write('Error: No deferred tool marker found in the resumed session. Either the session was not deferred, the marker is stale (tool already ran), or it exceeds the tail-scan window. Provide a prompt to continue the conversation.\\n')",
    '  process.exit(1)',
    '}',
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-recovered' })",
    "reply({ type: 'assistant', message: { content: [{ type: 'text', text: 'Recovered reply' }] } })",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')


const buildFakeClaudeCapturePromptScript = (capturePath: string) =>
  [
    "const fs = require('node:fs')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    "const argv = process.argv.slice(2)",
    "fs.appendFileSync(capturePath, `${JSON.stringify(argv)}\\n`, 'utf8')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-capture' })",
    "reply({ type: 'assistant', message: { content: [{ type: 'text', text: 'Captured prompt' }] } })",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')

const buildFakeClaudeAskUserToolWithProseScript = () =>
  [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)",
    "reply({",
    "  type: 'assistant',",
    "  message: {",
    "    id: 'msg_ask_user_tool_prose',",
    "    content: [",
    "      { type: 'text', text: 'I reviewed the previous work and found the risky path.' },",
    "      {",
    "        type: 'tool_use',",
    "        id: 'toolu_ask_user_prose',",
    "        name: 'AskUserQuestion',",
    "        input: {",
    "          questions: [",
    "            {",
    "              header: 'Confirmation',",
    "              question: 'Which path should I use?',",
    "              multiSelect: false,",
    "              options: [",
    "                { label: 'Patch now', description: 'Keep the smallest diff.' },",
    "                { label: 'Refactor first', description: 'Clean the flow before patching.' },",
    "              ],",
    "            },",
    "          ],",
    "        },",
    "      },",
    "    ],",
    "  },",
    "})",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')

const buildFakeClaudeAskUserXmlScript = () =>
  [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "reply({",
    "  type: 'assistant',",
    "  message: {",
    "    id: 'msg_ask_user_xml',",
    "    content: [",
    "      {",
    "        type: 'text',",
    "        text: '<ask-user-question>{\"header\":\"Confirmation\",\"question\":\"Which path should I use?\",\"multiSelect\":false,\"options\":[{\"label\":\"Delete normally\",\"description\":\"Delete only the current skill.\"},{\"label\":\"Check impact first\",\"description\":\"Inspect remotes and refs before deciding.\"}]}</ask-user-question>'",
    '      },',
    '    ],',
    '  },',
    '})',
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')

const buildFakeClaudeAskUserXmlPartialStreamScript = () => {
  const fullXml =
    '<ask-user-question>{"header":"Confirmation","question":"Which path should I use?","multiSelect":false,"options":[{"label":"Delete normally","description":"Delete only the current skill."},{"label":"Check impact first","description":"Inspect remotes and refs before deciding."}]}</ask-user-question>'
  // Split the XML into uneven chunks to mimic real char-by-char partial-message
  // streaming where the tag boundaries land mid-chunk.
  const chunks = [
    fullXml.slice(0, 5),
    fullXml.slice(5, 18),
    fullXml.slice(18, 60),
    fullXml.slice(60, fullXml.length - 12),
    fullXml.slice(fullXml.length - 12),
  ]

  return [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    `const chunks = ${JSON.stringify(chunks)}`,
    `const fullXml = ${JSON.stringify(fullXml)}`,
    "for (const text of chunks) {",
    "  reply({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })",
    '}',
    // Real Claude CLI follows partial-message deltas with the complete assistant
    // message carrying the same text; the ask-user card is parsed from it.
    "reply({ type: 'assistant', message: { id: 'msg_ask_user', content: [{ type: 'text', text: fullXml }] } })",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')
}

const buildFakeClaudeProseThenAskUserXmlPartialStreamScript = () => {
  const prose = 'Here is the context before I ask. '
  const fullXml =
    '<ask-user-question>{"header":"Confirmation","question":"Which path should I use?","multiSelect":false,"options":[{"label":"Delete normally","description":"Delete only the current skill."},{"label":"Check impact first","description":"Inspect remotes and refs before deciding."}]}</ask-user-question>'
  const combined = `${prose}${fullXml}`
  const chunks = [
    combined.slice(0, 12),
    combined.slice(12, prose.length + 4),
    combined.slice(prose.length + 4, prose.length + 50),
    combined.slice(prose.length + 50, combined.length - 8),
    combined.slice(combined.length - 8),
  ]

  return [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    `const chunks = ${JSON.stringify(chunks)}`,
    `const combined = ${JSON.stringify(combined)}`,
    "for (const text of chunks) {",
    "  reply({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })",
    '}',
    "reply({ type: 'assistant', message: { id: 'msg_ask_user', content: [{ type: 'text', text: combined }] } })",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')
}

const buildFakeCodexRecoverableDisconnectScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-recoverable', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'Reconnecting 1/5' } })",
    '    process.exit(0)',
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexSilentAfterTurnStartScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-silent-stall', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    '    setInterval(() => {}, 1000)',
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexRecoverableReconnectLoopScript = (capturePath: string, exitCode = 0) =>
  [
    "const fs = require('node:fs')",
    "const readline = require('node:readline')",
    `const capturePath = ${JSON.stringify(capturePath)}`,
    `const exitCode = ${JSON.stringify(exitCode)}`,
    'const appendMessage = (message) => fs.appendFileSync(capturePath, `${JSON.stringify(message)}\\n`, "utf8")',
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    '  appendMessage(request)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-loop', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'Reconnecting... 1/5' } })",
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'Reconnecting... 2/5' } })",
    '    process.exit(exitCode)',
    '  }',
    '})',
  ].join('\n')


const buildFakeCodexReconnectPlaceholderCompletedScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-placeholder-done', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'Reconnecting... 1/5' } })",
    "    reply({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })",
    '    return',
    '  }',
    '})',
  ].join('\n')



const buildFakeCodexChunkedReconnectPlaceholderCompletedScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-placeholder-chunked-done', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    for (const delta of ['Reconnect', 'ing', '... ', '1', '/', '5']) {",
    "      reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta } })",
    '    }',
    "    reply({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })",
    '    return',
    '  }',
    '})',
  ].join('\n')


const buildFakeCodexReconnectPlaceholderItemCompletedScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-placeholder-item-done', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'item/completed', params: { item: { id: 'assistant-item-1', type: 'agentMessage', text: 'Reconnecting... 1/5' } } })",
    "    reply({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })",
    '    return',
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexReconnectPlaceholderStallScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-placeholder-stall', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'Reconnecting... 1/5' } })",
    '    return',
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexCommandThenReconnectPlaceholderScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-command-reconnect', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    "    reply({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } } })",
    "    reply({ method: 'item/started', params: { item: { id: 'cmd-1', type: 'command_execution', status: 'in_progress', command: 'pnpm test' } } })",
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'Reconnecting... 1/5' } })",
    '    setInterval(() => {}, 1000)',
    '    return',
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexAssistantThenReconnectPlaceholderScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-assistant-reconnect', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    "    reply({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } } })",
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'I started real work.' } })",
    "    reply({ method: 'item/completed', params: { item: { id: 'assistant-item-1', type: 'agentMessage', text: 'I started real work.' } } })",
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-2', delta: 'Reconnecting... 1/5' } })",
    '    setInterval(() => {}, 1000)',
    '    return',
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexStderrOnlyReconnectPlaceholderScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-stderr-placeholder', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    "    reply({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } } })",
    "    process.stderr.write('Reconnecting... 1/5\\n')",
    '    process.exit(0)',
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexJsonRpcReconnectPlaceholderErrorScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-jsonrpc-placeholder', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    "    reply({ id: request.id, error: { code: -32000, message: 'Reconnecting... 1/5' } })",
    '  }',
    '})',
  ].join('\n')


const buildFakeCodexCapacityErrorAfterSessionScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-capacity', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    "    reply({ id: request.id, error: { code: -32000, message: 'Selected model is at capacity. Please try a different model.' } })",
    '  }',
    '})',
  ].join('\n')

const buildFakeCodexThirdPartyExtraUsage403AfterSessionScript = () =>
  [
    "const readline = require('node:readline')",
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "rl.on('line', (line) => {",
    '  if (!line.trim()) {',
    '    return',
    '  }',
    '  const request = JSON.parse(line)',
    "  if (request.method === 'initialize' && request.id) {",
    '    reply({ id: request.id, result: {} })',
    '    return',
    '  }',
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-extra-usage-403', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    "    reply({ id: request.id, error: { code: -32000, message: 'Failed to authenticate. API Error: 403 {\"error\":{\"message\":\"Third-party apps now draw from your extra usage, not your plan limits. We\\'ve added a $200 credit to get you started. Claim it at ***.ai/settings/usage and keep going.\",\"type\":\"<nil>\"},\"type\":\"error\"}' } })",
    '  }',
    '})',
  ].join('\n')


const buildFakeClaudeCapacityErrorAfterSessionScript = () =>
  [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)",
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-capacity' })",
    "reply({ type: 'result', is_error: true, result: 'Selected model is at capacity. Please try a different model.' })",
  ].join('\n')

const buildFakeClaudeRecoverableDisconnectScript = () =>
  [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-recoverable' })",
    "reply({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reconnecting 1/5' }] } })",
    'process.exit(0)',
  ].join('\n')



test('codex app-server capacity errors after session creation are resumable', async () => {
  const outcome = await withFakeProviderCommand(
    'codex',
    buildFakeCodexCapacityErrorAfterSessionScript(),
    async (workspacePath) =>
      captureProviderRecoveryFailure(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(outcome, {
    kind: 'error',
    message: 'Selected model is at capacity. Please try a different model.',
    recovery: {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  })
})

test('codex app-server third-party extra-usage 403 after session creation is resumable', async () => {
  const outcome = await withFakeProviderCommand(
    'codex',
    buildFakeCodexThirdPartyExtraUsage403AfterSessionScript(),
    async (workspacePath) =>
      captureProviderRecoveryFailure(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(outcome, {
    kind: 'error',
    message:
      'Failed to authenticate. API Error: 403 {"error":{"message":"Third-party apps now draw from your extra usage, not your plan limits. We\'ve added a $200 credit to get you started. Claim it at ***.ai/settings/usage and keep going.","type":"<nil>"},"type":"error"}',
    recovery: {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  })
})

test('codex app-server placeholder-only turn completion is recoverable instead of done', async () => {
  const outcome = await withFakeProviderCommand(
    'codex',
    buildFakeCodexReconnectPlaceholderCompletedScript(),
    async (workspacePath) =>
      captureProviderRecoveryFailure(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(outcome, {
    kind: 'error',
    message: 'Codex produced only transient reconnect placeholders before completion.',
    recovery: {
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
    },
  })
})



test('codex app-server chunked placeholder-only turn completion is recoverable instead of done', async () => {
  const outcome = await withFakeProviderCommand(
    'codex',
    buildFakeCodexChunkedReconnectPlaceholderCompletedScript(),
    async (workspacePath) =>
      captureProviderRecoveryFailure(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(outcome, {
    kind: 'error',
    message: 'Codex produced only transient reconnect placeholders before completion.',
    recovery: {
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
    },
  })
})

test('codex app-server placeholder-only stalls are failed fast as recoverable transient resumes', async () => {
  const originalPlaceholderTimeout = process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
  process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = '60'

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexReconnectPlaceholderStallScript(),
      async (workspacePath) =>
        captureProviderRecoveryFailure(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
        ),
    )

    assert.deepEqual(outcome, {
      kind: 'error',
      message: 'Codex stalled after producing only transient reconnect placeholders.',
      recovery: {
        recoverable: true,
        recoveryMode: 'resume-session',
        transientOnly: true,
      },
    })
  } finally {
    if (typeof originalPlaceholderTimeout === 'string') {
      process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = originalPlaceholderTimeout
    } else {
      delete process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
    }
  }
})

test('codex app-server silent stalls fail fast as recoverable resumes', async () => {
  const originalLocalFirstByteTimeout = process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS
  const originalLocalStallTimeout = process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS
  process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS = '200'
  process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS = '200'

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexSilentAfterTurnStartScript(),
      async (workspacePath) =>
        captureProviderRecoveryFailureWithin(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
          1000,
        ),
    )

    assert.deepEqual(outcome, {
      kind: 'error',
      message: 'Codex stalled without emitting stream output.',
      recovery: {
        recoverable: true,
        recoveryMode: 'resume-session',
      },
    })
  } finally {
    if (typeof originalLocalFirstByteTimeout === 'string') {
      process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS = originalLocalFirstByteTimeout
    } else {
      delete process.env.CHILL_VIBE_LOCAL_PROVIDER_FIRST_BYTE_TIMEOUT_MS
    }

    if (typeof originalLocalStallTimeout === 'string') {
      process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS = originalLocalStallTimeout
    } else {
      delete process.env.CHILL_VIBE_LOCAL_PROVIDER_STALL_TIMEOUT_MS
    }
  }
})


test('codex app-server emits a local disconnect stats event when native reconnect placeholders appear', async () => {
  const originalPlaceholderTimeout = process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
  process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = '1000'

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexCommandThenReconnectPlaceholderScript(),
      async (workspacePath) =>
        captureProviderStatsWithin(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
          2000,
        ),
    )

    assert.deepEqual(outcome, {
      kind: 'stats',
      event: 'disconnect',
      endpoint: '/cli/local-stream',
      errorType: 'native-reconnect-placeholder',
      alreadyRecorded: true,
    })
  } finally {
    if (typeof originalPlaceholderTimeout === 'string') {
      process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = originalPlaceholderTimeout
    } else {
      delete process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
    }
  }
})

test('codex app-server counts native reconnect placeholders after real assistant output', async () => {
  const originalPlaceholderTimeout = process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
  process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = '1000'

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAssistantThenReconnectPlaceholderScript(),
      async (workspacePath) =>
        captureProviderStatsWithin(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
          2000,
        ),
    )

    assert.deepEqual(outcome, {
      kind: 'stats',
      event: 'disconnect',
      endpoint: '/cli/local-stream',
      errorType: 'native-reconnect-placeholder',
      alreadyRecorded: true,
    })
  } finally {
    if (typeof originalPlaceholderTimeout === 'string') {
      process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = originalPlaceholderTimeout
    } else {
      delete process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
    }
  }
})

test('codex app-server auto-recovers when native reconnect stalls after real assistant output', async () => {
  const originalPlaceholderTimeout = process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
  process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = '60'

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAssistantThenReconnectPlaceholderScript(),
      async (workspacePath) =>
        captureProviderRecoveryFailureWithin(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
          1000,
        ),
    )

    assert.deepEqual(outcome, {
      kind: 'error',
      message: 'Codex stalled after native reconnect placeholders interrupted the stream.',
      recovery: {
        recoverable: true,
        recoveryMode: 'resume-session',
      },
    })
  } finally {
    if (typeof originalPlaceholderTimeout === 'string') {
      process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = originalPlaceholderTimeout
    } else {
      delete process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
    }
  }
})


test('codex app-server suppresses native reconnect placeholder assistant messages', async () => {
  const events = await withFakeProviderCommand(
    'codex',
    buildFakeCodexReconnectPlaceholderItemCompletedScript(),
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.equal(events.some((event) => event.kind === 'delta' && /Reconnecting/i.test(event.content)), false)
  assert.equal(events.some((event) => event.kind === 'assistant_message' && /Reconnecting/i.test(event.content)), false)
  assert.deepEqual(events.at(-1), {
    kind: 'error',
    message: 'Codex produced only transient reconnect placeholders before completion.',
  })
})

test('codex app-server does not surface stderr-only native reconnect placeholders as final errors', async () => {
  const outcome = await withFakeProviderCommand(
    'codex',
    buildFakeCodexStderrOnlyReconnectPlaceholderScript(),
    async (workspacePath) =>
      captureProviderRecoveryFailureWithin(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
        1000,
      ),
  )

  assert.notEqual(outcome.kind, 'timeout')
  if (outcome.kind === 'error') {
    assert.doesNotMatch(outcome.message, /Reconnecting/i)
    assert.equal(outcome.recovery.recoverable, true)
  }
})

test('codex app-server suppresses native reconnect placeholders from visible deltas', async () => {
  const events = await withFakeProviderCommand(
    'codex',
    buildFakeCodexReconnectPlaceholderCompletedScript(),
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.equal(events.some((event) => event.kind === 'delta' && /Reconnecting/i.test(event.content)), false)
  assert.equal(events.some((event) => event.kind === 'assistant_message' && /Reconnecting/i.test(event.content)), false)
})

test('codex native reconnect detector covers the exact screenshot placeholder', () => {
  assert.equal(isCodexNativeReconnectPlaceholderForTesting('Reconnecting... 1/5'), true)
  assert.equal(isCodexNativeReconnectPlaceholderForTesting('Reconnecting\u2026 1/5'), true)
  assert.equal(isCodexNativeReconnectPlaceholderForTesting('Reconnecting 1/5'), true)
  assert.equal(isCodexNativeReconnectPlaceholderForTesting('Reconnecting because the network is down'), false)
})

test('codex app-server does not surface JSON-RPC reconnect placeholder errors as final errors', async () => {
  const outcome = await withFakeProviderCommand(
    'codex',
    buildFakeCodexJsonRpcReconnectPlaceholderErrorScript(),
    async (workspacePath) =>
      captureProviderRecoveryFailure(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(outcome, {
    kind: 'error',
    message: 'Codex produced only transient reconnect placeholders before completion.',
    recovery: {
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
    },
  })
})

test('codex app-server suppresses JSON-RPC reconnect placeholder errors from all visible events', async () => {
  const events = await withFakeProviderCommand(
    'codex',
    buildFakeCodexJsonRpcReconnectPlaceholderErrorScript(),
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.equal(events.some((event) => event.kind === 'delta' && /Reconnecting/i.test(event.content)), false)
  assert.equal(events.some((event) => event.kind === 'assistant_message' && /Reconnecting/i.test(event.content)), false)
  const finalError = events.find((event) => event.kind === 'error')
  assert.ok(finalError)
  assert.doesNotMatch(finalError.message, /Reconnecting/i)
})

test('codex app-server records JSON-RPC reconnect placeholder errors as disconnect stats', async () => {
  const outcome = await withFakeProviderCommand(
    'codex',
    buildFakeCodexJsonRpcReconnectPlaceholderErrorScript(),
    async (workspacePath) => {
      const { proxyStats } = await import('../server/proxy-stats-store.ts')
      proxyStats.reset()

      const statsEvent = await captureProviderStatsWithin(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
        2000,
      )

      return {
        statsEvent,
        stats: proxyStats.getStats(),
      }
    },
  )

  assert.deepEqual(outcome.statsEvent, {
    kind: 'stats',
    event: 'disconnect',
    endpoint: '/cli/local-stream',
    errorType: 'native-reconnect-placeholder',
    alreadyRecorded: true,
  })
  assert.equal(outcome.stats.history.disconnects, 1)
  assert.equal(outcome.stats.currentSession.disconnects, 1)
})

test('codex app-server records stderr-only native reconnect placeholders as disconnect stats', async () => {
  const originalPlaceholderTimeout = process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
  process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = '1000'

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexStderrOnlyReconnectPlaceholderScript(),
      async (workspacePath) => {
        const { proxyStats } = await import('../server/proxy-stats-store.ts')
        proxyStats.reset()

        const statsEvent = await captureProviderStatsWithin(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
          2000,
        )

        return {
          statsEvent,
          stats: proxyStats.getStats(),
        }
      },
    )

    assert.deepEqual(outcome.statsEvent, {
      kind: 'stats',
      event: 'disconnect',
      endpoint: '/cli/local-stream',
      errorType: 'native-reconnect-placeholder',
      alreadyRecorded: true,
    })
    assert.equal(outcome.stats.history.disconnects, 1)
    assert.equal(outcome.stats.currentSession.disconnects, 1)
  } finally {
    if (typeof originalPlaceholderTimeout === 'string') {
      process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = originalPlaceholderTimeout
    } else {
      delete process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
    }
  }
})

test('codex app-server records native reconnect stats in the backend store immediately', async () => {
  const originalPlaceholderTimeout = process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
  process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = '1000'

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexCommandThenReconnectPlaceholderScript(),
      async (workspacePath) => {
        const { proxyStats } = await import('../server/proxy-stats-store.ts')
        proxyStats.reset()

        const statsEvent = await captureProviderStatsWithin(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
          2000,
        )

        return {
          statsEvent,
          stats: proxyStats.getStats(),
        }
      },
    )

    assert.deepEqual(outcome.statsEvent, {
      kind: 'stats',
      event: 'disconnect',
      endpoint: '/cli/local-stream',
      errorType: 'native-reconnect-placeholder',
      alreadyRecorded: true,
    })
    assert.equal(outcome.stats.history.disconnects, 1)
    assert.equal(outcome.stats.currentSession.disconnects, 1)
    assert.equal(outcome.stats.entries.at(-1)?.event, 'disconnect')
    assert.equal(outcome.stats.entries.at(-1)?.errorType, 'native-reconnect-placeholder')
  } finally {
    if (typeof originalPlaceholderTimeout === 'string') {
      process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = originalPlaceholderTimeout
    } else {
      delete process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
    }
  }
})

test('codex app-server treats native reconnect placeholders as recoverable even after command activity', async () => {
  const originalPlaceholderTimeout = process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
  process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = '60'

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexCommandThenReconnectPlaceholderScript(),
      async (workspacePath) =>
        captureProviderRecoveryFailureWithin(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
          1000,
        ),
    )

    assert.deepEqual(outcome, {
      kind: 'error',
      message: 'Codex stalled after producing only transient reconnect placeholders.',
      recovery: {
        recoverable: true,
        recoveryMode: 'resume-session',
        transientOnly: true,
      },
    })
  } finally {
    if (typeof originalPlaceholderTimeout === 'string') {
      process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS = originalPlaceholderTimeout
    } else {
      delete process.env.CHILL_VIBE_TRANSIENT_PLACEHOLDER_TIMEOUT_MS
    }
  }
})

test('codex zero-exit without turn.completed is treated as a failed run', async () => {
  const outcome = await withFakeProviderCommand(
    'codex',
    `process.stdout.write('${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'git status --short',
        aggregated_output: 'M src/App.tsx',
        exit_code: 0,
        status: 'completed',
      },
    })}\\n')`,
    async (workspacePath) =>
      captureProviderOutcome(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(outcome, {
    kind: 'error',
    message: 'Codex ended without emitting a terminal completion event.',
  })
})

test('codex zero-exit after emitting a live session is still marked recoverable', async () => {
  const outcome = await withFakeProviderCommand(
    'codex',
    buildFakeCodexRecoverableDisconnectScript(),
    async (workspacePath) =>
      captureProviderRecoveryFailure(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(outcome, {
    kind: 'error',
    message: 'Codex ended without emitting a terminal completion event.',
    recovery: {
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
    },
  })
})

test('codex app-server reconnect-only zero-exit stays recoverable after CLI retries are exhausted', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-reconnect-loop-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const events = await withFakeProviderCommand(
      'codex',
      buildFakeCodexRecoverableReconnectLoopScript(capturePath),
      async (workspacePath) =>
        captureProviderRecoveryFailure(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
        ),
    )

    assert.deepEqual(events, {
      kind: 'error',
      message: 'Codex ended without emitting a terminal completion event.',
      recovery: {
        recoverable: true,
        recoveryMode: 'resume-session',
        transientOnly: true,
      },
    })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .filter((request) => request.method === 'turn/start')

    assert.equal(requests.length, 1)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})


test('codex app-server reconnect-only nonzero exit is recoverable and transient-only', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-reconnect-nonzero-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const events = await withFakeProviderCommand(
      'codex',
      buildFakeCodexRecoverableReconnectLoopScript(capturePath, 1),
      async (workspacePath) =>
        captureProviderRecoveryFailure(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
        ),
    )

    assert.deepEqual(events, {
      kind: 'error',
      message: 'Codex exited with status code: 1',
      recovery: {
        recoverable: true,
        recoveryMode: 'resume-session',
        transientOnly: true,
      },
    })
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('claude zero-exit without result is treated as a failed run', async () => {
  const outcome = await withFakeProviderCommand(
    'claude',
    `process.stdout.write('${JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Partial answer' }],
      },
    })}\\n')`,
    async (workspacePath) =>
      captureProviderOutcome(
        createRequest({
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(outcome, {
    kind: 'error',
    message: 'Claude ended without emitting a terminal completion event.',
  })
})


test('claude capacity errors after session creation are resumable', async () => {
  const outcome = await withFakeProviderCommand(
    'claude',
    buildFakeClaudeCapacityErrorAfterSessionScript(),
    async (workspacePath) =>
      captureProviderRecoveryFailure(
        createRequest({
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(outcome, {
    kind: 'error',
    message: 'Selected model is at capacity. Please try a different model.',
    recovery: {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  })
})

test('claude zero-exit after emitting a live session is still marked recoverable', async () => {
  const outcome = await withFakeProviderCommand(
    'claude',
    buildFakeClaudeRecoverableDisconnectScript(),
    async (workspacePath) =>
      captureProviderRecoveryFailure(
        createRequest({
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(outcome, {
    kind: 'error',
    message: 'Claude ended without emitting a terminal completion event.',
    recovery: {
      recoverable: true,
      recoveryMode: 'resume-session',
    },
  })
})

test('claude automatically retries without --effort for older CLIs and logs the upgrade hint', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-claude-effort-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const events = await withFakeProviderCommand(
      'claude',
      buildFakeClaudeLegacyEffortScript(capturePath),
      async (workspacePath) =>
        captureProviderLogs(
          createRequest({
            provider: 'claude',
            model: 'claude-sonnet-4-6',
            language: 'en',
            workspacePath,
          }),
        ),
    )

    assert.deepEqual(events, [
      {
        kind: 'log',
        message:
          'Detected an older local Claude CLI that does not support --effort. Chill Vibe retried automatically without that flag. Please upgrade Claude CLI with: npm update -g @anthropic-ai/claude-code',
      },
      { kind: 'done' },
    ])

    const launches = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[])

    assert.equal(launches.length, 2)
    assert.ok(launches[0].includes('--effort'))
    assert.ok(!launches[1].includes('--effort'))
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('claude automatically retries without -r when the resumed session is stale and logs the recovery hint', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-claude-stale-session-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const events = await withFakeProviderCommand(
      'claude',
      buildFakeClaudeStaleSessionScript(capturePath),
      async (workspacePath) =>
        captureProviderLogs(
          createRequest({
            provider: 'claude',
            model: 'claude-sonnet-4-6',
            language: 'en',
            workspacePath,
            sessionId: 'stale-session-id',
            prompt: 'Analyze this image.',
          }),
        ),
    )

    const doneIndex = events.findIndex((event) => event.kind === 'done')
    assert.notEqual(doneIndex, -1, `expected a terminal done event, got ${JSON.stringify(events)}`)
    assert.ok(
      events.some(
        (event) => event.kind === 'log' && /stale|resumed session|new session/i.test(event.message),
      ),
      `expected a stale-session recovery log, got ${JSON.stringify(events)}`,
    )

    const launches = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[])

    assert.equal(launches.length, 2, `expected two CLI launches (initial + retry), got ${launches.length}`)
    assert.ok(launches[0].includes('-r'), 'initial launch should resume the session')
    assert.ok(launches[0].includes('stale-session-id'), 'initial launch should carry the stale id')
    assert.ok(!launches[1].includes('-r'), 'retry launch must drop -r to fork a fresh session')
    assert.ok(!launches[1].includes('stale-session-id'), 'retry launch must not reuse the stale id')
    // prompt and attachment intent must survive into the retry
    assert.ok(
      launches[1].some((arg) => typeof arg === 'string' && arg.includes('Analyze this image.')),
      `retry launch must preserve the original prompt, got ${JSON.stringify(launches[1])}`,
    )
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})


test('claude assistant tool_use messages do not leak bare call protocol markers as deltas', async () => {
  const script = [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-tool-call-marker' })",
    "reply({",
    "  type: 'assistant',",
    "  message: {",
    "    id: 'msg_tool_call_marker',",
    "    content: [",
    "      { type: 'text', text: 'call:' },",
    "      {",
    "        type: 'tool_use',",
    "        id: 'toolu_read_marker',",
    "        name: 'Read',",
    "        input: { file_path: 'src/App.tsx' },",
    "      },",
    "    ],",
    "  },",
    "})",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')

  const events = await withFakeProviderCommand(
    'claude',
    script,
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'claude',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.equal(
    events.some((event) => event.kind === 'delta' && /call\s*:/i.test(event.content)),
    false,
    `bare call marker leaked as delta: ${JSON.stringify(events)}`,
  )
  assert.ok(
    events.some(
      (event) =>
        event.kind === 'activity' &&
        event.activity.kind === 'tool' &&
        event.activity.toolName === 'Read',
    ),
    `expected native Read tool activity, got ${JSON.stringify(events)}`,
  )
})

test('claude final assistant text tool-call XML is stripped and resumes instead of ending on count', async () => {
  const script = [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-final-typed-tool' })",
    "reply({",
    "  type: 'assistant',",
    "  message: {",
    "    id: 'msg_final_typed_tool',",
    "    content: [",
    "      {",
    "        type: 'text',",
    "        text: 'Inspect first.\\n\\n<function_calls>\\n  <invoke name=\"Grep\">\\n    <parameter name=\"output_mode\">count',",
    "      },",
    "    ],",
    "  },",
    "})",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')

  const events = await withFakeProviderCommand(
    'claude',
    script,
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'claude',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  const visibleText = events
    .filter((event) => event.kind === 'delta')
    .map((event) => event.content)
    .join('')

  assert.match(visibleText, /Inspect first\./)
  assert.doesNotMatch(visibleText, /count|parameter|function_calls|invoke/i)
  assert.ok(
    events.some(
      (event) =>
        event.kind === 'error' &&
        /without running its tool call/i.test(event.message),
    ),
    `expected resumable typed-tool-call error, got ${JSON.stringify(events)}`,
  )
  assert.equal(
    events.some((event) => event.kind === 'done'),
    false,
    `typed tool-call turn should not end cleanly: ${JSON.stringify(events)}`,
  )
})

test('claude malformed tool-call retry chatter is hidden while the session auto-resumes', async () => {
  const script = [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-hidden-typed-tool-chatter' })",
    "reply({",
    "  type: 'assistant',",
    "  message: {",
    "    id: 'msg_hidden_typed_tool_chatter',",
    "    content: [",
    "      {",
    "        type: 'text',",
    "        text: '工具调用格式坏了,我重新发。\\n\\n<invoke name=\"Grep\"><parameter name=\"output_mode\">count',",
    "      },",
    "    ],",
    "  },",
    "})",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')

  const events = await withFakeProviderCommand(
    'claude',
    script,
    async (workspacePath) =>
      Promise.all([
        captureProviderEvents(
          createRequest({
            provider: 'claude',
            language: 'zh-CN',
            workspacePath,
          }),
        ),
        captureProviderRecoveryFailure(
          createRequest({
            provider: 'claude',
            language: 'zh-CN',
            workspacePath,
          }),
        ),
      ]).then(([visibleEvents, recoveryFailure]) => ({ visibleEvents, recoveryFailure })),
  )

  const visibleText = events.visibleEvents
    .filter((event) => event.kind === 'delta')
    .map((event) => event.content)
    .join('')

  assert.doesNotMatch(visibleText, /工具调用|重新发|count|parameter|invoke/i)
  assert.deepEqual(events.recoveryFailure.recovery, {
    recoverable: true,
    recoveryMode: 'resume-session',
  })
})

test('claude malformed tool-call retry chatter remains hidden in ordinary event capture', async () => {
  const script = [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-hidden-typed-tool-chatter-events' })",
    "reply({",
    "  type: 'assistant',",
    "  message: {",
    "    id: 'msg_hidden_typed_tool_chatter_events',",
    "    content: [",
    "      {",
    "        type: 'text',",
    "        text: '工具调用格式坏了,我重新发。\\n\\n<invoke name=\"Grep\"><parameter name=\"output_mode\">count',",
    "      },",
    "    ],",
    "  },",
    "})",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')

  const events = await withFakeProviderCommand(
    'claude',
    script,
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'claude',
          language: 'zh-CN',
          workspacePath,
        }),
      ),
  )

  const visibleText = events
    .filter((event) => event.kind === 'delta')
    .map((event) => event.content)
    .join('')

  assert.doesNotMatch(visibleText, /工具调用|重新发|count|parameter|invoke/i)
  assert.ok(
    events.some(
      (event) =>
        event.kind === 'error',
    ),
    `expected typed-tool-call error, got ${JSON.stringify(events)}`,
  )
})

test('claude malformed tool-call marker court is hidden with typed XML tool call', async () => {
  const script = [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-hidden-court-marker' })",
    "reply({",
    "  type: 'assistant',",
    "  message: {",
    "    id: 'msg_hidden_court_marker',",
    "    content: [",
    "      {",
    "        type: 'text',",
    "        text: 'grep 没匹配到,可能 types 是多行格式。换个方式查。\\n\\ncourt\\n<invoke name=\"Bash\"><parameter name=\"command\">echo ok</parameter><parameter name=\"description\">提取所有types数组的值并统计</parameter></invoke>',",
    "      },",
    "    ],",
    "  },",
    "})",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')

  const events = await withFakeProviderCommand(
    'claude',
    script,
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'claude',
          language: 'zh-CN',
          workspacePath,
        }),
      ),
  )

  const visibleText = events
    .filter((event) => event.kind === 'delta')
    .map((event) => event.content)
    .join('')

  assert.doesNotMatch(visibleText, /\bcourt\b/i)
  assert.doesNotMatch(visibleText, /parameter|invoke/i)
  assert.ok(
    events.some((event) => event.kind === 'error'),
    `expected typed-tool-call recovery error, got ${JSON.stringify(events)}`,
  )
})

test('claude streamed malformed tool-call marker court is buffered until XML disambiguates', async () => {
  const streamedText =
    'grep 没匹配到,可能 types 是多行格式。换个方式查。\n\n' +
    'court\n' +
    '<invoke name="Bash"><parameter name="command">echo ok</parameter></invoke>'
  const chunks = [
    streamedText.slice(0, 32),
    streamedText.slice(32, 50),
    streamedText.slice(50, 58),
    streamedText.slice(58),
  ]
  const script = [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-streamed-hidden-court-marker' })",
    `const chunks = ${JSON.stringify(chunks)}`,
    "for (const text of chunks) {",
    "  reply({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })",
    "}",
    "reply({ type: 'result', is_error: false, result: 'ok' })",
  ].join('\n')

  const events = await withFakeProviderCommand(
    'claude',
    script,
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'claude',
          language: 'zh-CN',
          workspacePath,
        }),
      ),
  )

  const visibleText = events
    .filter((event) => event.kind === 'delta')
    .map((event) => event.content)
    .join('')

  assert.doesNotMatch(visibleText, /\bcourt\b/i)
  assert.doesNotMatch(visibleText, /parameter|invoke/i)
  assert.ok(
    events.some((event) => event.kind === 'error'),
    `expected typed-tool-call recovery error, got ${JSON.stringify(events)}`,
  )
})

test('claude ask-user tool use keeps prose before the question and then emits the structured activity', async () => {
  const events = await withFakeProviderCommand(
    'claude',
    buildFakeClaudeAskUserToolWithProseScript(),
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(events, [
    { kind: 'delta', content: 'I reviewed the previous work and found the risky path.' },
    {
      kind: 'activity',
      activity: {
        itemId: 'toolu_ask_user_prose',
        kind: 'ask-user',
        status: 'completed',
        header: 'Confirmation',
        question: 'Which path should I use?',
        multiSelect: false,
        nativeTool: true,
        options: [
          { label: 'Patch now', description: 'Keep the smallest diff.' },
          { label: 'Refactor first', description: 'Clean the flow before patching.' },
        ],
      },
    },
    { kind: 'done' },
  ])
})

test('claude ask-user XML emits the interactive activity without leaking the raw XML as a delta', async () => {
  const events = await withFakeProviderCommand(
    'claude',
    buildFakeClaudeAskUserXmlScript(),
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(events, [
    {
      kind: 'activity',
      activity: {
        itemId: 'msg_ask_user_xml',
        kind: 'ask-user',
        status: 'completed',
        header: 'Confirmation',
        question: 'Which path should I use?',
        multiSelect: false,
        options: [
          { label: 'Delete normally', description: 'Delete only the current skill.' },
          { label: 'Check impact first', description: 'Inspect remotes and refs before deciding.' },
        ],
      },
    },
    { kind: 'done' },
  ])
})

test('claude ask-user XML streamed as partial-message deltas does not leak raw XML', async () => {
  const events = await withFakeProviderCommand(
    'claude',
    buildFakeClaudeAskUserXmlPartialStreamScript(),
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  const deltaText = events
    .filter((event): event is { kind: 'delta'; content: string } => event.kind === 'delta')
    .map((event) => event.content)
    .join('')

  assert.equal(
    deltaText.includes('ask-user-question'),
    false,
    `raw ask-user XML leaked into deltas: ${JSON.stringify(deltaText)}`,
  )
  assert.equal(deltaText.includes('<ask-user'), false)
  assert.equal(deltaText.trim(), '')

  const askUserActivity = events.find(
    (event) => event.kind === 'activity' && event.activity.kind === 'ask-user',
  )
  assert.ok(askUserActivity, 'expected an ask-user activity to be emitted')
})

test('claude prose before ask-user XML keeps the prose delta and strips only the XML', async () => {
  const events = await withFakeProviderCommand(
    'claude',
    buildFakeClaudeProseThenAskUserXmlPartialStreamScript(),
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  const deltaText = events
    .filter((event): event is { kind: 'delta'; content: string } => event.kind === 'delta')
    .map((event) => event.content)
    .join('')

  assert.equal(deltaText.includes('ask-user-question'), false)
  assert.equal(deltaText.includes('<ask-user'), false)
  assert.equal(deltaText.trim(), 'Here is the context before I ask.')

  const askUserActivity = events.find(
    (event) => event.kind === 'activity' && event.activity.kind === 'ask-user',
  )
  assert.ok(askUserActivity, 'expected an ask-user activity to be emitted')
})

test('codex app-server retries turn/start without effort when an older CLI rejects that field', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-turn-effort-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const events = await withFakeProviderCommand(
      'codex',
      buildFakeCodexLegacyTurnEffortScript(capturePath),
      async (workspacePath) =>
        captureProviderLogs(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
        ),
    )

    assert.deepEqual(events, [
      {
        kind: 'log',
        message:
          'Detected an older local Codex CLI that does not support app-server reasoning effort. Chill Vibe retried automatically without that field for this run.',
      },
      { kind: 'done' },
    ])

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .filter((request) => request.method === 'turn/start')

    assert.equal(requests.length, 2)
    assert.ok(Object.prototype.hasOwnProperty.call(requests[0]?.params ?? {}, 'effort'))
    assert.ok(!Object.prototype.hasOwnProperty.call(requests[1]?.params ?? {}, 'effort'))
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server forwards the final assistant message even after delta streaming', async () => {
  const events = await withFakeProviderCommand(
    'codex',
    buildFakeCodexDeltaThenAssistantMessageScript(),
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(events, [
    {
      kind: 'delta',
      content: 'First paragraph Second paragraph',
      itemId: 'assistant-item-1',
    },
    {
      kind: 'assistant_message',
      itemId: 'assistant-item-1',
      content: 'First paragraph\n\nSecond paragraph',
    },
    { kind: 'done' },
  ])
})

test('codex app-server preserves newline-only delta chunks during streaming', async () => {
  const events = await withFakeProviderCommand(
    'codex',
    buildFakeCodexDeltaWhitespaceChunksScript(),
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(events, [
    { kind: 'delta', content: 'First paragraph', itemId: 'assistant-item-1' },
    { kind: 'delta', content: '\n\n', itemId: 'assistant-item-1' },
    { kind: 'delta', content: 'Second paragraph', itemId: 'assistant-item-1' },
    {
      kind: 'assistant_message',
      itemId: 'assistant-item-1',
      content: 'First paragraph\n\nSecond paragraph',
    },
    { kind: 'done' },
  ])
})

test('codex app-server suppresses raw commentary JSON deltas and emits reasoning activity instead', async () => {
  const events = await withFakeProviderCommand(
    'codex',
    buildFakeCodexCommentaryDeltaScript(),
    async (workspacePath) =>
      captureProviderEvents(
        createRequest({
          provider: 'codex',
          language: 'zh-CN',
          workspacePath,
        }),
      ),
  )

  assert.deepEqual(events, [
    {
      kind: 'activity',
      activity: {
        itemId: 'assistant-item-1',
        kind: 'reasoning',
        status: 'completed',
        text: '先确认 JSON 结构，再精确读取锻炉和候选效果。',
      },
    },
    { kind: 'done' },
  ])
})

test('codex app-server stays compatible when an older CLI rejects the --listen flag', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-legacy-listen-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexLegacyAppServerScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string })

    assert.ok(requests.some((request) => request.method === 'initialize'))
    assert.ok(requests.some((request) => request.method === 'thread/start'))
    assert.ok(requests.some((request) => request.method === 'turn/start'))
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server collapses duplicate compaction notifications into one activity', async () => {
  const events = await withFakeProviderCommand(
    'codex',
    buildFakeCodexDuplicateCompactionScript(),
    async (workspacePath) =>
      captureProviderActivities(
        createRequest({
          provider: 'codex',
          language: 'en',
          workspacePath,
          prompt: 'Continue after compaction',
        }),
      ),
  )

  assert.deepEqual(events, [
    {
      kind: 'activity',
      activity: {
        itemId: 'compact-item-1',
        kind: 'compaction',
        status: 'completed',
        trigger: 'auto',
      },
    },
    { kind: 'done' },
  ])
})

test('codex app-server omits unsupported experimental history fields on thread/start', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-start-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const threadStart = requests.find((request) => request.method === 'thread/start')

    assert.ok(threadStart)
    assert.equal(Object.hasOwn(threadStart.params ?? {}, 'persistExtendedHistory'), false)
    assert.equal(Object.hasOwn(threadStart.params ?? {}, 'experimentalRawEvents'), false)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server defaults to danger-full-access sandbox for normal chats', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
          }),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const threadStart = requests.find((request) => request.method === 'thread/start')
    const turnStart = requests.find((request) => request.method === 'turn/start')

    assert.ok(threadStart)
    assert.equal(threadStart.params?.sandbox, 'danger-full-access')
    assert.ok(turnStart)
    assert.deepEqual(turnStart.params?.sandboxPolicy, {
      type: 'dangerFullAccess',
    })
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server installs and precisely trusts the Chill Vibe safety hook before starting a protected thread', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-safety-hook-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexSafetyHandshakeScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            cardId: 'safety-card',
            codexDestructiveCommandProtectionEnabled: true,
            codexIsolatedHomeEnabled: true,
          }),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const messages = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as {
        kind?: string
        argv?: string[]
        env?: Record<string, string | undefined>
        method?: string
        params?: Record<string, unknown>
      })
    const startup = messages.find((message) => message.kind === 'startup')
    const methods = messages.flatMap((message) => message.method ? [message.method] : [])

    assert.ok(startup)
    assert.match(startup.argv?.join(' ') ?? '', /hooks\.PreToolUse/)
    assert.doesNotMatch(startup.argv?.join(' ') ?? '', /dangerously-bypass-hook-trust/)
    assert.ok(startup.env?.hookCommand)
    assert.notEqual(path.resolve(startup.env?.USERPROFILE ?? ''), path.resolve(os.homedir()))
    if (process.platform === 'win32') {
      assert.equal(startup.env?.HOME, process.env.HOME ?? os.homedir())
    } else {
      assert.notEqual(path.resolve(startup.env?.HOME ?? ''), path.resolve(os.homedir()))
    }
    assert.equal(
      path.resolve(startup.env?.CODEX_HOME ?? ''),
      path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')),
    )
    assert.deepEqual(methods, [
      'initialize',
      'initialized',
      'hooks/list',
      'config/batchWrite',
      'hooks/list',
      'thread/start',
      'turn/start',
    ])

    const trustWrite = messages.find((message) => message.method === 'config/batchWrite')
    assert.match(JSON.stringify(trustWrite?.params), /sha256:chill-vibe-safety/)
    assert.match(JSON.stringify(trustWrite?.params), /trusted_hash/)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server leaves hook args and home environment unchanged when both safety switches are off', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-safety-disabled-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexSafetyHandshakeScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            codexDestructiveCommandProtectionEnabled: false,
            codexIsolatedHomeEnabled: false,
          }),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const messages = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as {
        kind?: string
        argv?: string[]
        env?: Record<string, string | undefined>
        method?: string
      })
    const startup = messages.find((message) => message.kind === 'startup')
    const methods = messages.flatMap((message) => message.method ? [message.method] : [])

    assert.ok(startup)
    assert.doesNotMatch(startup.argv?.join(' ') ?? '', /hooks\.PreToolUse/)
    assert.equal(startup.env?.hookCommand, undefined)
    assert.equal(startup.env?.HOME, process.env.HOME)
    assert.equal(startup.env?.USERPROFILE, process.env.USERPROFILE)
    assert.equal(startup.env?.CODEX_HOME, process.env.CODEX_HOME)
    assert.deepEqual(methods, ['initialize', 'initialized', 'thread/start', 'turn/start'])
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server honors a read-only sandbox override', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-readonly-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            sandboxMode: 'read-only',
          }),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const threadStart = requests.find((request) => request.method === 'thread/start')
    const turnStart = requests.find((request) => request.method === 'turn/start')

    assert.ok(threadStart)
    assert.equal(threadStart.params?.sandbox, 'read-only')
    assert.ok(turnStart)
    assert.deepEqual(turnStart.params?.sandboxPolicy, {
      type: 'readOnly',
      networkAccess: false,
    })
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server forwards on-request approvals and workspace-write network access', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-approval-network-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    let capturedWorkspacePath = ''
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) => {
        capturedWorkspacePath = workspacePath
        return captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            sandboxMode: 'workspace-write',
            approvalPolicy: 'on-request',
            networkAccessEnabled: true,
          }),
        )
      },
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const threadStart = requests.find((request) => request.method === 'thread/start')
    const turnStart = requests.find((request) => request.method === 'turn/start')

    assert.ok(threadStart)
    assert.equal(threadStart.params?.approvalPolicy, 'on-request')
    assert.equal(threadStart.params?.sandbox, 'workspace-write')
    assert.ok(turnStart)
    assert.equal(turnStart.params?.approvalPolicy, 'on-request')
    assert.deepEqual(turnStart.params?.sandboxPolicy, {
      type: 'workspaceWrite',
      networkAccess: 'enabled',
      writableRoots: [capturedWorkspacePath],
    })
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server retries without optional agent params when an older CLI rejects them', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-turn-agent-params-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const events = await withFakeProviderCommand(
      'codex',
      buildFakeCodexLegacyAgentParamsScript(capturePath),
      async (workspacePath) =>
        captureProviderLogs(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            personality: 'friendly',
            serviceTier: 'priority',
          } as Partial<ChatRequest>),
        ),
    )

    assert.deepEqual(events, [
      {
        kind: 'log',
        message:
          'Detected an older local Codex CLI that does not support Agent personality or Fast mode. Chill Vibe retried automatically without those optional fields for this run.',
      },
      { kind: 'done' },
    ])

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .filter((request) => request.method === 'turn/start')

    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.params?.personality, 'friendly')
    assert.equal(requests[0]?.params?.serviceTier, 'priority')
    assert.ok(Object.hasOwn(requests[1]?.params ?? {}, 'effort'))
    assert.equal(Object.hasOwn(requests[1]?.params ?? {}, 'personality'), false)
    assert.equal(Object.hasOwn(requests[1]?.params ?? {}, 'serviceTier'), false)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server forwards personality and Fast service tier on turn/start', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-agent-params-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            personality: 'pragmatic',
            serviceTier: 'priority',
          } as Partial<ChatRequest>),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const turnStart = requests.find((request) => request.method === 'turn/start')

    assert.ok(turnStart)
    assert.equal(turnStart.params?.personality, 'pragmatic')
    assert.equal(turnStart.params?.serviceTier, 'priority')
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server omits unsupported experimental history fields on thread/resume', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-resume-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexAppServerScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            sessionId: 'thread-1',
          }),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const threadResume = requests.find((request) => request.method === 'thread/resume')

    assert.ok(threadResume)
    assert.equal(Object.hasOwn(threadResume.params ?? {}, 'persistExtendedHistory'), false)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server continues an idle resumed thread with a neutral continue nudge', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-resume-idle-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexIdleResumeScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            sessionId: 'thread-1',
            prompt: '',
            attachments: [],
          }),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const turnStart = requests.find((request) => request.method === 'turn/start')

    assert.ok(turnStart, 'expected idle session resume to start a follow-up turn')
    assert.deepEqual(turnStart.params?.input, [
      {
        type: 'text',
        text: 'Please continue.',
        text_elements: [],
      },
    ])
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server continues an active resumed thread with a neutral continue nudge', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-resume-active-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const outcome = await withFakeProviderCommand(
      'codex',
      buildFakeCodexActiveResumeScript(capturePath),
      async (workspacePath) =>
        captureProviderOutcome(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            sessionId: 'thread-1',
            prompt: '',
            attachments: [],
          }),
        ),
    )

    assert.deepEqual(outcome, { kind: 'done' })

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    const turnStart = requests.find((request) => request.method === 'turn/start')

    assert.ok(turnStart, 'expected active session resume to start a follow-up turn')
    assert.deepEqual(turnStart.params?.input, [
      {
        type: 'text',
        text: 'Please continue.',
        text_elements: [],
      },
    ])
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server retries with a fresh thread when the resumed rollout file is empty', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-resume-empty-rollout-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const events = await withFakeProviderCommand(
      'codex',
      buildFakeCodexEmptyRolloutResumeScript(capturePath),
      async (workspacePath) =>
        captureProviderLogs(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            sessionId: 'stale-rollout-session',
            prompt: 'Retry with this updated instruction.',
          }),
        ),
    )

    assert.deepEqual(events, [
      {
        kind: 'log',
        message:
          'The resumed Codex session could not be loaded from its rollout file. Chill Vibe started a new session automatically so your latest prompt and attachments are not lost.',
      },
      { kind: 'done' },
    ])

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })

    assert.equal(requests.filter((request) => request.method === 'thread/resume').length, 1)
    assert.equal(requests.filter((request) => request.method === 'thread/start').length, 1)
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})


test('codex app-server retries with a fresh thread when the resumed session path is missing', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-resume-missing-session-path-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const events = await withFakeProviderCommand(
      'codex',
      buildFakeCodexMissingSessionPathResumeScript(capturePath),
      async (workspacePath) =>
        captureProviderLogs(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            sessionId: 'stale-rollout-session',
            prompt: 'Retry with this updated instruction.',
          }),
        ),
    )

    assert.deepEqual(events, [
      {
        kind: 'log',
        message:
          'The resumed Codex session could not be loaded from its rollout file. Chill Vibe started a new session automatically so your latest prompt and attachments are not lost.',
      },
      { kind: 'done' },
    ])

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })

    assert.equal(requests.filter((request) => request.method === 'thread/resume').length, 1)
    assert.equal(requests.filter((request) => request.method === 'thread/start').length, 1)
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})

test('codex app-server retries with a fresh thread when no rollout is found for the session', async () => {
  const capturePath = path.join(
    os.tmpdir(),
    `chill-vibe-codex-app-server-resume-missing-rollout-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )

  try {
    const events = await withFakeProviderCommand(
      'codex',
      buildFakeCodexNoRolloutFoundResumeScript(capturePath),
      async (workspacePath) =>
        captureProviderLogs(
          createRequest({
            provider: 'codex',
            language: 'en',
            workspacePath,
            sessionId: '082eba38-c11f-4a90-b577-54bc312faac3',
            prompt: 'Retry with this updated instruction.',
          }),
        ),
    )

    assert.deepEqual(events, [
      {
        kind: 'log',
        message:
          'The resumed Codex session could not be loaded from its rollout file. Chill Vibe started a new session automatically so your latest prompt and attachments are not lost.',
      },
      { kind: 'done' },
    ])

    const requests = (await readFile(capturePath, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })

    assert.equal(requests.filter((request) => request.method === 'thread/resume').length, 1)
    assert.equal(requests.filter((request) => request.method === 'thread/start').length, 1)
    assert.equal(requests.filter((request) => request.method === 'turn/start').length, 1)
  } finally {
    await rm(capturePath, { force: true }).catch(() => {})
  }
})
