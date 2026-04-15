// NetEase music service integration for Chill Vibe's experimental music features.

import api from 'NeteaseCloudMusicApi'

// ── Constants ──────────────────────────────────────────────────────────────────

const PLAYLIST_PAGE_SIZE = 1000
const API_REQUEST_TIMEOUT_MS = 15_000
const API_MAX_ATTEMPTS = 5
const API_RETRY_DELAY_MS = 2000
const API_TIMEOUT_MESSAGE = '请求超时，请稍后重试'

const AUDIO_QUALITY_BEST = 'best'
const AUDIO_QUALITY_LOSSLESS = 'lossless'
const AUDIO_QUALITY_EXHIGH = 'exhigh'
const AUDIO_QUALITY_STANDARD = 'standard'
const AUDIO_QUALITY_LEVELS_BEST = [
  'jymaster',
  'sky',
  'jyeffect',
  'hires',
  'lossless',
  'exhigh',
  'standard',
]

// ── Types ──────────────────────────────────────────────────────────────────────

export type MusicArtistEntry = { id: number; name: string }

export type MusicTrack = {
  id: number
  name: string
  artists: string[]
  artistEntries: MusicArtistEntry[]
  album: string
  albumId: number
  albumCoverUrl: string
  durationMs: number
  position: number
}

export type MusicPlaylistSummary = {
  id: number
  sourcePlaylistId: number
  name: string
  trackCount: number
  coverUrl: string
  specialType: number
  subscribed: boolean
  creatorId: number
  creatorName: string
  description: string
  playCount: number
  copywriter: string
  exploreSourceLabel: string
  isExplore: boolean
}

export type MusicSongSource = {
  url: string | null
  level: string
  streamDurationMs: number
  previewStartMs: number
  previewEndMs: number
  fee: number
  code: number
  freeTrialInfo: unknown
}

export type MusicQrLoginResult = {
  key: string
  qrUrl: string
  qrImage: string
}

export type MusicQrCheckResult = {
  status: 'waiting' | 'confirm' | 'expired' | 'authorized'
  message: string
  cookie: string
}

export type MusicAccount = {
  userId: number
  nickname: string
  avatarUrl: string
}

