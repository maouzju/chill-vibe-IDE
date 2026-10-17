import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitStatus } from '../shared/schema.ts'
import {
  createGitOperationHub,
  resolveGitAgentModel,
  type GitAgentSessionRequest,
  type GitOperationContext,
  type GitOperationHubDeps,
} from '../src/components/git-operation-hub.ts'
import { rememberGitChangeSnapshot } from '../src/components/git-change-tracker.ts'
import { parseAnalysisResult } from '../src/components/git-agent-panel-utils.ts'

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

const createFakeDeps = (statusOverrides: Partial<GitStatus> = {}) => {
  const calls: string[] = []
  let streamHandlers: StreamHandlers | null = null
  let streamClosedCount = 0
  const stoppedStreams: string[] = []
  const chatRequests: Record<string, unknown>[] = []
  const stageRequests: { workspacePath: string; paths: string[]; staged: boolean }[] = []
  const commitRequests: {
    workspacePath: string
    summary: string
    description: string
    paths?: string[]
  }[] = []
  let remainingChanges = statusOverrides.changes ?? createGitStatus().changes
  const baseStatus = () => createGitStatus({ ...statusOverrides, changes: remainingChanges })

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
      return baseStatus()
    },
    setGitStage: async (request) => {
      calls.push('setGitStage')
      stageRequests.push({ ...request, paths: [...request.paths] })
      return baseStatus()
    },
    commitGitChanges: async (request) => {
      calls.push('commitGitChanges')
      commitRequests.push({ ...request, paths: request.paths ? [...request.paths] : undefined })
      const committed = new Set(request.paths ?? remainingChanges.map((change) => change.path))
      remainingChanges = remainingChanges.filter((change) => !committed.has(change.path))
      return {
        status: createGitStatus({
          ...statusOverrides,
          changes: remainingChanges,
          clean: remainingChanges.length === 0,
        }),
        commit: { hash: 'abc1234def', shortHash: 'abc1234', summary: 'test commit' },
      }
    },
    pullGitChanges: async () => {
      calls.push('pullGitChanges')
      return { status: baseStatus() }
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
    stageRequests,
    commitRequests,
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
      agentOutsideWorkspaceWriteEnabled: true,
      codexDestructiveCommandProtectionEnabled: true,
      codexIsolatedHomeEnabled: true,
      computerUseEnabled: false,
      attackPatternProtectionEnabled: true,
    },
  }, createGitStatus())

  assert.equal(fake.chatRequests[0]?.personality, 'pragmatic')
  assert.equal(fake.chatRequests[0]?.serviceTier, 'priority')
  assert.equal(fake.chatRequests[0]?.codexDestructiveCommandProtectionEnabled, true)
  assert.equal(fake.chatRequests[0]?.codexIsolatedHomeEnabled, true)
})

