import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import fs from 'fs'
import path from 'path'
import os from 'os'

import {
  forkProviderSession,
  planClaudeSessionFork,
  planCodexSessionFork,
} from '../server/session-fork.ts'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-fork-test-'))
const externalHomeDir = path.join(tmpDir, 'home')

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(externalHomeDir, { recursive: true, force: true })
  fs.mkdirSync(externalHomeDir, { recursive: true })
  process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME = externalHomeDir
})

afterEach(() => {
  delete process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME
})

const srcClaudeId = 'aaaaaaaa-0000-0000-0000-000000000001'
const newClaudeId = 'bbbbbbbb-0000-0000-0000-000000000002'

const claudeUserEntry = (options: {
  uuid: string
  text: string
  timestamp: string
  parentUuid?: string | null
}) =>
  JSON.stringify({
    parentUuid: options.parentUuid ?? null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: options.text }] },
    uuid: options.uuid,
    timestamp: options.timestamp,
    sessionId: srcClaudeId,
    cwd: 'D:\\Git\\project',
  })

const claudeAssistantEntry = (options: { uuid: string; text: string; timestamp: string }) =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: options.text }] },
    uuid: options.uuid,
    timestamp: options.timestamp,
    sessionId: srcClaudeId,
  })

const claudeToolResultEntry = (options: { uuid: string; text: string; timestamp: string }) =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: options.text }],
    },
    uuid: options.uuid,
    timestamp: options.timestamp,
    sessionId: srcClaudeId,
  })

const queueLine = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp: '2026-07-01T10:00:00.000Z',
  sessionId: srcClaudeId,
})

const unparseableLine = 'this is not json {'

const buildClaudeFixture = () =>
  [
    queueLine,
    claudeUserEntry({ uuid: 'u1', text: '第一个问题', timestamp: '2026-07-01T10:00:01.000Z' }),
    claudeAssistantEntry({ uuid: 'a1', text: '第一个回答', timestamp: '2026-07-01T10:00:30.000Z' }),
    claudeToolResultEntry({ uuid: 'tr1', text: '工具结果 第二个问题', timestamp: '2026-07-01T10:00:40.000Z' }),
    unparseableLine,
    claudeUserEntry({ uuid: 'u2', text: '第二个问题', timestamp: '2026-07-01T10:05:00.000Z' }),
    claudeAssistantEntry({ uuid: 'a2', text: '第二个回答', timestamp: '2026-07-01T10:05:30.000Z' }),
  ].join('\n') + '\n'

