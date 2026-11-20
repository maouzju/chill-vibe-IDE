import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { ensureAudioCached } from '../server/whitenoise/audio-cache.ts'

// 缺陷形态就是「Promise 永不落定」或「响应回调里同步抛出变成 uncaughtException」，
// node --test 默认无超时，红阶段会挂死而不是报红，所以每条都带护栏。
const guarded = { timeout: 15_000 }
const AUDIO_BYTES = Buffer.from('ID3-fake-mp3-bytes')

describe('ensureAudioCached download robustness', () => {
  let dataDir = ''
  let previousDataDir: string | undefined
  let server: http.Server
  let baseUrl = ''
  let hangNextRequest = true
  const openSockets = new Set<import('node:net').Socket>()

  before(async () => {
    previousDataDir = process.env.CHILL_VIBE_DATA_DIR
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-audio-cache-'))
    process.env.CHILL_VIBE_DATA_DIR = dataDir

    server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/hang-once.mp3') {
        if (hangNextRequest) {
          hangNextRequest = false
          return // accept the request and never answer
        }
        res.writeHead(200, { 'content-type': 'audio/mpeg' })
        res.end(AUDIO_BYTES)
        return
      }
      if (url === '/partial.mp3') {
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '100000' })
        res.write(AUDIO_BYTES)
        setTimeout(() => req.socket.destroy(), 30)
        return
      }
      if (url === '/relative-redirect.mp3') {
        res.writeHead(302, { location: '/files/real.mp3' })
        res.end()
        return
      }
      if (url === '/files/real.mp3') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' })
        res.end(AUDIO_BYTES)
        return
      }
      if (url === '/to-https.mp3') {
        const { port } = server.address() as AddressInfo
        // Same plain-http port behind an https:// URL: the TLS handshake fails, which
        // must surface as a rejection rather than a synchronous ERR_INVALID_PROTOCOL.
        res.writeHead(302, { location: `https://127.0.0.1:${port}/files/real.mp3` })
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.on('connection', (socket) => {
      openSockets.add(socket)
      socket.on('close', () => openSockets.delete(socket))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    for (const socket of openSockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (previousDataDir === undefined) delete process.env.CHILL_VIBE_DATA_DIR
    else process.env.CHILL_VIBE_DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  const cacheFiles = () => {
    const dir = path.join(dataDir, 'audio-cache')
    return fs.existsSync(dir) ? fs.readdirSync(dir) : []
  }

  it('gives up on a server that never answers, and a later call can retry', guarded, async () => {
    const url = `${baseUrl}/hang-once.mp3`

    await assert.rejects(
      ensureAudioCached('test-hang', url, { idleTimeoutMs: 200 }),
      /timed out/i,
      'a silent server must not pin the download promise forever',
    )

    // The failed attempt must be gone from the in-flight table, otherwise every later
    // request for this generator reuses the dead promise until the app restarts.
    const cached = await ensureAudioCached('test-hang', url, { idleTimeoutMs: 2_000 })
    assert.deepEqual(fs.readFileSync(cached), AUDIO_BYTES)
  })

  it('rejects when the connection drops mid-body and leaves no temp file', guarded, async () => {
    await assert.rejects(ensureAudioCached('test-partial', `${baseUrl}/partial.mp3`, { idleTimeoutMs: 2_000 }))
    assert.deepEqual(
      cacheFiles().filter((name) => name.startsWith('test-partial')),
      [],
      'a truncated download must not leave a .tmp or a half file behind',
    )
  })

  it('follows a relative Location header', guarded, async () => {
    const cached = await ensureAudioCached('test-relative', `${baseUrl}/relative-redirect.mp3`)
    assert.deepEqual(fs.readFileSync(cached), AUDIO_BYTES)
  })

  it('rejects instead of crashing when a redirect switches protocol and then fails', guarded, async () => {
    await assert.rejects(ensureAudioCached('test-to-https', `${baseUrl}/to-https.mp3`, { idleTimeoutMs: 2_000 }))
  })
})
