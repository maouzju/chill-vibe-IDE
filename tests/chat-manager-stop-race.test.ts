import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'

import { ChatManager, type StreamEnvelope } from '../server/chat-manager.ts'
import type { ChatRequest } from '../shared/schema.ts'

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true, message)
}

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
    // 这条用例只关心"迟到的 child 仍被 kill"。不注入的话 startProvider 会先跑真实
    // git 快照，实测（2026-08-02）74ms~3.5s 波动，能吃掉下面 2s 的等待预算并假红。
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => ({ files: [] }),
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
  assert.equal(manager.stop('stop-before-child').stopped, true)
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

// 症状：turn 已 onDone、工作区 diff 还在 await 时用户点停止 → edits 改动卡被排在
// done 之后，renderer 的 onDone 已经 close 掉 EventSource，改动卡与文件清单整个丢失。
// 这里用一个手动 resolve 的 workspaceDiffer 把那个窗口钉死复现。
test('stop during an in-flight workspace diff keeps the edits activity ahead of done', async (t) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-stop-diff-'))
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  let releaseDiff!: () => void
  const diffGate = new Promise<void>((resolve) => {
    releaseDiff = resolve
  })
  let diffStarted = false
  let killed = false

  const manager = new ChatManager({
    workspaceSnapshotter: async () => ({}) as never,
    workspaceDiffer: async () => {
      diffStarted = true
      await diffGate
      return {
        files: [
          {
            path: 'server/chat-manager.ts',
            kind: 'modified' as const,
            addedLines: 3,
            removedLines: 1,
            patch: '@@ -1 +1 @@',
          },
        ],
      }
    },
    providerLauncher: async (_request, sink) => {
      // 回合已经真的结束了，只是收尾 diff 还没回来——这正是竞态窗口。
      sink.onDone({})
      return {
        kill: () => {
          killed = true
          return true
        },
      } as unknown as ChildProcess
    },
  })
  t.after(() => manager.closeAll())

  const request = {
    streamId: 'stop-during-workspace-diff',
    cardId: 'card-stop-during-workspace-diff',
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

  const events: StreamEnvelope[] = []
  manager.createStream(request)
  manager.subscribe('stop-during-workspace-diff', (payload) => {
    events.push(payload)
  })

  await waitFor(() => diffStarted, 'workspace diff should be in flight before stop')

  const stopStartedAt = Date.now()
  const stopResult = manager.stop('stop-during-workspace-diff')
  const stopDurationMs = Date.now() - stopStartedAt

  // stop 必须仍然立即生效：同步返回 + 子进程已被 kill，不允许被 diff 拖住。
  assert.equal(stopResult.stopped, true)
  assert.ok(stopDurationMs < 200, `stop() must stay immediate, took ${stopDurationMs}ms`)
  assert.equal(killed, true, 'stop must kill the provider child immediately')
  // 终态被刻意推迟时必须把上限告诉渲染进程，否则它的本地兜底会抢跑。
  assert.ok(
    stopResult.settlingWithinMs > 0,
    'stop must report that the terminal envelope is deliberately deferred',
  )

  releaseDiff()

  await waitFor(
    () => events.some((item) => item.event === 'done'),
    'the stopped stream should still settle with a terminal done',
  )
  await new Promise((resolve) => setTimeout(resolve, 50))

  const doneIndex = events.findIndex((item) => item.event === 'done')
  const editsIndex = events.findIndex(
    (item) => item.event === 'activity' && (item.data as { kind?: string }).kind === 'edits',
  )

  assert.ok(editsIndex >= 0, 'the workspace edits activity must not be silently dropped')
  assert.ok(
    editsIndex < doneIndex,
    `edits activity must never arrive after done (edits=${editsIndex}, done=${doneIndex})`,
  )
  assert.equal(
    events.slice(doneIndex + 1).length,
    0,
    'no stream event may follow the terminal done envelope',
  )
})

