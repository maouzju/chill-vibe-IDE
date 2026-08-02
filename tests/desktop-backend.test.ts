import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDesktopBackend } from '../electron/backend.ts'

test('desktop backend delays manager construction until the matching feature is used', async () => {
  let chatManagerFactoryCalls = 0
  let setupManagerFactoryCalls = 0
  let musicManagerFactoryCalls = 0
  let setupDisposed = 0
  let musicDisposed = 0
  const setupRequests: unknown[] = []

  const backend = createDesktopBackend({
    createChatManager: () => {
      chatManagerFactoryCalls += 1
      return {
        closeAll() {},
        createStream() {
          throw new Error('not used in this test')
        },
        stop() {
          return { stopped: false, settlingWithinMs: 0 }
        },
        subscribe() {
          return null
        },
        tapAll() {
          return () => undefined
        },
        listActiveStreams() {
          return []
        },
      }
    },
    createSetupManager: () => {
      setupManagerFactoryCalls += 1
      return {
        getStatus() {
          return { state: 'idle', logs: [] }
        },
        start(request?: unknown) {
          setupRequests.push(request)
          return { state: 'running', logs: [] }
        },
        dispose() {
          setupDisposed += 1
        },
      }
    },
    createMusicManager: () => {
      musicManagerFactoryCalls += 1
      return {
        getLoginStatus() {
          return { authenticated: false, userId: 0, nickname: '', avatarUrl: '' }
        },
        async createQrLogin() {
          throw new Error('not used in this test')
        },
        async checkQrLogin() {
          throw new Error('not used in this test')
        },
        async logout() {
          musicDisposed += 1
        },
        async fetchPlaylists() {
          throw new Error('not used in this test')
        },
        async fetchPlaylistTracks() {
          throw new Error('not used in this test')
        },
        async getSongUrl() {
          throw new Error('not used in this test')
        },
        async recordPlay() {
          throw new Error('not used in this test')
        },
        async getExplorePlaylists() {
          throw new Error('not used in this test')
        },
      }
    },
  })

  assert.equal(chatManagerFactoryCalls, 0)
  assert.equal(setupManagerFactoryCalls, 0)
  assert.equal(musicManagerFactoryCalls, 0)

  assert.deepEqual(backend.fetchSetupStatus(), { state: 'idle', logs: [] })
  assert.equal(setupManagerFactoryCalls, 1)
  assert.equal(chatManagerFactoryCalls, 0)
  assert.equal(musicManagerFactoryCalls, 0)

  assert.deepEqual(backend.runEnvironmentSetup({ mode: 'update-cli', cli: 'codex', version: '0.23.4' }), {
    state: 'running',
    logs: [],
  })
  assert.deepEqual(setupRequests, [{ mode: 'update-cli', cli: 'codex', version: '0.23.4' }])

  assert.deepEqual(backend.fetchMusicLoginStatus(), {
    authenticated: false,
    userId: 0,
    nickname: '',
    avatarUrl: '',
  })
  assert.equal(musicManagerFactoryCalls, 1)
  assert.equal(chatManagerFactoryCalls, 0)

  await backend.dispose()
  assert.equal(setupDisposed, 1)
  assert.equal(musicDisposed, 0)
  assert.equal(chatManagerFactoryCalls, 0)
})


test('desktop backend treats stopping an already-settled stream as idempotent', async () => {
  const stoppedStreamIds: string[] = []
  const backend = createDesktopBackend({
    createChatManager: () => ({
      closeAll() {},
      createStream() {
        throw new Error('not used in this test')
      },
      stop(streamId: string) {
        stoppedStreamIds.push(streamId)
        return { stopped: false, settlingWithinMs: 0 }
      },
      subscribe() {
        return null
      },
      tapAll() {
        return () => undefined
      },
      listActiveStreams() {
        return []
      },
    }),
  })

  await assert.doesNotReject(() => backend.stopChat('stale-stream'))
  assert.deepEqual(stoppedStreamIds, ['stale-stream'])
})

test('desktop backend reports completed native Codex turns instead of discarding them', async () => {
  const previousHistoryHome = process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-backend-codex-completion-'))
  const sessionId = '019fa53b-a772-7ad1-bffd-bf23fa012a4d'
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '28')
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionsDir, `rollout-2026-07-28T04-19-42-${sessionId}.jsonl`),
    [
      JSON.stringify({
        timestamp: '2026-07-27T20:19:49.958Z',
        type: 'event_msg',
        payload: { type: 'task_started' },
      }),
      JSON.stringify({
        timestamp: '2026-07-27T20:41:12.602Z',
        type: 'event_msg',
        payload: { type: 'task_complete' },
      }),
    ].join('\n'),
    'utf8',
  )

  process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME = homeDir
  try {
    const backend = createDesktopBackend()
    assert.deepEqual(
      await backend.getNativeTurnCompletion({ provider: 'codex', sessionId }),
      { completion: 'completed' },
    )
    await backend.dispose()
  } finally {
    if (previousHistoryHome === undefined) {
      delete process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME
    } else {
      process.env.CHILL_VIBE_EXTERNAL_HISTORY_HOME = previousHistoryHome
    }
    fs.rmSync(homeDir, { recursive: true, force: true })
  }
})
