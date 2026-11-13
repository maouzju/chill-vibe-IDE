import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import test from 'node:test'

import {
  ChatManager,
  compactStreamEnvelopeForBacklog,
  appendStreamEnvelopeToBacklog,
  buildStreamErrorPayload,
  buildUserMessageEnvelope,
  maxBacklogCommandOutputChars,
} from '../server/chat-manager.ts'
import type { StreamEnvelope } from '../server/chat-manager.ts'
import type { ChatStreamTapEvent } from '../server/chat-stream-tap.ts'
import type { launchProviderRun } from '../server/providers.ts'
import { chatRequestSchema } from '../shared/schema.ts'
import type { ChatRequest, StreamActivity } from '../shared/schema.ts'

type ProviderSink = Parameters<typeof launchProviderRun>[1]

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(predicate(), true, message)
}

const buildChatRequest = (
  overrides: Pick<ChatRequest, 'streamId' | 'cardId' | 'prompt'> & Partial<ChatRequest>,
): ChatRequest => ({
  provider: 'claude',
  workspacePath: os.tmpdir(),
  attachments: [],
  model: '',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  ...overrides,
})

const makeCommandActivity = (itemId: string, output: string): StreamEnvelope => ({
  event: 'activity',
  data: {
    itemId,
    kind: 'command',
    status: 'in_progress',
    command: 'node noisy.js',
    output,
    exitCode: null,
  },
})

type CommandActivityEnvelope = StreamEnvelope & {
  event: 'activity'
  data: Extract<StreamActivity, { kind: 'command' }>
}

const getCommandActivity = (payload: StreamEnvelope): CommandActivityEnvelope => {
  assert.equal(payload.event, 'activity')
  assert.equal((payload.data as { kind?: unknown }).kind, 'command')
  return payload as CommandActivityEnvelope
}

test('chat stream backlog compacts huge command output before retaining it', () => {
  const hugeOutput = `${'A'.repeat(maxBacklogCommandOutputChars)}${'B'.repeat(20_000)}`

  const compacted = compactStreamEnvelopeForBacklog(makeCommandActivity('cmd-1', hugeOutput))

  const compactedCommand = getCommandActivity(compacted)
  assert.ok(
    compactedCommand.data.output.length < hugeOutput.length,
    'retained command output should be smaller than the raw provider payload',
  )
  assert.ok(
    compactedCommand.data.output.length <= maxBacklogCommandOutputChars + 256,
    'retained command output should stay under a bounded budget plus truncation marker',
  )
  assert.match(compactedCommand.data.output, /truncated/i)
})

test('chat stream backlog coalesces repeated structured activity updates by item id', () => {
  const backlog: StreamEnvelope[] = []

  appendStreamEnvelopeToBacklog(backlog, makeCommandActivity('cmd-1', 'first'))
  appendStreamEnvelopeToBacklog(backlog, makeCommandActivity('cmd-1', 'second'))
  appendStreamEnvelopeToBacklog(backlog, makeCommandActivity('cmd-2', 'third'))

  assert.equal(backlog.length, 2)
  assert.ok(backlog[0])
  const firstCommand = getCommandActivity(backlog[0])
  assert.equal(firstCommand.data.output, 'second')
  assert.ok(backlog[1])
  const secondCommand = getCommandActivity(backlog[1])
  assert.equal(secondCommand.data.output, 'third')
})

test('chat stream backlog keeps a single merged context usage entry', () => {
  // 一个长回合会报几百次占用；逐条留着会把 2000 条 backlog 挤满，把真正的消息挤出去。
  // 只留一条，但它必须等价于「依次应用每一条」——不能因为后来的事件没带 size 就把窗口弄丢。
  const backlog: StreamEnvelope[] = []

  appendStreamEnvelopeToBacklog(backlog, { event: 'context_usage', data: { used: 44289 } })
  appendStreamEnvelopeToBacklog(backlog, { event: 'delta', data: { content: 'hi' } })
  appendStreamEnvelopeToBacklog(backlog, { event: 'context_usage', data: { used: 44377 } })
  appendStreamEnvelopeToBacklog(backlog, {
    event: 'context_usage',
    data: { used: 44377, size: 200000 },
  })
  appendStreamEnvelopeToBacklog(backlog, { event: 'context_usage', data: { used: 51000 } })

  assert.deepEqual(backlog, [
    { event: 'context_usage', data: { used: 51000, size: 200000 } },
    { event: 'delta', data: { content: 'hi' } },
  ])
})

