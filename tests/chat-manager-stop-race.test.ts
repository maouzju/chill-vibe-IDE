import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'

import { ChatManager } from '../server/chat-manager.ts'
import type { ChatRequest } from '../shared/schema.ts'

test('stop kills a provider child that resolves after stop was requested', async (t) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-stop-race-'))
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })
  let resolveLaunch!: (child: ChildProcess) => void
  let killed = false
  const launchPromise = new Promise<ChildProcess>((resolve) => {
    resolveLaunch = resolve
  })
  const manager = new ChatManager({
    providerLauncher: async () => await launchPromise,
  })
  const request = {
    streamId: 'stop-before-child',
    provider: 'codex',
    prompt: 'test',
    workspacePath,
    attachments: [],
    model: '',
    reasoningEffort: 'max',
    thinkingEnabled: true,
    planMode: false,
    language: 'zh-CN',
    systemPrompt: '',
    modelPromptRules: [],
    crossProviderSkillReuseEnabled: true,
  } satisfies ChatRequest

  manager.createStream(request)
  assert.equal(manager.stop('stop-before-child'), true)
  resolveLaunch({
    kill: () => {
      killed = true
      return true
    },
  } as unknown as ChildProcess)
  const deadline = Date.now() + 2_000
  while (!killed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.equal(killed, true)
  manager.closeAll()
})
