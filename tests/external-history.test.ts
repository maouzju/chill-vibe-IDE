import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, describe, it } from 'node:test'
import fs from 'fs'
import path from 'path'
import os from 'os'

import { externalSessionSummarySchema, externalHistoryListResponseSchema } from '../shared/schema.ts'
import { listExternalSessions, loadExternalSession, clearSummaryCache } from '../server/external-history.ts'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-hist-test-'))
const dataDir = path.join(tmpDir, 'data')
const externalHomeDir = path.join(tmpDir, 'home')
const secondaryHomeDir = path.join(tmpDir, 'secondary-home')
const codexSessionsDir = path.join(externalHomeDir, '.codex', 'sessions')
const codexArchivedDir = path.join(externalHomeDir, '.codex', 'archived_sessions')
const codexIndexFile = path.join(dataDir, 'external-history-codex-index.json')
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
const originalHomeDrive = process.env.HOMEDRIVE
const originalHomePath = process.env.HOMEPATH

const ts1 = '2026-04-01T10:00:00.000Z'
const ts2 = '2026-04-01T10:05:00.000Z'
const fakeWorkspace = 'D:\\Git\\project'
const otherWorkspace = 'D:\\Git\\other-project'

type CodexFixture = {
  baseName: string
  sessionId: string
  workspacePath: string
  title: string
  model?: string
  startedAt?: string
  updatedAt?: string
  archived?: boolean
}

const writeCodexFixture = ({
  baseName,
  sessionId,
  workspacePath,
  title,
  model = 'gpt-5.4',
  startedAt = ts1,
  updatedAt = ts2,
  archived = false,
}: CodexFixture) => {
  const dayDir = path.join(
    archived ? codexArchivedDir : codexSessionsDir,
    '2026',
    '04',
    '01',
  )
  const filePath = path.join(dayDir, `${baseName}.jsonl`)

  fs.mkdirSync(dayDir, { recursive: true })
  fs.mkdirSync(path.dirname(path.join(externalHomeDir, '.codex', 'session_index.jsonl')), { recursive: true })
  fs.appendFileSync(
    path.join(externalHomeDir, '.codex', 'session_index.jsonl'),
    `${JSON.stringify({
      id: sessionId,
      thread_name: title,
      updated_at: updatedAt,
    })}\n`,
    'utf8',
  )

  const events = [
    {
      type: 'session_meta',
      timestamp: startedAt,
      payload: {
        id: sessionId,
        cwd: workspacePath,
        model,
        timestamp: startedAt,
      },
    },
    {
      type: 'event_msg',
      timestamp: startedAt,
      payload: {
        type: 'user_message',
        message: 'Help me debug this issue',
      },
    },
    {
      type: 'response_item',
      timestamp: updatedAt,
      payload: {
        role: 'assistant',
        type: 'message',
        content: [{ type: 'output_text', text: 'Sure, let us inspect it.' }],
      },
    },
  ]

  fs.writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')
  return filePath
}

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(externalHomeDir, { recursive: true, force: true })
  fs.rmSync(secondaryHomeDir, { recursive: true, force: true })
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(externalHomeDir, { recursive: true })
  process.env.CHILL_VIBE_DATA_DIR = dataDir
  process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME = externalHomeDir
  clearSummaryCache()
})

afterEach(() => {
  delete process.env.CHILL_VIBE_DATA_DIR
  delete process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalUserProfile
  }
  if (originalHomeDrive === undefined) {
    delete process.env.HOMEDRIVE
  } else {
    process.env.HOMEDRIVE = originalHomeDrive
  }
  if (originalHomePath === undefined) {
    delete process.env.HOMEPATH
  } else {
    process.env.HOMEPATH = originalHomePath
  }
  clearSummaryCache()
})