test('a merged context usage backlog entry remembers that a compaction happened', () => {
  const backlog: StreamEnvelope[] = []

  appendStreamEnvelopeToBacklog(backlog, {
    event: 'context_usage',
    data: { used: 181234, size: 200000 },
  })
  appendStreamEnvelopeToBacklog(backlog, { event: 'context_usage', data: { reset: true } })

  // 压缩之后占用未知：旧的 181234 不能在重放时复活。窗口大小不受压缩影响。
  assert.deepEqual(backlog, [{ event: 'context_usage', data: { reset: true, size: 200000 } }])

  appendStreamEnvelopeToBacklog(backlog, { event: 'context_usage', data: { used: 45261 } })

  assert.deepEqual(backlog, [
    { event: 'context_usage', data: { reset: true, used: 45261, size: 200000 } },
  ])
})

test('live listeners still receive the original context usage event, not the merged one', () => {
  // emit 把 append 的返回值发给在线的订阅者。合并后的条目带着 reset，如果把它发给在线端，
  // 压缩之后的每一次占用更新都会被当成「又压缩了一次」，防连环的基线会被反复改写。
  const backlog: StreamEnvelope[] = []

  appendStreamEnvelopeToBacklog(backlog, { event: 'context_usage', data: { reset: true } })
  const live = appendStreamEnvelopeToBacklog(backlog, {
    event: 'context_usage',
    data: { used: 45261 },
  })

  assert.deepEqual(live, { event: 'context_usage', data: { used: 45261 } })
})

test('recoverable resume errors carry the latest known session id', () => {
  assert.deepEqual(
    buildStreamErrorPayload(
      'Selected model is at capacity. Please try a different model.',
      undefined,
      {
        recoverable: true,
        recoveryMode: 'resume-session',
      },
      ' session-1 ',
    ),
    {
      message: 'Selected model is at capacity. Please try a different model.',
      recoverable: true,
      recoveryMode: 'resume-session',
      sessionId: 'session-1',
    },
  )
})

test('user prompts become user_message envelopes so remote monitors can mirror them', () => {
  // 手机监工发的需求（以及电脑端发的）都要能出现在手机详情页的消息流里：
  // createStream 必须把 prompt 作为 user_message 事件进 backlog 并广播。
  assert.deepEqual(buildUserMessageEnvelope('谢谢'), {
    event: 'user_message',
    data: { content: '谢谢' },
  })
  assert.equal(buildUserMessageEnvelope('   '), null)
  assert.equal(buildUserMessageEnvelope(''), null)
})

test('createStream emits the user_message envelope before the provider starts', () => {
  // 顺序保证：user 消息要先于任何 assistant 输出进 backlog，late-joiner
  // 重放 backlog 时才能看到"需求在前、回答在后"的正确时间线。
  const source = readFileSync(new URL('../server/chat-manager.ts', import.meta.url), 'utf8')
  const createStreamBody = source.slice(source.indexOf('createStream('))
  const emitIndex = createStreamBody.indexOf('buildUserMessageEnvelope')
  const startIndex = createStreamBody.indexOf('this.startProvider')
  assert.ok(emitIndex >= 0, 'createStream must broadcast the user prompt envelope')
  assert.ok(emitIndex < startIndex, 'user_message must be emitted before startProvider')
})

test('app-initiated runs never mirror their prompt as a user_message', () => {
  // 上下文快满时 App 会替用户发一条 /compact（docs/specs/context-usage-auto-compact）。
  // 那不是用户敲的话：手机监工不该多出一条用户气泡。用户自己敲的 /compact 照常镜像。
  assert.equal(buildUserMessageEnvelope('/compact', 'auto-compact'), null)
  assert.deepEqual(buildUserMessageEnvelope('/compact'), {
    event: 'user_message',
    data: { content: '/compact' },
  })
})

