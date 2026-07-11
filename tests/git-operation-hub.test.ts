import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitStatus } from '../shared/schema.ts'
import {
  createGitOperationHub,
  type GitOperationContext,
  type GitOperationHubDeps,
} from '../src/components/git-operation-hub.ts'
import { rememberGitChangeSnapshot } from '../src/components/git-change-tracker.ts'

const createGitStatus = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  workspacePath: 'D:\\repo',
  repoRoot: 'D:\\repo',
  isRepository: true,
  branch: 'main',
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  clean: false,
  hasConflicts: false,
  summary: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
  description: '',
  changes: [
    {
      path: 'src/a.ts',
      kind: 'modified',
      stagedStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
      conflicted: false,
      addedLines: 1,
      removedLines: 0,
      patch: '@@ -1 +1 @@\n-a\n+b',
    },
  ],
  lastCommit: null,
  ...overrides,
})

type StreamHandlers = {
  onDelta?: (payload: { content: string }) => void
  onAssistantMessage?: (payload: { content: string }) => void
  onDone?: () => void
  onError?: (payload: { message: string }) => void
  onSession?: (payload: unknown) => void
  onActivity?: (payload: unknown) => void
  onLog?: (payload: unknown) => void
}

const createFakeDeps = () => {
  const calls: string[] = []
  let streamHandlers: StreamHandlers | null = null
  let streamClosedCount = 0
  const stoppedStreams: string[] = []
  const chatRequests: Record<string, unknown>[] = []

  const deps: GitOperationHubDeps = {
    requestChat: async (request) => {
      calls.push('requestChat')
      chatRequests.push(request)
      return { streamId: 'stream-1' }
    },
    openChatStream: (_streamId: string, handlers: StreamHandlers) => {
      calls.push('openChatStream')
      streamHandlers = handlers
      return {
        close: () => {
          streamClosedCount += 1
        },
      }
    },
    stopChat: async (streamId: string) => {
      stoppedStreams.push(streamId)
    },
    fetchGitStatus: async () => {
      calls.push('fetchGitStatus')
      return createGitStatus()
    },
    setGitStage: async () => {
      calls.push('setGitStage')
      return createGitStatus()
    },
    commitGitChanges: async () => {
      calls.push('commitGitChanges')
      return {
        status: createGitStatus({ clean: true, changes: [] }),
        commit: { hash: 'abc1234def', shortHash: 'abc1234', summary: 'test commit' },
      }
    },
    pullGitChanges: async () => {
      calls.push('pullGitChanges')
      return { status: createGitStatus() }
    },
    pushGitChanges: async () => {
      calls.push('pushGitChanges')
      return { status: createGitStatus({ ahead: 0 }) }
    },
    flashWindowOnce: async () => undefined,
  }

  return {
    deps,
    calls,
    getStreamHandlers: () => streamHandlers,
    getStreamClosedCount: () => streamClosedCount,
    stoppedStreams,
    chatRequests,
  }
}

const createContext = (workspacePath: string): GitOperationContext => ({
  workspacePath,
  language: 'zh-CN',
  gitAgentModel: 'gpt-5.4-codex high',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: false,
})

const analysisResultJson = JSON.stringify({
  summary: '一次小改动',
  strategies: [
    {
      label: '单批提交',
      description: '全部一起提交',
      commits: [{ summary: 'fix: a', paths: ['src/a.ts'] }],
    },
  ],
})

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

test('agent analysis survives subscriber detach (card unmount) and reattach sees the result', async () => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  let notifications = 0
  const unsubscribe = hub.subscribe(ws, () => {
    notifications += 1
  })

  await hub.openAgentAnalysis(createContext(ws), createGitStatus())
  assert.equal(hub.getSnapshot(ws).agentPanelOpen, true)
  assert.equal(hub.getSnapshot(ws).agentPhase.kind, 'analyzing')
  assert.ok(notifications > 0)

  // 卡片被拖到别的 pane / unmount：订阅断开，但流必须保持打开
  unsubscribe()
  assert.equal(fake.getStreamClosedCount(), 0)

  // 后台继续：分析结果流式返回并完成
  fake.getStreamHandlers()?.onAssistantMessage?.({ content: analysisResultJson })
  fake.getStreamHandlers()?.onDone?.()
  await flushAsync()

  // 卡片重新挂载：直接看到分析结果，界面不重置
  const snapshot = hub.getSnapshot(ws)
  assert.equal(snapshot.agentPanelOpen, true)
  assert.equal(snapshot.agentPhase.kind, 'result')
})

