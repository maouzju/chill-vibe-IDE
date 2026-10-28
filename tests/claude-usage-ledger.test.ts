import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  attributeClaudeProject,
  createClaudeUsageLedger,
  ledgerCacheFileName,
  ledgerCacheVersion,
} from '../server/claude-usage-ledger.ts'

const ts = (day: string, hour = 12, minute = 0) => {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date, hour, minute, 0, 0).toISOString()
}

type UsageOverrides = Partial<{
  input: number
  output: number
  cacheWrite: number
  cacheWrite1h: number
  cacheRead: number
}>

const assistantLine = ({
  id,
  requestId = 'req_1',
  model = 'claude-opus-5-5',
  cwd = 'D:\\Git\\other-repo',
  sessionId = 'sess-1',
  timestamp = ts('2026-10-20'),
  usage = {},
}: {
  id: string
  requestId?: string
  model?: string
  cwd?: string
  sessionId?: string
  timestamp?: string
  usage?: UsageOverrides
}) =>
  JSON.stringify({
    type: 'assistant',
    cwd,
    sessionId,
    requestId,
    timestamp,
    message: {
      id,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: usage.input ?? 1000,
        output_tokens: usage.output ?? 100,
        cache_creation_input_tokens: usage.cacheWrite ?? 0,
        cache_creation: { ephemeral_1h_input_tokens: usage.cacheWrite1h ?? 0 },
        cache_read_input_tokens: usage.cacheRead ?? 0,
      },
    },
  })

const userLine = ({
  uuid,
  text,
  cwd = 'D:\\Git\\other-repo',
  sessionId = 'sess-1',
  timestamp = ts('2026-10-20'),
  extra = {},
}: {
  uuid: string
  text: string
  cwd?: string
  sessionId?: string
  timestamp?: string
  extra?: Record<string, unknown>
}) =>
  JSON.stringify({
    type: 'user',
    uuid,
    cwd,
    sessionId,
    timestamp,
    message: { role: 'user', content: text },
    ...extra,
  })