type ApiCallOptions = {
  maxAttempts?: number
  timeoutMs?: number
  retryDelayMs?: number
  timeoutMessage?: string
  fallbackMessage?: string
  codeMessages?: Record<number, string>
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function createTimeoutError(message = API_TIMEOUT_MESSAGE): Error & { code: string; status: number } {
  const error = new Error(message) as Error & { code: string; status: number }
  error.code = 'ETIMEDOUT'
  error.status = 408
  return error
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage = API_TIMEOUT_MESSAGE): Promise<T> {
  if (timeoutMs <= 0) return Promise.resolve(promise)

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(createTimeoutError(timeoutMessage)), timeoutMs)

    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

function createApiError(
  error: Record<string, unknown> | null | undefined,
  fallbackMessage: string,
  codeMessages: Record<number, string> = {},
): Error & { status: number; body: unknown; cause: unknown } {
  const body = (error?.body ?? null) as Record<string, unknown> | null
  const status = Number(error?.status || (body as Record<string, unknown> | null)?.code || 0)
  const explicitMessage = status > 0 && codeMessages[status] ? codeMessages[status] : ''
  const rawMessage = String(body?.message || body?.msg || (error as Record<string, unknown> | null)?.message || '')
  const message =
    explicitMessage ||
    (rawMessage && rawMessage !== '[object Object]' ? rawMessage : '') ||
    fallbackMessage ||
    `API request failed (${status || 'unknown'})`
  const wrapped = new Error(message) as Error & { status: number; body: unknown; cause: unknown }
  wrapped.status = status
  wrapped.body = body
  wrapped.cause = error
  return wrapped
}

function ensureApiSuccess(
  body: Record<string, unknown> | null | undefined,
  fallbackMessage: string,
  codeMessages: Record<number, string> = {},
) {
  if (!body || typeof body !== 'object') {
    throw createApiError({}, fallbackMessage, codeMessages)
  }
  const code = Number(body.code || 0)
  if (code > 0 && code !== 200) {
    throw createApiError({ body, status: code }, fallbackMessage, codeMessages)
  }
}

function normalizeSongSource(data: Record<string, unknown> | null | undefined, level: string): MusicSongSource {
  const d = data ?? {}
  const freeTrialInfo = d.freeTrialInfo as Record<string, unknown> | null | undefined
  return {
    url: (d.url as string) || null,
    level,
    streamDurationMs: Number(d.time || d.duration || 0),
    previewStartMs: Number(freeTrialInfo?.start || d.start || 0),
    previewEndMs: Number(freeTrialInfo?.end || d.end || 0),
    fee: Number(d.fee || 0),
    code: Number(d.code || 0),
    freeTrialInfo: freeTrialInfo ?? null,
  }
}

export function normalizeAudioQualityPreference(input: unknown): string {
  if (input === AUDIO_QUALITY_LOSSLESS) return AUDIO_QUALITY_LOSSLESS
  if (input === AUDIO_QUALITY_EXHIGH) return AUDIO_QUALITY_EXHIGH
  if (input === AUDIO_QUALITY_STANDARD) return AUDIO_QUALITY_STANDARD
  return AUDIO_QUALITY_BEST
}

function buildSongUrlLevelCandidates(input: unknown): string[] {
  const preference = normalizeAudioQualityPreference(input)
  if (preference === AUDIO_QUALITY_LOSSLESS) return ['lossless', 'exhigh', 'standard']
  if (preference === AUDIO_QUALITY_EXHIGH) return ['exhigh', 'standard']
  if (preference === AUDIO_QUALITY_STANDARD) return ['standard']
  return [...AUDIO_QUALITY_LEVELS_BEST]
}

function normalizeArtistEntries(source: Record<string, unknown> | null | undefined): MusicArtistEntry[] {
  const artists = (source?.ar || source?.artists || source?.artistNames || []) as unknown
  if (Array.isArray(artists)) {
    return artists
      .map((artist) => {
        if (typeof artist === 'string') return { id: 0, name: artist.trim() }
        const a = artist as Record<string, unknown>
        return {
          id: Number(a.id || a.artistId || 0),
          name: String(a.name || a.artistName || '').trim(),
        }
      })
      .filter((artist) => artist.name)
  }
  if (typeof artists === 'string') {
    return artists
      .split(/[/,\u3001]/)
      .map((item) => ({ id: 0, name: item.trim() }))
      .filter((artist) => artist.name)
  }
  return []
}

function normalizeTrackRecord(track: Record<string, unknown>, index = 0): MusicTrack {
  const source = (track?.songInfo || track?.songData || track?.song || track?.track || track || {}) as Record<string, unknown>
  const album = (source.al || source.album || {}) as Record<string, unknown>
  const artistEntries = normalizeArtistEntries(source)

  return {
    id: Number(source.id || track?.songId || track?.id || 0),
    name: String(source.name || track?.name || ''),
    artists: artistEntries.map((a) => a.name),
    artistEntries,
    album: String(album.name || source.albumName || ''),
    albumId: Number(album.id || source.albumId || 0),
    albumCoverUrl: String(album.picUrl || album.coverUrl || source.albumPicUrl || ''),
    durationMs: Number(source.dt || source.duration || track?.durationMs || 0),
    position: Number(track?.position || source.position || index + 1),
  }
}

function normalizePlaylistSummary(
  playlist: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): MusicPlaylistSummary {
  const creator = (playlist.creator || {}) as Record<string, unknown>
  return {
    id: Number(overrides.id || playlist.id || 0),
    sourcePlaylistId: Number(overrides.sourcePlaylistId || playlist.sourcePlaylistId || playlist.id || 0),
    name: String(playlist.name || ''),
    trackCount: Number(playlist.trackCount || 0),
    coverUrl: String(playlist.coverImgUrl || playlist.coverUrl || ''),
    specialType: Number(playlist.specialType || 0),
    subscribed:
      overrides.subscribed !== undefined ? Boolean(overrides.subscribed) : Boolean(playlist.subscribed),
    creatorId: Number(overrides.creatorId || creator.userId || playlist.creatorId || 0),
    creatorName: String(overrides.creatorName || creator.nickname || playlist.creatorName || ''),
    description:
      overrides.description !== undefined
        ? String(overrides.description || '')
        : String(playlist.description || playlist.desc || ''),
    playCount: Number(overrides.playCount || playlist.playCount || 0),
    copywriter: String(overrides.copywriter || playlist.copywriter || ''),
    exploreSourceLabel: String(overrides.exploreSourceLabel || playlist.exploreSourceLabel || ''),
    isExplore:
      overrides.isExplore !== undefined ? Boolean(overrides.isExplore) : Boolean(playlist.isExplore),
  }
}

async function callApi(
  name: string,
  params: Record<string, unknown>,
  options: ApiCallOptions = {},
): Promise<Record<string, unknown>> {
  const fn = (api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`Unknown API: ${name}`)

  const maxAttempts = Number.isInteger(options.maxAttempts) && (options.maxAttempts ?? 0) > 0
    ? options.maxAttempts! : API_MAX_ATTEMPTS
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? Math.round(options.timeoutMs!) : API_REQUEST_TIMEOUT_MS
  const retryDelayMs = Number.isFinite(options.retryDelayMs) && (options.retryDelayMs ?? 0) >= 0
    ? Number(options.retryDelayMs) : API_RETRY_DELAY_MS
  const timeoutMessage = options.timeoutMessage?.trim() || API_TIMEOUT_MESSAGE

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await withTimeout(fn(params) as Promise<unknown>, timeoutMs, timeoutMessage)
      if (!response || typeof response !== 'object') throw new Error(`Bad response from ${name}`)
      return response as Record<string, unknown>
    } catch (error) {
      const e = error as Record<string, unknown>
      const errorCode = e.code ? String(e.code) : ''
      const msg = e.message ? String(e.message) : ''
      const body = e.body as Record<string, unknown> | null
      const bodyMsg = body ? String(body.msg || body.message || '') : ''
      const status = e.status || (body && body.code) || 0
      const retryable = /(ETIMEDOUT|timeout|502|ECONNRESET)/i.test(`${errorCode} ${msg} ${bodyMsg} ${status}`)
      if (!retryable || attempt === maxAttempts) {
        throw createApiError(
          e,
          options.fallbackMessage || `API request failed: ${name}`,
          options.codeMessages || {},
        )
      }
      await sleep(retryDelayMs * attempt)
    }
  }

  throw new Error(`API retry budget exhausted for ${name}`)
}

