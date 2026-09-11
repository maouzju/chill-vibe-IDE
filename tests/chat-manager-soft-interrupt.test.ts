import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import test, { type TestContext } from 'node:test'

import { ChatManager, type StreamEnvelope } from '../server/chat-manager.ts'
import type { ChatRequest } from '../shared/schema.ts'

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true, message)
}

const buildRequest = (streamId: string, workspacePath: string): ChatRequest => ({
  streamId,
  provider: 'claude',
  prompt: 'test',
  workspacePath,
  attachments: [],
  model: 'claude-opus-4-7',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
})

const setup = async (
  t: TestContext,
  child: ChildProcess,
) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-soft-interrupt-'))
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })
  let launched = false
  const manager = new ChatManager({
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => ({ files: [] }),
    providerLauncher: async () => {
      launched = true
      return child
    },
  })
  t.after(() => manager.closeAll())
  const events: StreamEnvelope[] = []
  return {
    manager,
    events,
    start: async (streamId: string) => {
      manager.createStream(buildRequest(streamId, workspacePath))
      manager.subscribe(streamId, (payload) => {
        events.push(payload)
      })
      await waitFor(() => launched, 'provider child should launch')
      // stream.child 在 launcher resolve 之后的下一个 microtask 才挂上。
      await new Promise((resolve) => setTimeout(resolve, 30))
    },
  }
}

// 症状：左键发送打断 Claude 后，渲染端按硬杀年代的 pitfall #118 清掉 sessionId，
//   下一条消息以 seeded 摘要冷启动、常驻进程被杀。
// 根因：stop() 早已优先走 control_request 软中断（进程、会话、上下文全存活），
//   但终态信封里从没告诉渲染端"这次是软中断"，它只能一律按最坏情况处理。
// 这里钉住：软中断成功必须写进 done 信封；硬杀回退必须如实报 false。
test('stop marks the terminal done envelope as a soft interrupt and keeps the child alive', async (t) => {
  let killed = false
  let interrupts = 0
  const child = {
    kill: () => {
      killed = true
      return true
    },
    interruptTurn: () => {
      interrupts += 1
      return true
    },
  } as unknown as ChildProcess
  const { manager, events, start } = await setup(t, child)
  await start('soft-interrupt-stream')

  const result = manager.stop('soft-interrupt-stream')

  assert.equal(result.stopped, true)
  assert.equal(result.interrupted, true, 'stop result must report the soft interrupt')
  assert.equal(interrupts, 1)
  assert.equal(killed, false, 'a soft interrupt must not kill the pooled child')

  const done = events.find((item) => item.event === 'done')
  assert.ok(done, 'stop must still emit the terminal done envelope')
  assert.deepEqual(done.data, { stopped: true, interrupted: true })
})

test('stop reports interrupted=false when the child only supports a hard kill', async (t) => {
  let killed = false
  const child = {
    kill: () => {
      killed = true
      return true
    },
  } as unknown as ChildProcess
  const { manager, events, start } = await setup(t, child)
  await start('hard-kill-stream')

  const result = manager.stop('hard-kill-stream')

  assert.equal(result.stopped, true)
  assert.equal(result.interrupted, false)
  assert.equal(killed, true, 'without an interrupt channel stop must fall back to kill')

  const done = events.find((item) => item.event === 'done')
  assert.ok(done)
  assert.deepEqual(done.data, { stopped: true, interrupted: false })
})

test('stop reports interrupted=false when the interrupt channel refuses the request', async (t) => {
  let killed = false
  const child = {
    kill: () => {
      killed = true
      return true
    },
    interruptTurn: () => false,
  } as unknown as ChildProcess
  const { manager, events, start } = await setup(t, child)
  await start('refused-interrupt-stream')

  const result = manager.stop('refused-interrupt-stream')

  assert.equal(result.interrupted, false)
  assert.equal(killed, true, 'a refused soft interrupt must fall back to kill')
  const done = events.find((item) => item.event === 'done')
  assert.ok(done)
  assert.deepEqual(done.data, { stopped: true, interrupted: false })
})

test('软中断结果在 workspace diff 延迟收尾时仍随 done 发出', async (t) => {
  let releaseDiff!: () => void
  const gate = new Promise<void>((resolve) => { releaseDiff = resolve })
  let diffStarted = false
  const manager = new ChatManager({
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => {
      diffStarted = true
      await gate
      return { files: [] }
    },
    providerLauncher: async (_request, sink) => {
      sink.onDone({})
      return { kill: () => true, interruptTurn: () => true } as unknown as ChildProcess
    },
  })
  t.after(() => { releaseDiff(); manager.closeAll() })
  const events: StreamEnvelope[] = []
  manager.createStream(buildRequest('deferred', '.'))
  manager.subscribe('deferred', (event) => events.push(event))
  await waitFor(() => diffStarted, '等待收尾 diff')
  const result = manager.stop('deferred')
  assert.equal(result.interrupted, true)
  assert.ok(result.settlingWithinMs > 0)
  assert.equal(events.some((item) => item.event === 'done'), false)
  releaseDiff()
  await waitFor(() => events.some((item) => item.event === 'done'), '等待 done')
  assert.deepEqual(events.find((item) => item.event === 'done')?.data, { stopped: true, interrupted: true })
})