describe('planClaudeSessionFork', () => {
  it('truncates before the fork-point user turn and rewrites every session id', () => {
    const plan = planClaudeSessionFork(buildClaudeFixture(), {
      newSessionId: newClaudeId,
      forkPoint: { content: '第二个问题', createdAtMs: Date.parse('2026-07-01T10:04:58.000Z') },
    })

    assert.ok(plan)
    const lines = plan.trimEnd().split('\n')
    assert.equal(lines.length, 5)
    assert.ok(!plan.includes('第二个回答'))
    assert.ok(!plan.includes('"u2"'))
    assert.equal(lines[4], unparseableLine)
    for (const line of lines) {
      if (line === unparseableLine) continue
      const parsed = JSON.parse(line) as { sessionId?: string }
      assert.equal(parsed.sessionId, newClaudeId)
    }
    assert.ok(plan.includes('第一个问题'))
  })

  it('matches wrapped request prompts by containment', () => {
    const wrapped = claudeUserEntry({
      uuid: 'u2',
      text: '请在一个新的会话里继续这段对话。\n当前用户消息：\n第二个问题\n请基于上面的 transcript 回答。',
      timestamp: '2026-07-01T10:05:00.000Z',
    })
    const content =
      [
        queueLine,
        claudeUserEntry({ uuid: 'u1', text: '第一个问题', timestamp: '2026-07-01T10:00:01.000Z' }),
        claudeAssistantEntry({ uuid: 'a1', text: '第一个回答', timestamp: '2026-07-01T10:00:30.000Z' }),
        wrapped,
        claudeAssistantEntry({ uuid: 'a2', text: '第二个回答', timestamp: '2026-07-01T10:05:30.000Z' }),
      ].join('\n') + '\n'

    const plan = planClaudeSessionFork(content, {
      newSessionId: newClaudeId,
      forkPoint: { content: '第二个问题', createdAtMs: Date.parse('2026-07-01T10:04:59.000Z') },
    })

    assert.ok(plan)
    assert.ok(!plan.includes('"u2"'))
    assert.ok(plan.includes('第一个回答'))
  })

  it('prefers the timestamp-closest candidate when texts repeat', () => {
    const content =
      [
        claudeUserEntry({ uuid: 'u1', text: '重试', timestamp: '2026-07-01T10:00:01.000Z' }),
        claudeAssistantEntry({ uuid: 'a1', text: '回答一', timestamp: '2026-07-01T10:00:30.000Z' }),
        claudeUserEntry({ uuid: 'u2', text: '重试', timestamp: '2026-07-01T11:00:00.000Z' }),
        claudeAssistantEntry({ uuid: 'a2', text: '回答二', timestamp: '2026-07-01T11:00:30.000Z' }),
      ].join('\n') + '\n'

    const plan = planClaudeSessionFork(content, {
      newSessionId: newClaudeId,
      forkPoint: { content: '重试', createdAtMs: Date.parse('2026-07-01T10:59:58.000Z') },
    })

    assert.ok(plan)
    assert.ok(plan.includes('回答一'))
    assert.ok(!plan.includes('回答二'))
  })

  it('returns null when no user turn matches', () => {
    const plan = planClaudeSessionFork(buildClaudeFixture(), {
      newSessionId: newClaudeId,
      forkPoint: { content: '不存在的消息', createdAtMs: Date.parse('2026-07-01T10:05:00.000Z') },
    })
    assert.equal(plan, null)
  })

  it('returns null when the fork point is the first user turn (empty context)', () => {
    const plan = planClaudeSessionFork(buildClaudeFixture(), {
      newSessionId: newClaudeId,
      forkPoint: { content: '第一个问题', createdAtMs: Date.parse('2026-07-01T10:00:00.000Z') },
    })
    assert.equal(plan, null)
  })

  it('never treats tool_result user entries as fork candidates', () => {
    const plan = planClaudeSessionFork(buildClaudeFixture(), {
      newSessionId: newClaudeId,
      forkPoint: { content: '工具结果 第二个问题', createdAtMs: Date.parse('2026-07-01T10:00:41.000Z') },
    })
    assert.equal(plan, null)
  })

  it('rejects a containment match far outside the timestamp tolerance', () => {
    const plan = planClaudeSessionFork(buildClaudeFixture(), {
      newSessionId: newClaudeId,
      forkPoint: { content: '第二个问题', createdAtMs: Date.parse('2026-07-01T14:00:00.000Z') },
    })
    assert.equal(plan, null)
  })

  it('trims turn-boundary companion lines left dangling before the cut', () => {
    // Real Claude CLI turn intake: the resumed turn writes queue-operation
    // lines carrying the prompt text plus isMeta/synthetic filler BEFORE the
    // real user entry; none of that belongs to the forked context.
    const enqueueLine = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      timestamp: '2026-07-01T10:04:59.000Z',
      sessionId: srcClaudeId,
      content: '第二个问题',
    })
    const dequeueLine = JSON.stringify({
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: '2026-07-01T10:04:59.100Z',
      sessionId: srcClaudeId,
    })
    const metaUserLine = JSON.stringify({
      parentUuid: 'a1',
      isSidechain: false,
      isMeta: true,
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] },
      uuid: 'meta-1',
      timestamp: '2026-07-01T10:04:59.200Z',
      sessionId: srcClaudeId,
    })
    const syntheticAssistantLine = JSON.stringify({
      parentUuid: 'meta-1',
      isSidechain: false,
      type: 'assistant',
      message: { model: '<synthetic>', role: 'assistant', content: [] },
      uuid: 'synth-1',
      timestamp: '2026-07-01T10:04:59.300Z',
      sessionId: srcClaudeId,
    })
    const content =
      [
        claudeUserEntry({ uuid: 'u1', text: '第一个问题', timestamp: '2026-07-01T10:00:01.000Z' }),
        claudeAssistantEntry({ uuid: 'a1', text: '第一个回答', timestamp: '2026-07-01T10:00:30.000Z' }),
        enqueueLine,
        dequeueLine,
        metaUserLine,
        syntheticAssistantLine,
        claudeUserEntry({ uuid: 'u2', text: '第二个问题', timestamp: '2026-07-01T10:05:00.000Z' }),
        claudeAssistantEntry({ uuid: 'a2', text: '第二个回答', timestamp: '2026-07-01T10:05:30.000Z' }),
      ].join('\n') + '\n'

    const plan = planClaudeSessionFork(content, {
      newSessionId: newClaudeId,
      forkPoint: { content: '第二个问题', createdAtMs: Date.parse('2026-07-01T10:04:58.000Z') },
    })

    assert.ok(plan)
    assert.ok(!plan.includes('queue-operation'), 'queue-operation residue must be trimmed')
    assert.ok(!plan.includes('Continue from where you left off.'), 'isMeta filler must be trimmed')
    assert.ok(!plan.includes('<synthetic>'), 'synthetic assistant filler must be trimmed')
    assert.ok(plan.includes('第一个回答'), 'real context must survive the trim')
  })
})