function normalizeSongs(body: Record<string, unknown>): Record<string, unknown>[] {
  if (!body || typeof body !== 'object') throw new Error('Invalid playlist track payload')
  if (body.code && body.code !== 200) throw new Error(`Playlist track request failed: ${body.code}`)
  if (!Array.isArray(body.songs)) throw new Error('Playlist track payload does not contain songs')
  return body.songs as Record<string, unknown>[]
}

// ── NeteaseService class ───────────────────────────────────────────────────────

export class NeteaseService {
  cookie: string

  constructor(cookie: string) {
    this.cookie = cookie
  }

  async createQrLogin(): Promise<MusicQrLoginResult> {
    const keyResponse = await callApi('login_qr_key', { timestamp: Date.now() }, {
      fallbackMessage: '生成登录二维码失败',
    })
    const keyBody = keyResponse.body as Record<string, unknown> | undefined
    const keyData = (keyBody?.data ?? keyBody) as Record<string, unknown> | undefined
    const key = String(keyData?.unikey || keyData?.key || '')
    if (!key) throw new Error('生成登录二维码失败')

    const imageResponse = await callApi('login_qr_create', { key, qrimg: true, timestamp: Date.now() }, {
      fallbackMessage: '生成登录二维码失败',
    })
    const imageBody = imageResponse.body as Record<string, unknown> | undefined
    const imageData = (imageBody?.data ?? imageBody) as Record<string, unknown> | undefined
    return {
      key,
      qrUrl: String(imageData?.qrurl || ''),
      qrImage: String(imageData?.qrimg || ''),
    }
  }

  async checkQrLogin(key: string): Promise<MusicQrCheckResult> {
    const response = await callApi('login_qr_check', { key, timestamp: Date.now() }, {
      fallbackMessage: '检查二维码登录状态失败',
    })
    const body = (response.body || response) as Record<string, unknown>
    const code = Number(body.code || 0)

    if (code === 800) return { status: 'expired', message: '二维码已过期，请刷新后重试。', cookie: '' }
    if (code === 801) return { status: 'waiting', message: '请使用网易云音乐扫码。', cookie: '' }
    if (code === 802) return { status: 'confirm', message: '已扫码，请在手机上确认登录。', cookie: '' }
    if (code === 803 || (code === 200 && body.cookie)) {
      return { status: 'authorized', message: '登录成功', cookie: String(body.cookie || '') }
    }

    throw createApiError({ body, status: code }, '检查二维码登录状态失败')
  }