describe('external-history', () => {
  it('rejects a session summary with an empty title', () => {
    const result = externalSessionSummarySchema.safeParse({
      id: 'test-session',
      provider: 'codex',
      title: '',
      model: '',
      workspacePath: 'D:\\Git\\project',
      messageCount: 5,
      startedAt: ts1,
      updatedAt: ts2,
    })
    assert.equal(result.success, false, 'Empty title must fail Zod validation')
  })

  it('accepts a session summary with a non-empty title', () => {
    const result = externalSessionSummarySchema.safeParse({
      id: 'test-session',
      provider: 'codex',
      title: 'Codex session',
      model: '',
      workspacePath: 'D:\\Git\\project',
      messageCount: 5,
      startedAt: ts1,
      updatedAt: ts2,
    })
    assert.equal(result.success, true)
  })

  it('a single invalid session causes the entire response to fail', () => {
    const sessions = [
      {
        id: 'good-session',
        provider: 'claude' as const,
        title: 'Good session',
        model: '',
        workspacePath: 'D:\\Git\\project',
        messageCount: 3,
        startedAt: ts1,
        updatedAt: ts2,
      },
      {
        id: 'bad-session',
        provider: 'codex' as const,
        title: '',
        model: '',
        workspacePath: 'D:\\Git\\project',
        messageCount: 5,
        startedAt: ts1,
        updatedAt: ts2,
      },
    ]

    const result = externalHistoryListResponseSchema.safeParse({ sessions })
    assert.equal(result.success, false, 'Response with one bad session must fail')
  })

  it('fallback title passes validation when user text is empty', () => {
    const validSession = externalSessionSummarySchema.safeParse({
      id: 'codex:test-empty-title',
      provider: 'codex',
      title: 'Codex session',
      model: 'test-model',
      workspacePath: tmpDir,
      messageCount: 2,
      startedAt: ts1,
      updatedAt: ts2,
    })
    assert.equal(validSession.success, true, 'Fallback title must pass validation')
  })

  it('listExternalSessions returns consistent results on repeated calls (cache)', async () => {
    clearSummaryCache()

    // Use a non-existent workspace path so both providers return []
    const missingWorkspace = path.join(tmpDir, 'no-such-project')

    const result1 = await listExternalSessions({ workspacePath: missingWorkspace })
    const result2 = await listExternalSessions({ workspacePath: missingWorkspace })

    assert.deepEqual(result1, result2, 'Repeated calls must return the same result')
    assert.deepEqual(result1.sessions, [], 'Non-existent workspace must return empty sessions')
  })

  it('reuses the persisted Codex index after clearing in-memory caches', async () => {
    writeCodexFixture({
      baseName: 'rollout-2026-04-01T10-00-00-0195e0fd-1111-7111-8111-111111111111',
      sessionId: '0195e0fd-1111-7111-8111-111111111111',
      workspacePath: fakeWorkspace,
      title: 'Useful thread',
    })
    writeCodexFixture({
      baseName: 'rollout-2026-04-01T10-01-00-0195e0fd-2222-7222-8222-222222222222',
      sessionId: '0195e0fd-2222-7222-8222-222222222222',
      workspacePath: otherWorkspace,
      title: 'Other workspace thread',
    })

    const first = await listExternalSessions({ workspacePath: fakeWorkspace })
    assert.equal(first.sessions.length, 1)
    assert.equal(first.sessions[0]?.title, 'Useful thread')
    assert.equal(fs.existsSync(codexIndexFile), true, 'first list should persist a Codex index file')

    clearSummaryCache()

    const originalReaddirSync = fs.readdirSync
    fs.readdirSync = ((targetPath: fs.PathLike, options?: fs.ObjectEncodingOptions & { withFileTypes?: boolean }) => {
      const normalizedTarget = path.resolve(String(targetPath))
      if (
        normalizedTarget.startsWith(path.resolve(codexSessionsDir)) ||
        normalizedTarget.startsWith(path.resolve(codexArchivedDir))
      ) {
        throw new Error(`unexpected cold scan of ${normalizedTarget}`)
      }

      return originalReaddirSync(targetPath, options as never)
    }) as typeof fs.readdirSync

    try {
      const second = await listExternalSessions({ workspacePath: fakeWorkspace })
      assert.equal(second.sessions.length, 1)
      assert.equal(second.sessions[0]?.id, first.sessions[0]?.id)
      assert.equal(second.sessions[0]?.title, 'Useful thread')
    } finally {
      fs.readdirSync = originalReaddirSync
    }
  })

  it('loads a Codex session from the persisted index without a recursive file lookup', async () => {
    const baseName = 'rollout-2026-04-01T10-02-00-0195e0fd-3333-7333-8333-333333333333'
    const sessionId = '0195e0fd-3333-7333-8333-333333333333'
    writeCodexFixture({
      baseName,
      sessionId,
      workspacePath: fakeWorkspace,
      title: 'Indexed import thread',
    })

    await listExternalSessions({ workspacePath: fakeWorkspace })
    clearSummaryCache()

    const originalReaddirSync = fs.readdirSync
    fs.readdirSync = ((targetPath: fs.PathLike, options?: fs.ObjectEncodingOptions & { withFileTypes?: boolean }) => {
      const normalizedTarget = path.resolve(String(targetPath))
      if (
        normalizedTarget.startsWith(path.resolve(codexSessionsDir)) ||
        normalizedTarget.startsWith(path.resolve(codexArchivedDir))
      ) {
        throw new Error(`unexpected recursive lookup in ${normalizedTarget}`)
      }

      return originalReaddirSync(targetPath, options as never)
    }) as typeof fs.readdirSync

    try {
      const result = await loadExternalSession({
        provider: 'codex',
        sessionId: `codex:${baseName}`,
        workspacePath: fakeWorkspace,
      })

      assert.equal(result.entry.title, 'Help me debug this issue')
      assert.equal(result.entry.messages.length, 2)
    } finally {
      fs.readdirSync = originalReaddirSync
    }
  })

  it('prefers HOME-backed Codex history when packaged apps inherit a different USERPROFILE', async () => {
    delete process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME
    process.env.HOME = externalHomeDir
    process.env.USERPROFILE = secondaryHomeDir

    writeCodexFixture({
      baseName: 'rollout-2026-04-01T10-03-00-0195e0fd-4444-7444-8444-444444444444',
      sessionId: '0195e0fd-4444-7444-8444-444444444444',
      workspacePath: fakeWorkspace,
      title: 'HOME-backed thread',
    })

    clearSummaryCache()

    const result = await listExternalSessions({ workspacePath: fakeWorkspace })

    assert.equal(result.sessions.length, 1)
    assert.equal(result.sessions[0]?.title, 'HOME-backed thread')
  })
})