test('an auto-compact stream is still mirrored to taps, tagged with its origin and without a user_message', async (t) => {
  // 手机监工靠 tap 知道哪张卡在跑：自动压缩的回合照常镜像（不镜像的话，压缩期间手机上
  // 那张卡会显示「已完成」），但每个事件都带着来源，监工才能不为它响铃、不弹「跑完了」。
  const sinks = new Map<string, ProviderSink>()
  const manager = new ChatManager({
    // 不注入的话 startProvider 会先跑真实 git 快照，慢且会假红。
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => ({ files: [] }),
    providerLauncher: async (request, sink) => {
      sinks.set(request.streamId ?? '', sink)
      return null
    },
  })
  t.after(() => manager.closeAll())

  const tapped: ChatStreamTapEvent[] = []
  manager.tapAll((event) => tapped.push(event))

  manager.createStream(
    buildChatRequest({ streamId: 's-user', cardId: 'card-user', prompt: '修一下登录' }),
  )
  manager.createStream(
    buildChatRequest({
      streamId: 's-compact',
      cardId: 'card-compact',
      prompt: '/compact',
      sessionId: 'session-1',
      origin: 'auto-compact',
    }),
  )
  await waitFor(
    () => sinks.has('s-user') && sinks.has('s-compact'),
    'provider sinks were never handed over',
  )

  sinks.get('s-user')?.onDelta('好的', 'item-1')
  sinks.get('s-compact')?.onDelta('压缩中', 'item-1')

  // 迟到的监工（重放 backlog）拿到的是同一份答案。
  const views = new Map(manager.listActiveStreams().map((view) => [view.streamId, view]))
  const userView = views.get('s-user')
  const compactView = views.get('s-compact')
  assert.ok(userView && compactView, 'both streams must be visible to late joiners')
  assert.equal(userView.origin, undefined)
  assert.equal(compactView.origin, 'auto-compact')
  assert.ok(userView.backlog.some((envelope) => envelope.event === 'user_message'))
  assert.ok(compactView.backlog.some((envelope) => envelope.event === 'delta'))
  assert.ok(!compactView.backlog.some((envelope) => envelope.event === 'user_message'))

  sinks.get('s-compact')?.onDone()
  sinks.get('s-user')?.onDone()
  await waitFor(
    () => tapped.filter((event) => event.envelope.event === 'done').length === 2,
    'both streams should reach their terminal done',
  )

  const compactEvents = tapped.filter((event) => event.streamId === 's-compact')
  const userEvents = tapped.filter((event) => event.streamId === 's-user')
  assert.deepEqual(
    [...new Set(compactEvents.map((event) => event.origin))],
    ['auto-compact'],
    'every mirrored event of the auto-compact stream, its done included, carries the origin',
  )
  assert.ok(!compactEvents.some((event) => event.envelope.event === 'user_message'))
  assert.deepEqual([...new Set(userEvents.map((event) => event.origin))], [undefined])
  assert.ok(userEvents.some((event) => event.envelope.event === 'user_message'))
})

test('the request schema keeps the auto-compact origin instead of stripping it', () => {
  // 请求体在服务端（server/index.ts）和 Electron 后端（electron/backend.ts）都要过
  // chatRequestSchema；zod 默认剥掉未声明的键，来源标记不进 schema 就到不了 ChatManager。
  const parsed = chatRequestSchema.parse({
    provider: 'claude',
    workspacePath: os.tmpdir(),
    model: '',
    prompt: '/compact',
    origin: 'auto-compact',
  })
  assert.equal(parsed.origin, 'auto-compact')

  const plain = chatRequestSchema.parse({
    provider: 'claude',
    workspacePath: os.tmpdir(),
    model: '',
    prompt: '修一下登录',
  })
  assert.equal(plain.origin, undefined)
  assert.equal('origin' in plain, false, '普通回合不该凭空多出 origin 键')

  // 只认 App 自己发的自动压缩；别的值一律拒绝，免得手机端被伪造的来源静音。
  assert.equal(
    chatRequestSchema.safeParse({
      provider: 'claude',
      workspacePath: os.tmpdir(),
      model: '',
      prompt: 'hi',
      origin: 'user',
    }).success,
    false,
  )
})
