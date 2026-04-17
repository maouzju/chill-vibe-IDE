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
  launchProviderRun,
  normalizeProviderExitCode,
} from '../server/providers.ts'
import { prependPathEntry, writeNodeEntrypointShim } from './test-shell-helpers.ts'

const createRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: overrides.provider ?? 'codex',
  workspacePath: overrides.workspacePath ?? 'D:/Git/chill-vibe',
  model: overrides.model ?? 'gpt-5.4',
  reasoningEffort: overrides.reasoningEffort ?? 'medium',
  thinkingEnabled: overrides.thinkingEnabled ?? true,
  planMode: overrides.planMode ?? false,
  streamId: overrides.streamId,
  sessionId: overrides.sessionId,
  language: overrides.language ?? 'zh-CN',
  systemPrompt: overrides.systemPrompt ?? defaultSystemPrompt,
  crossProviderSkillReuseEnabled: overrides.crossProviderSkillReuseEnabled ?? true,
  prompt: overrides.prompt ?? '修复这个问题',
  attachments: overrides.attachments ?? [],
  sandboxMode: overrides.sandboxMode,
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
  assert.match(promptValue, /AskUserQuestion/)
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
  const parsedSettings = JSON.parse(settingsArg) as { permissions?: { defaultMode?: string } }

  assert.equal(parsedSettings.permissions?.defaultMode, 'bypassPermissions')
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
      | { kind: 'delta'; content: string }
      | { kind: 'assistant_message'; itemId: string; content: string }
      | { kind: 'activity'; activity: StreamActivity }
      | { kind: 'done' }
      | { kind: 'error'; message: string }
    >
  >((resolve, reject) => {
    const events: Array<
      | { kind: 'delta'; content: string }
      | { kind: 'assistant_message'; itemId: string; content: string }
      | { kind: 'activity'; activity: StreamActivity }
      | { kind: 'done' }
      | { kind: 'error'; message: string }
    > = []

    void launchProviderRun(request, {
      onSession: () => undefined,
      onDelta: (content) => {
        events.push({ kind: 'delta', content })
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

const buildFakeCodexRecoverableReconnectLoopScript = (capturePath: string) =>
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
    "  if (request.method === 'thread/start' && request.id) {",
    "    reply({ id: request.id, result: { thread: { id: 'thread-loop', status: { type: 'active' } } } })",
    '    return',
    '  }',
    "  if (request.method === 'turn/start' && request.id) {",
    '    reply({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } } })',
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'Reconnecting... 1/5' } })",
    "    reply({ method: 'item/agentMessage/delta', params: { itemId: 'assistant-item-1', delta: 'Reconnecting... 2/5' } })",
    '    process.exit(0)',
    '  }',
    '})',
  ].join('\n')

const buildFakeClaudeRecoverableDisconnectScript = () =>
  [
    "const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)",
    "reply({ type: 'system', subtype: 'init', session_id: 'claude-session-recoverable' })",
    "reply({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reconnecting 1/5' }] } })",
    'process.exit(0)',
  ].join('\n')

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
    { kind: 'delta', content: 'First paragraph Second paragraph' },
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
    { kind: 'delta', content: 'First paragraph' },
    { kind: 'delta', content: '\n\n' },
    { kind: 'delta', content: 'Second paragraph' },
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

test('codex app-server continues an idle resumed thread by starting a blank turn', async () => {
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
        text: '',
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