  async getAccount(): Promise<MusicAccount> {
    const response = await callApi('login_status', { cookie: this.cookie })
    const body = response.body as Record<string, unknown> | undefined
    const data = (body?.data ?? body) as Record<string, unknown> | undefined
    const profile = (data?.profile || {}) as Record<string, unknown>
    return {
      userId: Number(profile.userId || 0),
      nickname: String(profile.nickname || ''),
      avatarUrl: String(profile.avatarUrl || ''),
    }
  }

  async listPlaylists(userId: number): Promise<MusicPlaylistSummary[]> {
    const response = await callApi('user_playlist', { cookie: this.cookie, uid: userId, limit: 1000 })
    const body = response.body as Record<string, unknown> | undefined
    const playlists = ((body?.playlist ?? []) as Record<string, unknown>[])
    return playlists.map((p) => normalizePlaylistSummary(p))
  }

  async getPlaylistTracks(playlistId: number, expectedCount = 0): Promise<MusicTrack[]> {
    const tracks: MusicTrack[] = []
    let offset = 0

    while (true) {
      const response = await callApi('playlist_track_all', {
        cookie: this.cookie, id: playlistId, limit: PLAYLIST_PAGE_SIZE, offset,
      })
      const songs = normalizeSongs(response.body as Record<string, unknown>)
      if (!songs.length) break

      tracks.push(...songs.map((track, index) => normalizeTrackRecord(track, offset + index)))
      if (songs.length < PLAYLIST_PAGE_SIZE) break

      offset += songs.length
      if (expectedCount > 0 && tracks.length >= expectedCount) break
    }

    return tracks.map((track, index) => ({ ...track, position: index + 1 }))
  }

  async getSongUrl(songId: number, options: { preferredQuality?: string } = {}): Promise<MusicSongSource> {
    const levels = buildSongUrlLevelCandidates(options.preferredQuality)
    let fallbackSource: MusicSongSource | null = null

    for (const level of levels) {
      const response = await callApi('song_url_v1', { cookie: this.cookie, id: songId, level })
      const body = response.body as Record<string, unknown> | undefined
      const dataArr = body?.data as Record<string, unknown>[] | undefined
      const data = dataArr?.[0]
      if (data?.url) return normalizeSongSource(data, level)
      if (!fallbackSource && data) fallbackSource = normalizeSongSource(data, level)
    }

    return fallbackSource || normalizeSongSource(null, levels[levels.length - 1] || 'standard')
  }

  async getPlaylistRecommendations(seedTrackIds: number[], count = 12): Promise<MusicTrack[]> {
    const normalizedSeedTrackIds = [...new Set(seedTrackIds.filter((id) => id > 0))]
    const seen = new Set<number>()
    const tracks: MusicTrack[] = []
    let lastError: unknown = null

    for (const seedTrackId of normalizedSeedTrackIds) {
      try {
        const response = await callApi('simi_song', {
          cookie: this.cookie, id: seedTrackId, limit: Math.max(count, 8),
        }, {
          fallbackMessage: '获取歌单相似歌曲失败',
          codeMessages: { 301: '相似推荐需要有效的网易云登录态，请刷新登录后再试。' },
        })
        const body = (response.body || {}) as Record<string, unknown>
        ensureApiSuccess(body, '获取歌单相似歌曲失败', {
          301: '相似推荐需要有效的网易云登录态，请刷新登录后再试。',
        })

        for (const item of (body.songs || []) as Record<string, unknown>[]) {
          const track = normalizeTrackRecord(item, tracks.length)
          if (track.id <= 0 || seen.has(track.id)) continue
          seen.add(track.id)
          tracks.push(track)
        }
      } catch (error) {
        lastError = error
      }
    }

    if (!tracks.length && lastError) throw lastError
    return tracks
  }

  async getExplorePlaylists(query = '', options: { dailyLimit?: number; communityLimit?: number; cat?: string; limit?: number; offset?: number } = {}): Promise<MusicPlaylistSummary[]> {
    const normalizedQuery = query.trim()
    return normalizedQuery
      ? this.searchExplorePlaylists(normalizedQuery, options)
      : this.getDefaultExplorePlaylists(options)
  }