// 2026-10-17 用户截图：「Git 卡片 AI 模型」填 claude-sonnet-5-5，Git 卡仍写死 provider: 'codex'。
test('agent analysis runs on the CLI that owns the configured Git model', async () => {
  const cases = [
    { gitAgentModel: 'claude-sonnet-5-5', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
    { gitAgentModel: 'claude-opus-5-5 high', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    // Codex 专属档位在 Claude 上不存在，落回 Claude 的合法档位
    { gitAgentModel: 'claude-sonnet-5-5 ultra', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'max' },
    { gitAgentModel: 'gemini-3.8-flash high', provider: 'gemini', model: 'gemini-3.8-flash', effort: 'auto' },
    { gitAgentModel: 'gpt-6-luna', provider: 'codex', model: 'gpt-6-luna', effort: 'medium' },
    // 只写 CLI 名：交给该 CLI 自己的默认模型
    { gitAgentModel: 'claude', provider: 'claude', model: '', effort: 'medium' },
    // 认不出归属的自定义名保持旧行为：走 Codex
    { gitAgentModel: 'deepseek-v3 low', provider: 'codex', model: 'deepseek-v3', effort: 'low' },
  ] as const

  for (const expected of cases) {
    const fake = createFakeDeps()
    const hub = createGitOperationHub(fake.deps)
    const ws = 'D:\\repo'

    await hub.openAgentAnalysis(
      { ...createContext(ws), gitAgentModel: expected.gitAgentModel },
      createGitStatus(),
    )

    const request = fake.chatRequests[0]
    assert.equal(request?.provider, expected.provider, expected.gitAgentModel)
    assert.equal(request?.model, expected.model, expected.gitAgentModel)
    assert.equal(request?.reasoningEffort, expected.effort, expected.gitAgentModel)
    // 只读沙箱是 Codex 的概念；其它 CLI 不该收到 Codex 专属字段
    assert.equal(
      request?.sandboxMode,
      expected.provider === 'codex' ? 'read-only' : undefined,
      expected.gitAgentModel,
    )
    // 但分析必须在每个 CLI 上都只读：由服务端按各 CLI 的原生方式落实
    assert.equal(request?.readOnly, true, expected.gitAgentModel)
  }
})

// 2026-10-17 对抗审查：设置旁的 CLI 标签认得别名 / 选择器标签，但请求原样发出别名，
// CLI 不认 `--model luna`；档位写错时 Claude 落到最贵的 max；中转站自定义 Codex 名的档位被夹紧。
test('Git agent model resolves aliases, picker labels and stray effort tokens', () => {
  const cases = [
    { input: 'luna', provider: 'codex', model: 'gpt-6-luna', effort: 'medium' },
    { input: 'sonnet high', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
    { input: 'flash', provider: 'gemini', model: 'gemini-3.8-flash', effort: 'auto' },
    { input: 'Sonnet 5.5 high', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
    { input: 'GPT-6 Luna', provider: 'codex', model: 'gpt-6-luna', effort: 'medium' },
    { input: 'Claude Sonnet 5.5 xhigh', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'xhigh' },
    { input: 'Gemini 3.1 Pro', provider: 'gemini', model: 'gemini-3.1-pro-preview', effort: 'auto' },
    // 写错的档位不能让 Claude 落到 max
    { input: 'claude-sonnet-5-5 hgih', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
    // 目录外的 Codex 名：档位原样透传（旧行为），不按未知型号夹紧
    { input: 'gpt-5.4 max', provider: 'codex', model: 'gpt-5.4', effort: 'max' },
    { input: 'gpt-5.4-codex high', provider: 'codex', model: 'gpt-5.4-codex', effort: 'high' },
  ] as const

  for (const expected of cases) {
    assert.deepEqual(
      resolveGitAgentModel(expected.input),
      { provider: expected.provider, model: expected.model, reasoningEffort: expected.effort },
      expected.input,
    )
  }
})

// Claude / Gemini 没有 Codex 那种整条 assistant_message 覆盖：累计的是整轮全部文本增量，
// JSON 前面常有一句带花括号的旁白。
test('agent analysis on Claude parses the JSON even after a preamble with braces', async () => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  await hub.openAgentAnalysis({ ...createContext(ws), gitAgentModel: 'claude-sonnet-5-5' }, createGitStatus())
  fake.getStreamHandlers()?.onDelta?.({ content: 'The change adds a `{ codexSandboxMode }` option.' })
  fake.getStreamHandlers()?.onDelta?.({ content: '\n```json\n' + analysisResultJson + '\n```' })
  fake.getStreamHandlers()?.onDone?.()
  await flushAsync()

  const phase = hub.getSnapshot(ws).agentPhase
  assert.equal(phase.kind, 'result')
  assert.equal(phase.kind === 'result' ? phase.data.strategies.length : 0, 1)
})

test('agent analysis only forwards Codex-only overrides to Codex', async () => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)

  await hub.openAgentAnalysis({
    ...createContext('D:\\repo'),
    gitAgentModel: 'claude-sonnet-5-5',
    codexChatSettings: {
      codexPersonality: 'pragmatic',
      codexFastMode: true,
      agentOutsideWorkspaceWriteEnabled: true,
      codexDestructiveCommandProtectionEnabled: true,
      codexIsolatedHomeEnabled: true,
      computerUseEnabled: false,
      attackPatternProtectionEnabled: true,
    },
  }, createGitStatus())

  assert.equal(fake.chatRequests[0]?.provider, 'claude')
  assert.equal(fake.chatRequests[0]?.personality, undefined)
  assert.equal(fake.chatRequests[0]?.serviceTier, undefined)
  assert.equal(fake.chatRequests[0]?.attackPatternProtectionEnabled, true)
})

const createChange = (path: string): GitStatus['changes'][number] => ({
  path,
  kind: 'modified',
  stagedStatus: ' ',
  workingTreeStatus: 'M',
  staged: false,
  conflicted: false,
  addedLines: 1,
  removedLines: 0,
  patch: '@@ -1 +1 @@\n-a\n+b',
})

test('executeAgentStrategy runs every commit to completion with no subscribers attached', async () => {
  const fake = createFakeDeps({ changes: [createChange('src/a.ts'), createChange('src/b.ts')] })
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

test('executeAgentStrategy commits only the strategy paths instead of the whole index', async () => {
  const fake = createFakeDeps({ changes: [createChange('src/a.ts'), createChange('src/b.ts')] })
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  await hub.executeAgentStrategy(
    createContext(ws),
    {
      label: '分两批',
      description: '',
      commits: [
        { summary: 'feat: one', paths: ['src/a.ts'] },
        { summary: 'feat: two', paths: ['src/b.ts'] },
      ],
    },
    0,
  )

  assert.deepEqual(
    fake.commitRequests.map((request) => request.paths),
    [['src/a.ts'], ['src/b.ts']],
  )
})

test('executeAgentStrategy never stages or commits paths outside the analysed changes', async () => {
  const fake = createFakeDeps({ changes: [createChange('src/a.ts')] })
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  await hub.executeAgentStrategy(
    createContext(ws),
    {
      label: '幻觉路径',
      description: '',
      commits: [{ summary: 'feat: everything', paths: ['src/a.ts', 'src/ghost.ts'] }],
    },
    0,
  )

  assert.deepEqual(fake.stageRequests.map((request) => request.paths), [['src/a.ts']])
  assert.deepEqual(fake.commitRequests.map((request) => request.paths), [['src/a.ts']])
})

test('executeAgentStrategy expands a wildcard path into the analysed changes only', async () => {
  const fake = createFakeDeps({ changes: [createChange('src/a.ts'), createChange('src/b.ts')] })
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  await hub.executeAgentStrategy(
    createContext(ws),
    {
      label: '全部提交',
      description: '',
      commits: [{ summary: 'chore: all', paths: ['.'] }],
    },
    0,
  )

  assert.deepEqual(fake.stageRequests.map((request) => request.paths), [['src/a.ts', 'src/b.ts']])
  assert.deepEqual(fake.commitRequests.map((request) => request.paths), [['src/a.ts', 'src/b.ts']])
})

test('executeAgentStrategy fails loudly when no strategy path matches a real change', async () => {
  const fake = createFakeDeps({ changes: [createChange('src/a.ts')] })
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  await hub.executeAgentStrategy(
    createContext(ws),
    {
      label: '全是幻觉',
      description: '',
      commits: [{ summary: 'feat: nothing', paths: ['src/ghost.ts'] }],
    },
    0,
  )

  assert.equal(fake.commitRequests.length, 0)
  assert.equal(fake.stageRequests.length, 0)
  assert.equal(hub.getSnapshot(ws).agentPhase.kind, 'error')
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

test('sync flow completes pull -> push in the background and reattach sees a transient toast', async () => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  const unsubscribe = hub.subscribe(ws, () => {})
  const syncPromise = hub.beginSync(createContext(ws))
  // 用户立刻切走
  unsubscribe()
  await syncPromise

  const snapshot = hub.getSnapshot(ws)
  // 同步成功不再留一个要点击关闭的面板：面板自动收起，成功只以飘字呈现
  assert.equal(snapshot.syncPanelOpen, false)
  assert.equal(snapshot.syncStep.kind, 'idle')
  assert.equal(snapshot.notice?.tone, 'success')
  assert.equal(snapshot.notice?.transient, true)
  assert.ok(fake.calls.includes('pullGitChanges'))
  assert.ok(fake.calls.includes('pushGitChanges'))
})

test('sync success toast expires on its own without any user interaction', async (t) => {
  const fake = createFakeDeps()
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  // 虚拟时钟必须在 hub 安装过期计时器之前接管，否则 tick 推不动那个真实 setTimeout
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await hub.beginSync(createContext(ws))
  assert.equal(hub.getSnapshot(ws).notice?.transient, true)

  t.mock.timers.tick(10_000)
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(hub.getSnapshot(ws).notice, null)
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

  assert.equal(hub.getSnapshot(ws).syncPanelOpen, false)
  assert.equal(hub.getSnapshot(ws).notice?.transient, true)
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

const createConflictStatus = () =>
  createGitStatus({
    hasConflicts: true,
    changes: [{ ...createChange('src/a.ts'), conflicted: true }, createChange('src/b.ts')],
  })

// SPEC docs/specs/git-sync-conflict-session：冲突必须交给一个看得见的会话，
// 不能再在后台静默跑一个 Codex 回合然后自动 push。
test('sync conflicts open an explicit agent session instead of a hidden background Codex run', async () => {
  const fake = createFakeDeps()
  fake.deps.pullGitChanges = async () => ({ status: createConflictStatus() })
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'
  const sessions: GitAgentSessionRequest[] = []

  await hub.beginSync({
    ...createContext(ws),
    openAgentSession: (request) => {
      sessions.push(request)
      return true
    },
  })

  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]?.provider, 'codex')
  assert.equal(sessions[0]?.model, 'gpt-5.4-codex')
  assert.equal(sessions[0]?.reasoningEffort, 'high')
  assert.ok(sessions[0]?.title)
  assert.match(sessions[0]?.prompt ?? '', /src\/a\.ts/)
  assert.doesNotMatch(sessions[0]?.prompt ?? '', /src\/b\.ts/)
  assert.match(sessions[0]?.prompt ?? '', /git push/)

  assert.deepEqual(fake.chatRequests, [])
  assert.equal(fake.calls.includes('pushGitChanges'), false)

  const snapshot = hub.getSnapshot(ws)
  assert.equal(snapshot.syncPanelOpen, false)
  assert.equal(snapshot.syncStep.kind, 'idle')
  assert.equal(snapshot.notice?.tone, 'info')
})

test('sync conflicts open the conflict session on the CLI that owns the Git model', async () => {
  const fake = createFakeDeps()
  fake.deps.pullGitChanges = async () => ({ status: createConflictStatus() })
  const hub = createGitOperationHub(fake.deps)
  const sessions: GitAgentSessionRequest[] = []

  await hub.beginSync({
    ...createContext('D:\\repo'),
    gitAgentModel: 'claude-opus-5-5 xhigh',
    openAgentSession: (request) => {
      sessions.push(request)
      return true
    },
  })

  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]?.provider, 'claude')
  assert.equal(sessions[0]?.model, 'claude-opus-5-5')
  assert.equal(sessions[0]?.reasoningEffort, 'xhigh')
})

test('sync conflicts without a session opener stop on an error and never push', async () => {
  const fake = createFakeDeps()
  fake.deps.pullGitChanges = async () => ({ status: createConflictStatus() })
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  await hub.beginSync(createContext(ws))

  const snapshot = hub.getSnapshot(ws)
  assert.equal(snapshot.syncStep.kind, 'error')
  // 失败需要用户决策（重试 / 取消），面板必须留着，不能像成功那样飘走
  assert.equal(snapshot.syncPanelOpen, true)
  assert.deepEqual(fake.chatRequests, [])
  assert.equal(fake.calls.includes('pushGitChanges'), false)
})

test('a session that refuses to open leaves the sync on an error and never pushes', async () => {
  const fake = createFakeDeps()
  fake.deps.pullGitChanges = async () => ({ status: createConflictStatus() })
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'

  await hub.beginSync({ ...createContext(ws), openAgentSession: () => false })

  const snapshot = hub.getSnapshot(ws)
  assert.equal(snapshot.syncStep.kind, 'error')
  assert.equal(snapshot.syncPanelOpen, true)
  assert.ok(!snapshot.notice)
  assert.equal(fake.calls.includes('pushGitChanges'), false)
})

test('a second sync while the conflict session is still open does not open another session', async () => {
  const fake = createFakeDeps()
  fake.deps.pullGitChanges = async () => ({ status: createConflictStatus() })
  const hub = createGitOperationHub(fake.deps)
  const ws = 'D:\\repo'
  const sessions: GitAgentSessionRequest[] = []
  const context = {
    ...createContext(ws),
    openAgentSession: (request: GitAgentSessionRequest) => {
      sessions.push(request)
      return true
    },
  }

  await hub.beginSync(context)
  await hub.beginSync(context)

  assert.equal(sessions.length, 1)
  assert.equal(hub.getSnapshot(ws).syncStep.kind, 'error')
  assert.equal(fake.calls.includes('pushGitChanges'), false)
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

test('Git agent model keeps an uncatalogued relay name after a CLI prefix', () => {
  assert.deepEqual(resolveGitAgentModel('claude glm-4.6 high'), {
    provider: 'claude',
    model: 'glm-4.6',
    reasoningEffort: 'high',
  })
  assert.equal(resolveGitAgentModel('gemini gemini-2.0-flash').model, 'gemini-2.0-flash')
  assert.equal(resolveGitAgentModel('claude').model, '')
})

test('analysis JSON is still found when the preamble has an unclosed brace', () => {
  const content = 'I see `if (x) {` was added in a.ts.\n' + analysisResultJson
  const result = parseAnalysisResult(content)
  assert.equal(result?.summary, '一次小改动')
  assert.equal(result?.strategies.length, 1)
})
