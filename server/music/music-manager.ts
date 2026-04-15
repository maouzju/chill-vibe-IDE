// Music manager — orchestrates NeteaseService, session, and playback stores.
// Used by the desktop backend (electron/backend.ts).

import { NeteaseService } from './netease-service.js'
import type {
  MusicPlaylistSummary,
  MusicQrCheckResult,
  MusicQrLoginResult,
  MusicSongSource,
  MusicTrack,
} from './netease-service.js'
import { clearMusicSession, readMusicSession, writeMusicSession } from './music-session.js'
import { incrementLocalPlayCount } from './music-playback.js'

export type MusicLoginStatus = {
  authenticated: boolean
  userId: number
  nickname: string
  avatarUrl: string
}

export class MusicManager {
  private service: NeteaseService

  constructor() {
    const session = readMusicSession()
    this.service = new NeteaseService(session?.cookie ?? '')
  }

  getLoginStatus(): MusicLoginStatus {
    const session = readMusicSession()
    if (!session || !session.cookie) {
      return { authenticated: false, userId: 0, nickname: '', avatarUrl: '' }
    }
    return {
      authenticated: true,
      userId: session.userId,
      nickname: session.nickname,
      avatarUrl: session.avatarUrl,
    }
  }

  async createQrLogin(): Promise<MusicQrLoginResult> {
    return this.service.createQrLogin()
  }

  async checkQrLogin(key: string): Promise<MusicQrCheckResult & { userId?: number; nickname?: string; avatarUrl?: string }> {
    const result = await this.service.checkQrLogin(key)
    if (result.status !== 'authorized' || !result.cookie) return result

    // Login succeeded — persist and fetch account info
    this.service.cookie = result.cookie
    const account = await this.service.getAccount()
    writeMusicSession({
      cookie: result.cookie,
      userId: account.userId,
      nickname: account.nickname,
      avatarUrl: account.avatarUrl,
      updatedAt: new Date().toISOString(),
    })

    return {
      ...result,
      userId: account.userId,
      nickname: account.nickname,
      avatarUrl: account.avatarUrl,
    }
  }

  async logout(): Promise<void> {
    try { await this.service.logout() } catch { /* ignore */ }
    clearMusicSession()
    this.service = new NeteaseService('')
  }

  async fetchPlaylists(): Promise<MusicPlaylistSummary[]> {
    const session = readMusicSession()
    if (!session?.userId) throw new Error('请先登录网易云音乐')
    this.service.cookie = session.cookie
    return this.service.listPlaylists(session.userId)
  }

  async fetchPlaylistTracks(playlistId: number): Promise<MusicTrack[]> {
    this.refreshCookie()
    return this.service.getPlaylistTracks(playlistId)
  }

  async getSongUrl(songId: number, preferredQuality?: string): Promise<MusicSongSource> {
    this.refreshCookie()
    return this.service.getSongUrl(songId, { preferredQuality })
  }

  async recordPlay(trackId: number): Promise<number> {
    const session = readMusicSession()
    if (!session?.userId) return 0
    return incrementLocalPlayCount(session.userId, trackId)
  }

  async getExplorePlaylists(query?: string): Promise<MusicPlaylistSummary[]> {
    this.refreshCookie()
    return this.service.getExplorePlaylists(query)
  }

  private refreshCookie() {
    const session = readMusicSession()
    if (session?.cookie) this.service.cookie = session.cookie
  }
}
