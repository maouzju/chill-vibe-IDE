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

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(dest)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const get = url.startsWith('https') ? https.get : http.get

    function doRequest(requestUrl: string, redirectCount: number) {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'))
        return
      }

      get(requestUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume() // drain the response to free the socket
          doRequest(res.headers.location, redirectCount + 1)
          return
        }

        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${requestUrl}`))
          return
        }

        const tmpDest = dest + '.tmp'
        const file = fs.createWriteStream(tmpDest)
        res.pipe(file)
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmpDest, dest)
            resolve()
          })
        })
        file.on('error', (err) => {
          fs.unlinkSync(tmpDest)
          reject(err)
        })
      }).on('error', reject)
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
export async function ensureAudioCached(generator: string, url?: string): Promise<string> {
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

  const promise = downloadFile(downloadUrl, filePath)
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