describe('claude usage ledger', () => {
  let tmpDir: string
  let homeDir: string
  let dataDir: string
  let projectDir: string
  const originalHome = process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME

  const writeJsonl = (relative: string, lines: string[], trailingNewline = true) => {
    const filePath = path.join(projectDir, relative)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, lines.join('\n') + (trailingNewline ? '\n' : ''), 'utf8')
    return filePath
  }

  const query = async (ledger: ReturnType<typeof createClaudeUsageLedger>, overrides: Record<string, unknown> = {}) =>
    ledger.query({ from: '2000-01-01', to: '2099-12-31', workspaces: [], urgeMessages: [], refresh: false, ...overrides })

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-ledger-'))
    homeDir = path.join(tmpDir, 'home')
    dataDir = path.join(tmpDir, 'data')
    projectDir = path.join(homeDir, '.claude', 'projects', 'd--Git-other-repo')
    fs.mkdirSync(projectDir, { recursive: true })
    process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME = homeDir
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME
    } else {
      process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME = originalHome
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('takes the per-field maximum across streamed rows of one reply and ignores later copies', async () => {
    writeJsonl('main.jsonl', [
      assistantLine({ id: 'msg_a', usage: { input: 1000, output: 5, cacheRead: 2000 } }),
      assistantLine({ id: 'msg_a', usage: { input: 1000, output: 60, cacheRead: 2000 } }),
      assistantLine({ id: 'msg_a', usage: { input: 1000, output: 240, cacheRead: 2000 } }),
    ])
    // fork / 子 agent 文件把同一条回复再抄一遍：整条忽略
    writeJsonl('fork.jsonl', [
      assistantLine({ id: 'msg_a', usage: { input: 1000, output: 240, cacheRead: 2000 } }),
    ])
    writeJsonl(path.join('sess-1', 'subagents', 'agent-1.jsonl'), [
      assistantLine({ id: 'msg_a', usage: { input: 1000, output: 999, cacheRead: 2000 } }),
    ])

    const ledger = createClaudeUsageLedger({ dataDir })
    await ledger.scan()

    const result = await query(ledger)
    assert.equal(result.projects.length, 1)
    const project = result.projects[0]
    assert.equal(project.id, 'other-repo')
    assert.equal(project.tokens, 1000 + 240 + 2000)
    assert.equal(project.outputTokens, 240)
    // opus-5-5：1000 × 4 + 240 × 20 + 2000 × 0.2 = 4000 + 4800 + 400 → /1e6
    assert.ok(Math.abs(project.costUsd - 0.0092) < 1e-9)
    assert.equal(project.sessions, 1)
    assert.deepEqual(Object.keys(project.costByFamily), ['opus'])
  })

  it('reads only complete lines and resumes at the recorded offset', async () => {
    const complete = assistantLine({ id: 'msg_1', usage: { input: 100, output: 10 } })
    const half = assistantLine({ id: 'msg_2', usage: { input: 100, output: 10 } })
    const filePath = writeJsonl('main.jsonl', [complete])
    // 文件还在写：第二行没有换行符
    fs.appendFileSync(filePath, half.slice(0, Math.floor(half.length / 2)), 'utf8')

    const ledger = createClaudeUsageLedger({ dataDir })
    await ledger.scan()
    assert.equal((await query(ledger)).kpi.totalTokens, 110)

    // 写完剩下的半行 + 再追加一条
    fs.appendFileSync(
      filePath,
      `${half.slice(Math.floor(half.length / 2))}\n${assistantLine({ id: 'msg_3', usage: { input: 100, output: 10 } })}\n`,
      'utf8',
    )
    await ledger.scan()
    assert.equal((await query(ledger)).kpi.totalTokens, 330)
  })

  it('continues a streamed reply that straddles two incremental reads', async () => {
    const filePath = writeJsonl('main.jsonl', [
      assistantLine({ id: 'msg_s', usage: { input: 100, output: 5 } }),
    ])
    const ledger = createClaudeUsageLedger({ dataDir })
    await ledger.scan()
    assert.equal((await query(ledger)).kpi.outputTokens, 5)

    fs.appendFileSync(filePath, `${assistantLine({ id: 'msg_s', usage: { input: 100, output: 80 } })}\n`, 'utf8')
    await ledger.scan()
    // 续读到同一条回复的更大值：桶里是最大值，不是两次之和
    assert.equal((await query(ledger)).kpi.outputTokens, 80)
    assert.equal((await query(ledger)).kpi.totalTokens, 180)
  })

  it('rereads a file from zero when it shrinks, without double counting', async () => {
    const filePath = writeJsonl('main.jsonl', [
      assistantLine({ id: 'msg_1', usage: { input: 100, output: 10 } }),
      assistantLine({ id: 'msg_2', usage: { input: 100, output: 10 } }),
    ])
    const ledger = createClaudeUsageLedger({ dataDir })
    await ledger.scan()
    assert.equal((await query(ledger)).kpi.totalTokens, 220)

    // 文件被重写成更短的版本：旧键被去重集合挡住，新键照常入账
    fs.writeFileSync(
      filePath,
      `${assistantLine({ id: 'msg_1', usage: { input: 100, output: 10 } })}\n${assistantLine({ id: 'msg_4', usage: { input: 7, output: 1 } })}\n`,
      'utf8',
    )
    await ledger.scan()
    assert.equal((await query(ledger)).kpi.totalTokens, 228)
  })

  it('persists the cache and reloads it, discarding a stale version', async () => {
    writeJsonl('main.jsonl', [assistantLine({ id: 'msg_1', usage: { input: 100, output: 10 } })])
    const ledger = createClaudeUsageLedger({ dataDir })
    await ledger.scan()
    await ledger.flush()

    const cachePath = path.join(dataDir, ledgerCacheFileName)
    assert.ok(fs.existsSync(cachePath))

    const reloaded = createClaudeUsageLedger({ dataDir })
    assert.equal((await query(reloaded)).kpi.totalTokens, 110)
    // 再扫一次不打开 size 没变的文件，也不重复计数
    await reloaded.scan()
    assert.equal((await query(reloaded)).kpi.totalTokens, 110)

    const stale = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    stale.version = ledgerCacheVersion - 1
    fs.writeFileSync(cachePath, JSON.stringify(stale), 'utf8')
    const discarded = createClaudeUsageLedger({ dataDir })
    assert.equal((await query(discarded)).kpi.totalTokens, 0)
    await discarded.scan()
    assert.equal((await query(discarded)).kpi.totalTokens, 110)
  })

  it('counts only hand-typed prompts and dedupes them by uuid', async () => {
    writeJsonl('main.jsonl', [
      userLine({ uuid: 'u1', text: '帮我修 bug' }),
      userLine({ uuid: 'u1', text: '帮我修 bug' }),
      userLine({ uuid: 'u2', text: 'Analyze this image:\nC:\\a.png\n\n看图' }),
      userLine({ uuid: 'u3', text: 'Please continue.' }),
      userLine({ uuid: 'u4', text: '<command-name>/compact</command-name>' }),
      userLine({ uuid: 'u5', text: 'meta', extra: { isMeta: true } }),
      userLine({ uuid: 'u6', text: 'side', extra: { isSidechain: true } }),
      userLine({ uuid: 'u7', text: 'summary', extra: { isCompactSummary: true } }),
      userLine({ uuid: 'u8', text: '快点干活' }),
    ])
    const ledger = createClaudeUsageLedger({ dataDir })
    ledger.setUrgeMessages(['快点干活'])
    await ledger.scan()

    const result = await query(ledger)
    assert.equal(result.projects[0]?.prompts, 2)
    assert.equal(result.projects[0]?.promptChars, '帮我修 bug'.length + '看图'.length)
    assert.deepEqual(result.daily.prompts['2026-10-20'], { 'other-repo': 2 })
  })

  it('filters by local day, computes KPIs and keeps colors on the all-time order', async () => {
    writeJsonl('main.jsonl', [
      assistantLine({ id: 'a1', cwd: 'D:\\Git\\other-repo', sessionId: 's1', timestamp: ts('2026-10-01'), usage: { input: 1_000_000 } }),
      assistantLine({ id: 'a2', cwd: 'D:\\Git\\other-repo', sessionId: 's2', timestamp: ts('2026-10-02'), usage: { input: 1_000_000 } }),
      assistantLine({ id: 'a3', cwd: 'D:\\Git\\docs-site\\worktree', sessionId: 's3', timestamp: ts('2026-10-02'), usage: { input: 500_000, output: 0 } }),
      assistantLine({ id: 'a4', cwd: 'D:\\Git\\example-wiki', sessionId: 's4', timestamp: ts('2026-09-01'), usage: { input: 10_000_000 } }),
    ])
    const ledger = createClaudeUsageLedger({ dataDir })
    await ledger.scan()

    const result = await query(ledger, { from: '2026-10-01', to: '2026-10-02' })
    assert.equal(result.kpi.sessions, 3)
    assert.equal(result.kpi.projects, 2)
    assert.equal(result.kpi.activeDays, 2)
    assert.equal(result.kpi.topProject, 'other-repo')
    assert.ok(Math.abs(result.kpi.dailyAverageCostUsd - result.kpi.totalCostUsd / 2) < 1e-9)
    assert.equal(result.projects[0]?.id, 'other-repo')
    assert.equal(result.projects[0]?.path, 'D:\\Git\\other-repo')
    assert.equal(result.projects[1]?.id, 'docs-site')
    assert.equal(result.projects[1]?.path, 'D:\\Git\\docs-site')
    assert.ok(Math.abs(result.projects[0]!.share + result.projects[1]!.share - 1) < 1e-9)
    assert.equal(result.projects[0]?.lastUsedAt, ts('2026-10-02'))
    // 全时段 example-wiki 最贵，筛时段里它不出现，但颜色顺序仍以它为首
    assert.deepEqual(result.colorOrder, ['example-wiki', 'other-repo', 'docs-site'])
    assert.deepEqual(result.span, { from: '2026-09-01', to: '2026-10-02' })
    assert.deepEqual(Object.keys(result.daily.cost).sort(), ['2026-10-01', '2026-10-02'])
    assert.equal(result.scan.scanning, false)
    assert.ok(result.scan.lastScanAt)
  })

  it('attributes cwd to a configured workspace before the Git folder rule', async () => {
    writeJsonl('main.jsonl', [
      assistantLine({ id: 'a1', cwd: 'D:\\Git\\other-repo\\.claude\\worktrees\\x', usage: { input: 10 } }),
    ])
    const ledger = createClaudeUsageLedger({ dataDir })
    await ledger.scan()
    const result = await query(ledger, { workspaces: ['E:\\work\\MyGame', 'd:/git/other-repo'] })
    assert.equal(result.projects[0]?.id, 'other-repo')
    assert.equal(result.projects[0]?.path, 'd:/git/other-repo')
  })

  it('skips rows whose model family is unknown', async () => {
    writeJsonl('main.jsonl', [
      assistantLine({ id: 'a1', model: '<synthetic>', usage: { input: 10 } }),
      assistantLine({ id: 'a2', model: 'claude-sonnet-5-5', usage: { input: 10 } }),
    ])
    const ledger = createClaudeUsageLedger({ dataDir })
    await ledger.scan()
    assert.equal((await query(ledger)).kpi.totalTokens, 110)
  })
})