test('agent analysis forwards Codex personality and Fast settings', async () => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  await hub.openAgentAnalysis({
    ...createContext(ws),
    codexChatSettings: {
      codexPersonality: 'pragmatic',
      codexFastMode: true,
    },
  }, createGitStatus())

  assert.equal(fake.chatRequests[0]?.personality, 'pragmatic')
  assert.equal(fake.chatRequests[0]?.serviceTier, 'priority')
})

test('executeAgentStrategy runs every commit to completion with no subscribers attached', async () => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  const strategy = {
    label: '分两批',
    description: '',
    commits: [
      { summary: 'feat: one', paths: ['src/a.ts'] },
      { summary: 'feat: two', paths: ['src/b.ts'] },
    ],
  }

  await hub.executeAgentStrategy(createContext(ws), strategy, 0)

  const snapshot = hub.getSnapshot(ws)
  assert.equal(snapshot.agentPhase.kind, 'done')
  assert.equal(
    fake.calls.filter((call) => call === 'commitGitChanges').length,
    2,
  )
  assert.ok(snapshot.lastStatus)
})

test('closing the agent panel mid-analysis stops the stream explicitly', async () => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  await hub.openAgentAnalysis(createContext(ws), createGitStatus())
  assert.equal(hub.getSnapshot(ws).agentPhase.kind, 'analyzing')

  hub.closeAgentPanel(ws)
  await flushAsync()

  assert.equal(hub.getSnapshot(ws).agentPanelOpen, false)
  assert.equal(fake.getStreamClosedCount(), 1)
  assert.deepEqual(fake.stoppedStreams, ['stream-1'])
})

test('sync flow completes pull -> push in the background and reattach sees done', async () => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  const unsubscribe = hub.subscribe(ws, () => {})
  const syncPromise = hub.beginSync(createContext(ws))
  // 用户立刻切走
  unsubscribe()
  await syncPromise

  const snapshot = hub.getSnapshot(ws)
  assert.equal(snapshot.syncPanelOpen, true)
  assert.equal(snapshot.syncStep.kind, 'done')
  assert.ok(fake.calls.includes('pullGitChanges'))
  assert.ok(fake.calls.includes('pushGitChanges'))
})

test('beginSync opens the panel with pull progress immediately, before pull resolves', async () => {
  const fake = createFakeDeps()
  let resolvePull!: (value: { status: GitStatus }) => void
  fake.deps.pullGitChanges = async () =>
    new Promise<{ status: GitStatus }>((resolve) => {
      resolvePull = resolve
    })
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  const syncPromise = hub.beginSync(createContext(ws))
  await flushAsync()

  // pull 还在网络阶段：面板必须已经打开并显示 pull 进度，否则用户看到"点了没反应"
  const midSnapshot = hub.getSnapshot(ws)
  assert.equal(midSnapshot.syncPanelOpen, true)
  assert.equal(midSnapshot.syncStep.kind, 'pull')

  resolvePull({ status: createGitStatus() })
  await syncPromise

  assert.equal(hub.getSnapshot(ws).syncStep.kind, 'done')
})

test('sync flow surfaces blocked files instead of opening the panel', async () => {
  const fake = createFakeDeps()
  fake.deps.pullGitChanges = async () => ({
    status: createGitStatus(),
    blockedFiles: ['src/a.ts'],
  })
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  await hub.beginSync(createContext(ws))

  const snapshot = hub.getSnapshot(ws)
  assert.deepEqual(snapshot.blockedFiles, ['src/a.ts'])
  assert.equal(snapshot.syncPanelOpen, false)
})

test('runCommitNew finishes in the background and records a success notice', async () => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  // baseline 快照为空 → 当前改动全部视为新改动
  rememberGitChangeSnapshot(ws, [])

  const runPromise = hub.runCommitNew(createContext(ws))
  assert.equal(hub.getSnapshot(ws).commitNewPending, true)

  await runPromise

  const snapshot = hub.getSnapshot(ws)
  assert.equal(snapshot.commitNewPending, false)
  assert.equal(snapshot.notice?.tone, 'success')
  assert.ok(snapshot.lastStatus?.clean)
})

test('snapshots are referentially stable between mutations (useSyncExternalStore safety)', async () => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  const first = hub.getSnapshot(ws)
  const second = hub.getSnapshot(ws)
  assert.equal(first, second)

  await hub.openAgentAnalysis(createContext(ws), createGitStatus())
  const third = hub.getSnapshot(ws)
  assert.notEqual(first, third)
  assert.equal(third, hub.getSnapshot(ws))
})