  private async getDefaultExplorePlaylists(options: { dailyLimit?: number; communityLimit?: number; cat?: string } = {}): Promise<MusicPlaylistSummary[]> {
    const dailyLimit = Math.max(1, Number(options.dailyLimit || 6))
    const communityLimit = Math.max(1, Number(options.communityLimit || 12))
    const merged: MusicPlaylistSummary[] = []
    let fallbackError: unknown = null

    try {
      const daily = await this.getDailyRecommendedPlaylistPreviews(dailyLimit)
      merged.push(...daily)
    } catch (error) { fallbackError = error }

    try {
      const community = await this.getCommunityPlaylistPreviews(communityLimit, options.cat || '全部')
      merged.push(...community)
    } catch (error) { fallbackError = fallbackError || error }

    if (!merged.length && fallbackError) throw fallbackError

    return [...new Map(
      merged
        .filter((p) => p.sourcePlaylistId > 0 || p.id > 0)
        .map((p) => [p.sourcePlaylistId || p.id, p]),
    ).values()]
  }

  private async searchExplorePlaylists(keywords: string, options: { limit?: number; offset?: number } = {}): Promise<MusicPlaylistSummary[]> {
    const response = await callApi('search', {
      cookie: this.cookie, keywords, type: 1000,
      limit: Math.max(1, Number(options.limit || 18)),
      offset: Math.max(0, Number(options.offset || 0)),
    }, {
      fallbackMessage: '搜索社区歌单失败',
      codeMessages: { 301: '搜索社区歌单需要有效的网易云登录态，请刷新登录后再试。' },
    })
    const body = response.body as Record<string, unknown>
    const result = (body?.result || {}) as Record<string, unknown>
    const playlists = (result.playlists || []) as Record<string, unknown>[]
    return playlists.map((p) =>
      normalizePlaylistSummary(p, {
        sourcePlaylistId: Number(p.id || 0),
        exploreSourceLabel: '搜索结果',
        isExplore: true,
      }),
    )
  }

  private async getDailyRecommendedPlaylistPreviews(limit = 6): Promise<MusicPlaylistSummary[]> {
    let playlists: MusicPlaylistSummary[] = []
    try {
      const response = await callApi('recommend_resource', { cookie: this.cookie }, {
        fallbackMessage: '获取每日推荐歌单失败',
        codeMessages: { 301: '获取每日推荐歌单需要有效的网易云登录态，请刷新登录后再试。' },
      })
      const body = response.body as Record<string, unknown>
      playlists = ((body.recommend || []) as Record<string, unknown>[])
        .slice(0, limit)
        .map((p) => normalizePlaylistSummary(p, {
          sourcePlaylistId: Number((p as Record<string, unknown>).id || 0),
          exploreSourceLabel: String((p as Record<string, unknown>).copywriter || '每日推荐'),
          isExplore: true,
        }))
    } catch (error) {
      if (Number((error as Record<string, unknown>)?.status || 0) !== 301) throw error
    }

    if (!playlists.length) {
      const fallback = await callApi('personalized', { cookie: this.cookie, limit }, {
        fallbackMessage: '获取推荐歌单失败',
      })
      const body = fallback.body as Record<string, unknown>
      playlists = ((body.result || []) as Record<string, unknown>[])
        .slice(0, limit)
        .map((p) => normalizePlaylistSummary(p, {
          sourcePlaylistId: Number((p as Record<string, unknown>).id || 0),
          exploreSourceLabel: '推荐歌单',
          isExplore: true,
        }))
    }

    return playlists
  }

  private async getCommunityPlaylistPreviews(limit = 12, cat = '全部'): Promise<MusicPlaylistSummary[]> {
    const response = await callApi('top_playlist_highquality', {
      cookie: this.cookie, cat, limit,
    }, { fallbackMessage: '获取社区歌单失败' })

    const body = response.body as Record<string, unknown>
    return ((body.playlists || []) as Record<string, unknown>[])
      .slice(0, limit)
      .map((p) => normalizePlaylistSummary(p, {
        sourcePlaylistId: Number((p as Record<string, unknown>).id || 0),
        exploreSourceLabel: cat && cat !== '全部' ? `${cat} 社区精选` : '社区精选',
        isExplore: true,
      }))
  }

  async logout(): Promise<void> {
    if (!this.cookie) return
    const response = await callApi('logout', { cookie: this.cookie, timestamp: Date.now() }, {
      fallbackMessage: '退出登录失败',
    })
    ensureApiSuccess(response.body as Record<string, unknown>, '退出登录失败')
  }
}