// 症状：diff 比停止宽限期慢时，edits 改动卡照样被静默丢弃 —— 结果与修复前一模一样，
// 且没有任何日志。上一版把宽限期写死成 3s，而这个文件自己的注释记着真实 workspace
// diff 实测 74ms~3.5s，也就是说这个"兜底"落在正常耗时分布中间，正常波动就会触发。
// 根因：宽限定时器与 diff 完成是两个独立竞速，存在"diff 明明完成了、结果却被扔掉"的
// 窗口 —— 定时器回调先置 terminal，await 之后的 `!stream.terminal` 守卫随即挡掉 emit。
test('a workspace diff slower than the stop grace period still delivers its edits', async (t) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-slow-diff-'))
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  let diffStarted = false
  const manager = new ChatManager({
    workspaceSnapshotter: async () => ({}) as never,
    workspaceDiffer: async () => {
      diffStarted = true
      // 慢于旧的 3s 写死宽限期，但仍在真实 diff 的正常耗时范围内。
      await new Promise((resolve) => setTimeout(resolve, 3_200))
      return {
        files: [
          {
            path: 'server/chat-manager.ts',
            kind: 'modified' as const,
            addedLines: 3,
            removedLines: 1,
            patch: '@@ -1 +1 @@',
          },
        ],
      }
    },
    providerLauncher: async (_request, sink) => {
      sink.onDone({})
      return { kill: () => true } as unknown as ChildProcess
    },
  })
  t.after(() => manager.closeAll())

  const request = {
    streamId: 'stop-during-slow-workspace-diff',
    cardId: 'card-stop-during-slow-workspace-diff',
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

  const events: StreamEnvelope[] = []
  manager.createStream(request)
  manager.subscribe('stop-during-slow-workspace-diff', (payload) => {
    events.push(payload)
  })

  await waitFor(() => diffStarted, 'workspace diff should be in flight before stop')
  manager.stop('stop-during-slow-workspace-diff')

  await waitFor(
    () => events.some((item) => item.event === 'done'),
    'the stopped stream should still settle with a terminal done',
    8_000,
  )
  await new Promise((resolve) => setTimeout(resolve, 100))

  const doneIndex = events.findIndex((item) => item.event === 'done')
  const editsIndex = events.findIndex(
    (item) => item.event === 'activity' && (item.data as { kind?: string }).kind === 'edits',
  )

  assert.ok(
    editsIndex >= 0,
    'a diff that completed must not have its edits thrown away just for being slow',
  )
  assert.ok(
    editsIndex < doneIndex,
    `edits activity must never arrive after done (edits=${editsIndex}, done=${doneIndex})`,
  )
})

// 硬超时那一侧的守卫：git 真的卡死时流仍然必须收尾，而且既然放弃了 diff，就绝不能
// 在 done 之后再冒出一条 edits —— "拿到结果"与"放弃"是同一个决策点的两个出口。
test('a wedged workspace diff still settles the stream and never emits edits after done', async (t) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-wedged-diff-'))
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  let diffStarted = false
  let releaseDiff!: () => void
  const diffGate = new Promise<void>((resolve) => {
    releaseDiff = resolve
  })

  const manager = new ChatManager({
    workspaceDiffTimeoutMs: 120,
    workspaceSnapshotter: async () => ({}) as never,
    workspaceDiffer: async () => {
      diffStarted = true
      await diffGate
      return {
        files: [
          {
            path: 'server/chat-manager.ts',
            kind: 'modified' as const,
            addedLines: 1,
            removedLines: 0,
            patch: '@@ -1 +1 @@',
          },
        ],
      }
    },
    providerLauncher: async (_request, sink) => {
      sink.onDone({})
      return { kill: () => true } as unknown as ChildProcess
    },
  })
  t.after(() => manager.closeAll())

  const request = {
    streamId: 'wedged-workspace-diff',
    cardId: 'card-wedged-workspace-diff',
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

  const events: StreamEnvelope[] = []
  manager.createStream(request)
  manager.subscribe('wedged-workspace-diff', (payload) => {
    events.push(payload)
  })

  await waitFor(() => diffStarted, 'workspace diff should be in flight')

  // diff 永远不回来，流必须靠自己的硬超时收尾。
  await waitFor(
    () => events.some((item) => item.event === 'done'),
    'a wedged workspace diff must not leave the card stuck in streaming',
  )

  const doneIndex = events.findIndex((item) => item.event === 'done')
  assert.equal(
    events.slice(doneIndex + 1).length,
    0,
    'no stream event may follow the terminal done envelope',
  )

  // 迟到的 diff 结果必须被彻底丢弃，不能在 done 之后补一条 edits。
  releaseDiff()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(
    events.slice(doneIndex + 1).length,
    0,
    'a diff that lands after the give-up point must never emit anything',
  )
})
