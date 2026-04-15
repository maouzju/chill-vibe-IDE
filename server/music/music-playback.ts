// Music playback stats for Chill Vibe's experimental music features.

import fs from 'node:fs'
import path from 'node:path'

import { getAppDataDir } from '../app-paths.js'

const PLAYBACK_STORE_FILE = 'music-playback-stats.json'

type CountMap = Record<string, number>

type UserBucket = {
  localPlayCounts: CountMap
  cloudPlayCounts: CountMap
  cloudUpdatedAt: string
}

type PlaybackStore = {
  users: Record<string, UserBucket>
}

function getFilePath() {
  return path.join(getAppDataDir(), PLAYBACK_STORE_FILE)
}

function normalizeCountMap(input: unknown): CountMap {
  const next: CountMap = {}
  if (!input || typeof input !== 'object') return next
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const trackId = Number(key)
    const count = Number(value || 0)
    if (trackId > 0 && count > 0) next[String(trackId)] = count
  }
  return next
}

function normalizeUserBucket(input: Record<string, unknown> = {}): UserBucket {
  return {
    localPlayCounts: normalizeCountMap(input.localPlayCounts),
    cloudPlayCounts: normalizeCountMap(input.cloudPlayCounts),
    cloudUpdatedAt: typeof input.cloudUpdatedAt === 'string' ? input.cloudUpdatedAt : '',
  }
}

function normalizeStore(input: Record<string, unknown> = {}): PlaybackStore {
  const users: Record<string, UserBucket> = {}
  const rawUsers = (input.users || {}) as Record<string, unknown>
  for (const [userId, bucket] of Object.entries(rawUsers)) {
    const normalizedUserId = Number(userId)
    if (normalizedUserId > 0) {
      users[String(normalizedUserId)] = normalizeUserBucket(bucket as Record<string, unknown>)
    }
  }
  return { users }
}

function readPlaybackStore(): PlaybackStore {
  const filePath = getFilePath()
  try {
    if (!fs.existsSync(filePath)) return normalizeStore()
    return normalizeStore(JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>)
  } catch {
    return normalizeStore()
  }
}

function writePlaybackStore(store: PlaybackStore) {
  const filePath = getFilePath()
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${JSON.stringify(normalizeStore(store as unknown as Record<string, unknown>), null, 2)}\n`, 'utf8')
  } catch {
    // ignored
  }
}

function getUserBucket(store: PlaybackStore, userId: number): UserBucket {
  const key = String(userId)
  if (!store.users[key]) store.users[key] = normalizeUserBucket()
  return store.users[key]
}

export function getPlaybackStats(userId: number) {
  const store = readPlaybackStore()
  const bucket = getUserBucket(store, userId)
  return {
    localPlayCounts: { ...bucket.localPlayCounts },
    cloudPlayCounts: { ...bucket.cloudPlayCounts },
    cloudUpdatedAt: bucket.cloudUpdatedAt || '',
  }
}

export function incrementLocalPlayCount(userId: number, trackId: number): number {
  if (trackId <= 0) return 0
  const store = readPlaybackStore()
  const bucket = getUserBucket(store, userId)
  const key = String(trackId)
  const nextCount = Number(bucket.localPlayCounts[key] || 0) + 1
  bucket.localPlayCounts[key] = nextCount
  writePlaybackStore(store)
  return nextCount
}