const srcCodexId = '019f0000-0000-7000-8000-000000000001'
const newCodexId = '019f0000-0000-7000-8000-000000000002'

const codexMetaLine = JSON.stringify({
  timestamp: '2026-07-01T10:00:00.000Z',
  type: 'session_meta',
  payload: { id: srcCodexId, cwd: 'D:\\Git\\project', originator: 'chill-vibe' },
})

const codexUserLine = (text: string, timestamp: string) =>
  JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  })

const codexAssistantLine = (text: string, timestamp: string) =>
  JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  })

const buildCodexFixture = () =>
  [
    codexMetaLine,
    codexUserLine('<environment_context>\n  <cwd>D:\\Git\\project</cwd>\n</environment_context>', '2026-07-01T10:00:01.000Z'),
    codexUserLine('问题一', '2026-07-01T10:00:02.000Z'),
    codexAssistantLine('回答一', '2026-07-01T10:00:30.000Z'),
    codexUserLine('问题二', '2026-07-01T10:05:00.000Z'),
    codexAssistantLine('回答二', '2026-07-01T10:05:30.000Z'),
  ].join('\n') + '\n'

describe('planCodexSessionFork', () => {
  it('rewrites the session_meta id and truncates before the fork point', () => {
    const plan = planCodexSessionFork(buildCodexFixture(), {
      newSessionId: newCodexId,
      forkPoint: { content: '问题二', createdAtMs: Date.parse('2026-07-01T10:04:58.000Z') },
    })

    assert.ok(plan)
    const lines = plan.trimEnd().split('\n')
    const meta = JSON.parse(lines[0]!) as { payload?: { id?: string } }
    assert.equal(meta.payload?.id, newCodexId)
    assert.ok(plan.includes('问题一'))
    assert.ok(plan.includes('回答一'))
    assert.ok(!plan.includes('问题二'))
    assert.ok(!plan.includes('回答二'))
  })

  it('ignores environment_context entries for empty-content fork points', () => {
    const plan = planCodexSessionFork(buildCodexFixture(), {
      newSessionId: newCodexId,
      forkPoint: { content: '', createdAtMs: Date.parse('2026-07-01T10:04:59.000Z') },
    })

    assert.ok(plan)
    assert.ok(!plan.includes('问题二'))
    assert.ok(plan.includes('回答一'))
  })

  it('trims dangling turn_context and event_msg lines before the cut', () => {
    // Real Codex rollouts write turn_context + event_msg task_started for the
    // new turn BEFORE the user response_item; the fork must not keep them.
    const turnContextLine = JSON.stringify({
      timestamp: '2026-07-01T10:04:59.000Z',
      type: 'turn_context',
      payload: { cwd: 'D:\\Git\\project' },
    })
    const taskStartedLine = JSON.stringify({
      timestamp: '2026-07-01T10:04:59.100Z',
      type: 'event_msg',
      payload: { type: 'task_started' },
    })
    const content =
      [
        codexMetaLine,
        codexUserLine('问题一', '2026-07-01T10:00:02.000Z'),
        codexAssistantLine('回答一', '2026-07-01T10:00:30.000Z'),
        turnContextLine,
        taskStartedLine,
        codexUserLine('问题二', '2026-07-01T10:05:00.000Z'),
        codexAssistantLine('回答二', '2026-07-01T10:05:30.000Z'),
      ].join('\n') + '\n'

    const plan = planCodexSessionFork(content, {
      newSessionId: newCodexId,
      forkPoint: { content: '问题二', createdAtMs: Date.parse('2026-07-01T10:04:58.000Z') },
    })

    assert.ok(plan)
    assert.ok(!plan.includes('turn_context'), 'dangling turn_context must be trimmed')
    assert.ok(!plan.includes('task_started'), 'dangling event_msg must be trimmed')
    assert.ok(plan.includes('回答一'))
  })

  it('trims duplicate fork-point deliveries left by CLI-level retries', () => {
    // A failed turn can be retried by the CLI/host several times, writing the
    // same user prompt repeatedly; the fork must cut before the FIRST delivery,
    // not just the timestamp-closest one.
    const taskStarted = (timestamp: string) =>
      JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'task_started' } })
    const turnContext = (timestamp: string) =>
      JSON.stringify({ timestamp, type: 'turn_context', payload: {} })
    const content =
      [
        codexMetaLine,
        codexUserLine('问题一', '2026-07-01T10:00:02.000Z'),
        codexAssistantLine('回答一', '2026-07-01T10:00:30.000Z'),
        turnContext('2026-07-01T10:04:59.000Z'),
        taskStarted('2026-07-01T10:04:59.100Z'),
        codexUserLine('问题二', '2026-07-01T10:05:00.000Z'),
        taskStarted('2026-07-01T10:05:20.000Z'),
        turnContext('2026-07-01T10:05:20.100Z'),
        codexUserLine('问题二', '2026-07-01T10:05:21.000Z'),
        taskStarted('2026-07-01T10:05:40.000Z'),
        turnContext('2026-07-01T10:05:40.100Z'),
        codexUserLine('问题二', '2026-07-01T10:05:41.000Z'),
      ].join('\n') + '\n'

    const plan = planCodexSessionFork(content, {
      newSessionId: newCodexId,
      forkPoint: { content: '问题二', createdAtMs: Date.parse('2026-07-01T10:05:40.000Z') },
    })

    assert.ok(plan)
    assert.ok(!plan.includes('问题二'), 'every duplicate delivery must be cut')
    assert.ok(!plan.includes('turn_context'))
    assert.ok(plan.includes('回答一'))
  })

  it('returns null when the rollout has no session_meta line', () => {
    const content = buildCodexFixture().split('\n').slice(1).join('\n')
    const plan = planCodexSessionFork(content, {
      newSessionId: newCodexId,
      forkPoint: { content: '问题二', createdAtMs: Date.parse('2026-07-01T10:04:58.000Z') },
    })
    assert.equal(plan, null)
  })
})

