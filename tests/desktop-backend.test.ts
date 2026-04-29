import assert from 'node:assert/strict'
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
          return false
        },
        subscribe() {
          return null
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
        return false
      },
      subscribe() {
        return null
      },
    }),
  })

  await assert.doesNotReject(() => backend.stopChat('stale-stream'))
  assert.deepEqual(stoppedStreamIds, ['stale-stream'])
})