describe('attributeClaudeProject', () => {
  const home = 'C:\\Users\\me'
  const tmp = 'C:\\Users\\me\\AppData\\Local\\Temp'

  it('prefers configured workspaces, then X:\\Git\\<name>, then the leaf directory', () => {
    assert.deepEqual(
      attributeClaudeProject('E:\\work\\MyGame\\sub', { workspaces: ['E:\\work\\MyGame'], home, tmp }),
      { id: 'MyGame', path: 'E:\\work\\MyGame' },
    )
    assert.deepEqual(
      attributeClaudeProject('D:/Git/other-repo/.claude/worktrees/w1', { workspaces: [], home, tmp }),
      { id: 'other-repo', path: 'D:\\Git\\other-repo' },
    )
    assert.deepEqual(
      attributeClaudeProject('F:\\proj\\thing', { workspaces: [], home, tmp }),
      { id: 'thing', path: 'F:\\proj\\thing' },
    )
  })

  it('buckets temp, git root, claude config and home into special projects', () => {
    assert.deepEqual(
      attributeClaudeProject(`${tmp}\\abc123`, { workspaces: [], home, tmp }),
      { id: '(temp)', path: null },
    )
    assert.deepEqual(attributeClaudeProject('D:\\Git', { workspaces: [], home, tmp }), { id: '(git-root)', path: null })
    assert.deepEqual(
      attributeClaudeProject(`${home}\\.claude\\skills`, { workspaces: [], home, tmp }),
      { id: '(claude-config)', path: null },
    )
    assert.deepEqual(attributeClaudeProject(home, { workspaces: [], home, tmp }), { id: '(home)', path: null })
    assert.deepEqual(attributeClaudeProject('', { workspaces: [], home, tmp }), { id: '(unknown)', path: null })
  })
})
