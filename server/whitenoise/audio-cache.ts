import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import path from 'node:path'

import { getAppDataDir } from '../app-paths.js'

// ── Runtime-fetched sample audio sources ──────────────────────────────────
// These files are downloaded on demand and are not bundled in this repository.
// See THIRD_PARTY.md for source and usage notes.

export const AUDIO_SOURCES: Record<string, { url: string; ext: string }> = {
  rain:    { url: 'https://raw.githubusercontent.com/bradtraversy/ambient-sound-mixer/main/audio/rain.mp3', ext: '.mp3' },
  wind:    { url: 'https://raw.githubusercontent.com/bradtraversy/ambient-sound-mixer/main/audio/wind.mp3', ext: '.mp3' },
  stream:  { url: 'https://raw.githubusercontent.com/mateusfg7/Noisekun/main/.github/assets/sounds/stream-water.ogg', ext: '.ogg' },
  fire:    { url: 'https://raw.githubusercontent.com/bradtraversy/ambient-sound-mixer/main/audio/fireplace.mp3', ext: '.mp3' },
  night:   { url: 'https://raw.githubusercontent.com/bradtraversy/ambient-sound-mixer/main/audio/night.mp3', ext: '.mp3' },
  thunder: { url: 'https://raw.githubusercontent.com/bradtraversy/ambient-sound-mixer/main/audio/thunder.mp3', ext: '.mp3' },
  cafe:    { url: 'https://raw.githubusercontent.com/bradtraversy/ambient-sound-mixer/main/audio/cafe.mp3', ext: '.mp3' },
  ocean:   { url: 'https://raw.githubusercontent.com/bradtraversy/ambient-sound-mixer/main/audio/ocean.mp3', ext: '.mp3' },
  birds:   { url: 'https://raw.githubusercontent.com/bradtraversy/ambient-sound-mixer/main/audio/birds.mp3', ext: '.mp3' },
  cat:     { url: 'https://bigsoundbank.com/UPLOAD/mp3/1010.mp3', ext: '.mp3' },
}

export const SAMPLE_GENERATORS = new Set<string>(Object.keys(AUDIO_SOURCES))

// ── Cache directory ────────────────────────────────────────────────────────

function getAudioCacheDir(): string {
  return path.join(getAppDataDir(), 'audio-cache')
}

function extFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const ext = path.extname(pathname)
    if (['.mp3', '.ogg', '.wav', '.flac', '.opus', '.m4a'].includes(ext)) return ext
  } catch { /* ignore */ }
  return '.mp3'
}

export function getCachedAudioPath(generator: string): string | null {
  const cacheDir = getAudioCacheDir()
  // Check for any cached file matching the generator name
  for (const ext of ['.mp3', '.ogg', '.wav', '.flac']) {
    const filePath = path.join(cacheDir, `${generator}${ext}`)
    if (fs.existsSync(filePath)) return filePath
  }
  return null
}

// ── Download with follow-redirect ──────────────────────────────────────────

// Socket inactivity budget, not a total-duration cap: a slow but progressing
// download is never cut off, only a connection that goes silent.
export const AUDIO_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000