describe('forkProviderSession', () => {
  it('forks a Claude session file next to the source without touching it', async () => {
    const projectDir = path.join(externalHomeDir, '.claude', 'projects', 'D--Git-project')
    fs.mkdirSync(projectDir, { recursive: true })
    const sourcePath = path.join(projectDir, `${srcClaudeId}.jsonl`)
    const sourceContent = buildClaudeFixture()
    fs.writeFileSync(sourcePath, sourceContent, 'utf8')

    const forkedId = await forkProviderSession({
      provider: 'claude',
      workspacePath: 'D:\\Git\\project',
      sessionId: srcClaudeId,
      forkPoint: { content: '第二个问题', createdAt: '2026-07-01T10:04:58.000Z' },
    })

    assert.ok(forkedId)
    assert.notEqual(forkedId, srcClaudeId)
    const forkedPath = path.join(projectDir, `${forkedId}.jsonl`)
    assert.ok(fs.existsSync(forkedPath))
    const forkedContent = fs.readFileSync(forkedPath, 'utf8')
    assert.ok(forkedContent.includes('第一个问题'))
    assert.ok(!forkedContent.includes('第二个回答'))
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceContent)
  })

  it('forks a Codex rollout with the new id in the filename and meta line', async () => {
    const dayDir = path.join(externalHomeDir, '.codex', 'sessions', '2026', '07', '01')
    fs.mkdirSync(dayDir, { recursive: true })
    const sourcePath = path.join(dayDir, `rollout-2026-07-01T10-00-00-${srcCodexId}.jsonl`)
    const sourceContent = buildCodexFixture()
    fs.writeFileSync(sourcePath, sourceContent, 'utf8')

    const forkedId = await forkProviderSession({
      provider: 'codex',
      workspacePath: 'D:\\Git\\project',
      sessionId: srcCodexId,
      forkPoint: { content: '问题二', createdAt: '2026-07-01T10:04:58.000Z' },
    })

    assert.ok(forkedId)
    assert.notEqual(forkedId, srcCodexId)
    const forkedPath = path.join(dayDir, `rollout-2026-07-01T10-00-00-${forkedId}.jsonl`)
    assert.ok(fs.existsSync(forkedPath))
    const forkedContent = fs.readFileSync(forkedPath, 'utf8')
    const meta = JSON.parse(forkedContent.split('\n')[0]!) as { payload?: { id?: string } }
    assert.equal(meta.payload?.id, forkedId)
    assert.ok(!forkedContent.includes('问题二'))
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceContent)
  })

  it('returns null when the source session file cannot be found', async () => {
    const forkedId = await forkProviderSession({
      provider: 'claude',
      workspacePath: 'D:\\Git\\project',
      sessionId: 'cccccccc-0000-0000-0000-000000000009',
      forkPoint: { content: '第二个问题', createdAt: '2026-07-01T10:04:58.000Z' },
    })
    assert.equal(forkedId, null)
  })
})
