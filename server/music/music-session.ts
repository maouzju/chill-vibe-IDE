// Music session persistence for Chill Vibe's experimental music features.
// Uses chill-vibe's own data directory instead of Electron userData.

import fs from 'node:fs'
import path from 'node:path'

import { getAppDataDir } from '../app-paths.js'

const MUSIC_SESSION_FILE = 'music-session.json'

type MusicSession = {
  cookie: string
  userId: number
  nickname: string
  avatarUrl: string
  updatedAt: string
}

function getFilePath() {
  return path.join(getAppDataDir(), MUSIC_SESSION_FILE)
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function writeJson(filePath: string, payload: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

export function readMusicSession(): MusicSession | null {
  const raw = readJson(getFilePath())
  if (!raw || typeof raw.cookie !== 'string' || !raw.cookie.trim()) return null

  return {
    cookie: String(raw.cookie).trim(),
    userId: Number(raw.userId || 0),
    nickname: String(raw.nickname || ''),
    avatarUrl: String(raw.avatarUrl || ''),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  }
}

export function writeMusicSession(session: MusicSession): MusicSession {
  const payload: MusicSession = {
    cookie: session.cookie.trim(),
    userId: session.userId,
    nickname: session.nickname,
    avatarUrl: session.avatarUrl,
    updatedAt: new Date().toISOString(),
  }
  writeJson(getFilePath(), payload)
  return payload
}

export function clearMusicSession(): void {
  try {
    fs.rmSync(getFilePath(), { force: true })
  } catch {
    // ignored
  }
}