function downloadFile(url: string, dest: string, idleTimeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(dest)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const tmpDest = dest + '.tmp'
    let settled = false
    let activeFile: fs.WriteStream | null = null
    const removeTmp = () => {
      try { fs.unlinkSync(tmpDest) } catch { /* never created or already gone */ }
    }
    // Reject only after the half-written .tmp is closed and removed, so an
    // immediate retry never races the old handle for the same temp path.
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      const file = activeFile
      if (!file) {
        reject(err)
        return
      }
      const cleanUpAndReject = () => {
        removeTmp()
        reject(err)
      }
      if (file.closed) {
        cleanUpAndReject()
        return
      }
      file.once('close', cleanUpAndReject)
      file.destroy()
    }

    // 症状：白噪音卡永远「加载中」，同名 generator 重启前再也加载不了；相对 Location / 跨协议跳转直接 uncaughtException。
    // 根因（2026-11-20 审查）：裸 get 无超时、res 出错/断流没人监听，Promise 永不落定；协议只按首个 URL 选一次，
    //   重定向地址原样交给 get，在响应回调里同步抛 ERR_INVALID_URL / ERR_INVALID_PROTOCOL，外层 Promise 接不到。
    // 每一跳都要 new URL(location, 当前地址) 再按协议选 http/https，且 get 必须包在 try 里——别改回「只选一次 get」。
    function doRequest(requestUrl: string, redirectCount: number) {
      if (redirectCount > 5) {
        fail(new Error('Too many redirects'))
        return
      }

      let req: http.ClientRequest
      try {
        const get = new URL(requestUrl).protocol === 'http:' ? http.get : https.get
        req = get(requestUrl, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume() // drain the response to free the socket
            let nextUrl: string
            try {
              nextUrl = new URL(res.headers.location, requestUrl).toString()
            } catch (err) {
              fail(err as Error)
              return
            }
            doRequest(nextUrl, redirectCount + 1)
            return
          }

          if (!res.statusCode || res.statusCode >= 400) {
            res.resume()
            fail(new Error(`HTTP ${res.statusCode} downloading ${requestUrl}`))
            return
          }

          const file = fs.createWriteStream(tmpDest)
          activeFile = file
          // res.pipe(file) does not forward response errors or a dropped connection
          // to the file stream, so neither 'finish' nor 'error' would ever fire.
          res.on('error', fail)
          res.on('close', () => {
            if (!res.complete) fail(new Error(`Connection dropped downloading ${requestUrl}`))
          })
          res.pipe(file)
          file.on('finish', () => {
            file.close(() => {
              if (settled) {
                removeTmp()
                return
              }
              try {
                fs.renameSync(tmpDest, dest)
              } catch (err) {
                fail(err as Error)
                return
              }
              settled = true
              resolve()
            })
          })
          file.on('error', (err) => {
            req.destroy()
            fail(err)
          })
        })
      } catch (err) {
        fail(err as Error)
        return
      }

      req.setTimeout(idleTimeoutMs, () => {
        req.destroy(new Error(`Download timed out after ${idleTimeoutMs}ms of inactivity: ${requestUrl}`))
      })
      req.on('error', fail)
    }

    doRequest(url, 0)
  })
}

// ── Public API ─────────────────────────────────────────────────────────────

const downloadInProgress = new Map<string, Promise<string>>()

/**
 * Ensure the audio file for a generator is cached locally.
 * Returns the absolute path to the cached file.
 * Downloads on first access; subsequent calls return immediately.
 *
 * @param generator - the generator name (used as cache key)
 * @param url - optional direct download URL (for dynamically-sourced audio)
 */
export async function ensureAudioCached(
  generator: string,
  url?: string,
  options?: { idleTimeoutMs?: number },
): Promise<string> {
  // Determine download URL: explicit url > legacy AUDIO_SOURCES fallback
  const legacySource = AUDIO_SOURCES[generator]
  const downloadUrl = url || legacySource?.url
  if (!downloadUrl) throw new Error(`No audio source for generator: ${generator}`)

  const ext = url ? extFromUrl(url) : (legacySource?.ext ?? '.mp3')
  const filePath = path.join(getAudioCacheDir(), `${generator}${ext}`)

  // Already cached
  if (fs.existsSync(filePath)) return filePath

  // Also check if cached under a different extension (from a previous dynamic URL)
  const existing = getCachedAudioPath(generator)
  if (existing) return existing

  // Deduplicate concurrent downloads for the same generator
  const inProgress = downloadInProgress.get(generator)
  if (inProgress) return inProgress

  const promise = downloadFile(downloadUrl, filePath, options?.idleTimeoutMs ?? AUDIO_DOWNLOAD_IDLE_TIMEOUT_MS)
    .then(() => {
      downloadInProgress.delete(generator)
      return filePath
    })
    .catch((err) => {
      downloadInProgress.delete(generator)
      throw err
    })

  downloadInProgress.set(generator, promise)
  return promise
}
