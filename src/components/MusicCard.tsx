import { useCallback, useEffect, useRef, useState } from 'react'

import {
  checkMusicQrLogin,
  createMusicQrLogin,
  fetchMusicExplorePlaylists,
  fetchMusicLoginStatus,
  fetchMusicPlaylistTracks,
  fetchMusicPlaylists,
  getMusicSongUrl,
  musicLogout,
  recordMusicPlay,
  type MusicLoginStatus,
  type MusicPlaylistSummary,
  type MusicTrack,
} from '../api'
import type { AppLanguage } from '../../shared/schema'

type MusicTab = 'playlists' | 'explore'

type MusicCardProps = {
  workspacePath: string
  language: AppLanguage
  showAlbumCover?: boolean
  onTitleChange?: (title: string | null) => void
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

const formatDuration = (ms: number) => {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

const getText = (language: AppLanguage) =>
  language === 'en'
    ? {
        login: 'Login',
        logout: 'Logout',
        scanQr: 'Scan with NetEase Cloud Music app',
        confirmLogin: 'Scanned, confirm on phone',
        qrExpired: 'QR expired, click to refresh',
        loginSuccess: 'Login success',
        myPlaylists: 'My Playlists',
        explore: 'Explore',
        loading: 'Loading...',
        noPlaylists: 'No playlists found',
        tracks: 'tracks',
        play: 'Play',
        pause: 'Pause',
        prev: 'Prev',
        next: 'Next',
        shuffle: 'Shuffle',
        repeat: 'Repeat',
        loadError: 'Failed to load',
        retry: 'Retry',
      }
    : {
        login: '登录',
        logout: '注销',
        scanQr: '使用网易云音乐App扫码',
        waitingScan: '等待扫码...',
        confirmLogin: '已扫码，请在手机上确认',
        qrExpired: '二维码已过期，点击刷新',
        loginSuccess: '登录成功',
        myPlaylists: '我的歌单',
        explore: '发现',
        loading: '加载中...',
        noPlaylists: '暂无歌单',
        tracks: '首',
        play: '播放',
        pause: '暂停',
        prev: '上一首',
        next: '下一首',
        shuffle: '随机',
        repeat: '循环',
        loadError: '加载失败',
        retry: '重试',
      }

// ── Login Panel ────────────────────────────────────────────────────────────────

function MusicLoginPanel({
  language,
  onLoginSuccess,
}: {
  language: AppLanguage
  onLoginSuccess: () => void
}) {
  const text = getText(language)
  const [qrImage, setQrImage] = useState('')
  const [qrKey, setQrKey] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'waiting' | 'confirm' | 'expired' | 'error'>('idle')
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const createQr = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const result = await createMusicQrLogin()
      setQrImage(result.qrImage)
      setQrKey(result.key)
      setStatus('waiting')
    } catch (err) {
      setError(errorMessage(err, text.loadError))
      setStatus('error')
    }
  }, [text.loadError])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void createQr()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [createQr])

  useEffect(() => {
    if (!qrKey || (status !== 'waiting' && status !== 'confirm')) return

    pollRef.current = setInterval(async () => {
      try {
        const result = await checkMusicQrLogin(qrKey)
        if (result.status === 'authorized') {
          if (pollRef.current) clearInterval(pollRef.current)
          setStatus('idle')
          onLoginSuccess()
        } else if (result.status === 'confirm') {
          setStatus('confirm')
        } else if (result.status === 'expired') {
          if (pollRef.current) clearInterval(pollRef.current)
          setStatus('expired')
        }
      } catch {
        // ignore poll errors
      }
    }, 2000)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [qrKey, status, onLoginSuccess])

  return (
    <div className="music-login-panel">
      {status === 'loading' && <div className="music-login-loading">{text.loading}</div>}

      {status === 'error' && (
        <div className="music-login-error">
          <span>{error}</span>
          <button className="music-btn music-btn-sm" onClick={() => void createQr()}>
            {text.retry}
          </button>
        </div>
      )}

      {(status === 'waiting' || status === 'confirm') && qrImage && (
        <div className="music-qr-container">
          <img src={qrImage} alt="QR" className="music-qr-image" />
          <p className="music-qr-hint">{status === 'confirm' ? text.confirmLogin : text.scanQr}</p>
        </div>
      )}

      {status === 'expired' && (
        <div className="music-qr-container">
          <button className="music-btn" onClick={() => void createQr()}>
            {text.qrExpired}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Track List ─────────────────────────────────────────────────────────────────

function TrackList({
  tracks,
  currentTrackId,
  onPlay,
}: {
  tracks: MusicTrack[]
  currentTrackId: number
  onPlay: (track: MusicTrack) => void
}) {
  return (
    <div className="music-track-list">
      {tracks.map((track) => (
        <button
          key={track.id}
          className={`music-track-row${track.id === currentTrackId ? ' is-playing' : ''}`}
          onClick={() => onPlay(track)}
        >
          <span className="music-track-position">{track.position}</span>
          <span className="music-track-copy">
            <span className="music-track-name">{track.name}</span>
            <span className="music-track-artist">{track.artists.join(' / ')}</span>
          </span>
          <span className="music-track-duration">{formatDuration(track.durationMs)}</span>
        </button>
      ))}
    </div>
  )
}

// ── Playlist Grid ──────────────────────────────────────────────────────────────

function PlaylistGrid({
  playlists,
  language,
  showAlbumCover,
  currentTrackId,
  onPlayTrack,
}: {
  playlists: MusicPlaylistSummary[]
  language: AppLanguage
  showAlbumCover?: boolean
  currentTrackId: number
  onPlayTrack: (track: MusicTrack) => void
}) {
  const text = getText(language)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [tracks, setTracks] = useState<MusicTrack[]>([])
  const [loadingTracks, setLoadingTracks] = useState(false)

  const handleExpand = useCallback(async (playlistId: number) => {
    if (expandedId === playlistId) {
      setExpandedId(null)
      setTracks([])
      return
    }

    setExpandedId(playlistId)
    setLoadingTracks(true)
    try {
      const result = await fetchMusicPlaylistTracks(playlistId)
      setTracks(result)
    } catch {
      setTracks([])
    } finally {
      setLoadingTracks(false)
    }
  }, [expandedId])

  if (!playlists.length) {
    return <div className="music-empty">{text.noPlaylists}</div>
  }

  return (
    <div className="music-playlist-grid">
      {playlists.map((playlist) => (
        <div key={playlist.id} className={`music-playlist-card${expandedId === playlist.id ? ' is-expanded' : ''}`}>
          <button
            className="music-playlist-header"
            aria-expanded={expandedId === playlist.id}
            onClick={() => void handleExpand(playlist.id)}
          >
            {showAlbumCover && playlist.coverUrl && (
              <img src={playlist.coverUrl} alt="" className="music-playlist-cover" loading="lazy" />
            )}
            <div className="music-playlist-info">
              <span className="music-playlist-name">{playlist.name}</span>
              <span className="music-playlist-meta">
                {playlist.trackCount} {text.tracks}
              </span>
            </div>
          </button>

          {expandedId === playlist.id && (
            <div className="music-playlist-tracks">
              {loadingTracks ? (
                <div className="music-loading-tracks">{text.loading}</div>
              ) : (
                <TrackList
                  tracks={tracks}
                  currentTrackId={currentTrackId}
                  onPlay={onPlayTrack}
                />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Player Bar ─────────────────────────────────────────────────────────────────

function MusicPlayerBar({
  track,
  isPlaying,
  currentTime,
  duration,
  volume,
  language,
  onPlayPause,
  onSeek,
  onVolume,
  onPrev,
  onNext,
}: {
  track: MusicTrack | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  language: AppLanguage
  onPlayPause: () => void
  onSeek: (time: number) => void
  onVolume: (v: number) => void
  onPrev: () => void
  onNext: () => void
}) {
  const text = getText(language)

  if (!track) return null

  return (
    <div className="music-player-bar">
      <div className="music-player-now">
        <span className="music-player-track">{track.name}</span>
        <span className="music-player-artist">{track.artists.join(' / ')}</span>
      </div>

      <div className="music-player-controls">
        <button className="music-player-btn" onClick={onPrev} title={text.prev}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
          </svg>
        </button>
        <button className="music-player-btn music-player-btn-main" onClick={onPlayPause} title={isPlaying ? text.pause : text.play}>
          {isPlaying ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button className="music-player-btn" onClick={onNext} title={text.next}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      </div>

      <div className="music-player-progress">
        <span className="music-player-time">{formatDuration(currentTime * 1000)}</span>
        <input
          type="range"
          className="music-player-seek"
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
        <span className="music-player-time">{formatDuration(duration * 1000)}</span>
        <div className="music-volume">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="music-volume-icon">
            {volume === 0 ? (
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
            ) : volume < 0.5 ? (
              <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
            ) : (
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
            )}
          </svg>
          <input
            type="range"
            className="music-volume-slider"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => onVolume(Number(e.target.value))}
          />
        </div>
      </div>
    </div>
  )
}

// ── Main MusicCard ─────────────────────────────────────────────────────────────

export function MusicCard({ language, showAlbumCover, onTitleChange }: MusicCardProps) {
  const text = getText(language)
  const [loginStatus, setLoginStatus] = useState<MusicLoginStatus | null>(null)
  const [playlists, setPlaylists] = useState<MusicPlaylistSummary[]>([])
  const [activeTab, setActiveTab] = useState<MusicTab>('playlists')
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')
  const [explorePlaylists, setExplorePlaylists] = useState<MusicPlaylistSummary[]>([])
  const [exploreLoadState, setExploreLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [exploreError, setExploreError] = useState('')

  // Playback state
  const [currentTrack, setCurrentTrack] = useState<MusicTrack | null>(null)
  const [queue, setQueue] = useState<MusicTrack[]>([])
  const [queueIndex, setQueueIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.7)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueLengthRef = useRef(0)

  const playTrackAudio = useCallback(async (track: MusicTrack) => {
    const audio = audioRef.current
    if (!audio) return

    try {
      const source = await getMusicSongUrl(track.id)
      if (!source.url) return
      audio.src = source.url
      await audio.play()
      void recordMusicPlay(track.id)
    } catch {
      // ignore playback errors
    }
  }, [])

  // Initialize audio element
  useEffect(() => {
    const audio = new Audio()
    audio.volume = 0.7
    audio.addEventListener('timeupdate', () => setCurrentTime(audio.currentTime))
    audio.addEventListener('durationchange', () => setDuration(audio.duration))
    audio.addEventListener('ended', () => {
      // Auto-next — use functional update with queue length from outer scope
      // queueLengthRef is used to avoid stale closure over queue
      setQueueIndex((prev) => {
        const next = prev + 1
        if (next < queueLengthRef.current) return next
        return 0
      })
    })
    audio.addEventListener('pause', () => setIsPlaying(false))
    audio.addEventListener('play', () => setIsPlaying(true))
    audioRef.current = audio

    return () => {
      audio.pause()
      audio.src = ''
    }
  }, [])

  // Keep queueLengthRef in sync so the ended handler sees the latest length
  useEffect(() => {
    queueLengthRef.current = queue.length
  }, [queue.length])

  // When queueIndex changes, play the new track
  useEffect(() => {
    if (!queue.length) return
    const track = queue[queueIndex]
    if (!track) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCurrentTrack(track)
    void playTrackAudio(track)
  }, [queueIndex, queue, playTrackAudio])

  const loadPlaylists = useCallback(async () => {
    setLoadState('loading')
    setError('')
    try {
      const result = await fetchMusicPlaylists()
      setPlaylists(result)
      setLoadState('ready')
    } catch (err) {
      setError(errorMessage(err, text.loadError))
      setLoadState('error')
    }
  }, [text.loadError])

  // Check login on mount
  useEffect(() => {
    void (async () => {
      try {
        const status = await fetchMusicLoginStatus()
        setLoginStatus(status)
        if (status.authenticated) {
          await loadPlaylists()
        }
      } catch {
        setLoginStatus({ authenticated: false, userId: 0, nickname: '', avatarUrl: '' })
      }
    })()
  }, [loadPlaylists])

  // Sync card header title with login/playback state
  useEffect(() => {
    if (currentTrack && isPlaying) {
      onTitleChange?.(currentTrack.name)
    } else {
      onTitleChange?.(null)
    }
  }, [currentTrack, isPlaying, onTitleChange])

  const loadExplorePlaylists = useCallback(async () => {
    setExploreLoadState('loading')
    setExploreError('')
    try {
      const result = await fetchMusicExplorePlaylists()
      setExplorePlaylists(result)
      setExploreLoadState('ready')
    } catch (err) {
      setExploreError(errorMessage(err, text.loadError))
      setExploreLoadState('error')
    }
  }, [text.loadError])

  const handleLoginSuccess = useCallback(() => {
    void (async () => {
      const status = await fetchMusicLoginStatus()
      setLoginStatus(status)
      if (status.authenticated) await loadPlaylists()
    })()
  }, [loadPlaylists])

  // Load explore playlists when switching to explore tab
  useEffect(() => {
    if (activeTab === 'explore' && exploreLoadState === 'idle') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadExplorePlaylists()
    }
  }, [activeTab, exploreLoadState, loadExplorePlaylists])

  const handleLogout = useCallback(() => {
    void (async () => {
      await musicLogout()
      setLoginStatus({ authenticated: false, userId: 0, nickname: '', avatarUrl: '' })
      setPlaylists([])
      setCurrentTrack(null)
      setQueue([])
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ''
      }
    })()
  }, [])

  // Listen for logout signal from settings panel
  useEffect(() => {
    const onLogoutSignal = () => handleLogout()
    window.addEventListener('music-logout', onLogoutSignal)
    return () => window.removeEventListener('music-logout', onLogoutSignal)
  }, [handleLogout])

  const handlePlayTrack = useCallback((track: MusicTrack) => {
    // Find the playlist tracks context if available, otherwise just play the single track
    setQueue((prevQueue) => {
      const inQueue = prevQueue.some((t) => t.id === track.id)
      if (inQueue) {
        const idx = prevQueue.findIndex((t) => t.id === track.id)
        setQueueIndex(idx)
        return prevQueue
      }
      setQueueIndex(0)
      return [track]
    })
  }, [])

  const handlePlayPause = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play()
    else audio.pause()
  }, [])

  const handleSeek = useCallback((time: number) => {
    const audio = audioRef.current
    if (audio) audio.currentTime = time
  }, [])

  const handleVolume = useCallback((v: number) => {
    setVolume(v)
    const audio = audioRef.current
    if (audio) audio.volume = v
  }, [])

  const handlePrev = useCallback(() => {
    setQueueIndex((prev) => (prev > 0 ? prev - 1 : queue.length - 1))
  }, [queue.length])

  const handleNext = useCallback(() => {
    setQueueIndex((prev) => (prev + 1 < queue.length ? prev + 1 : 0))
  }, [queue.length])

  // ── Not logged in ──
  if (!loginStatus || !loginStatus.authenticated) {
    return (
      <div className="music-card">
        <MusicLoginPanel language={language} onLoginSuccess={handleLoginSuccess} />
      </div>
    )
  }

  // ── Logged in ──
  return (
    <div className="music-card">
      <div className="music-card-topbar">
        <div className="music-card-account">
          <span className="music-card-nickname">{loginStatus.nickname}</span>
        </div>

        <div className="music-card-tabs">
          <button
            className={`music-tab${activeTab === 'playlists' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('playlists')}
          >
            {text.myPlaylists}
          </button>
          <button
            className={`music-tab${activeTab === 'explore' ? ' is-active' : ''}`}
            onClick={() => setActiveTab('explore')}
          >
            {text.explore}
          </button>
        </div>
      </div>

      <div className="music-card-body">
        {activeTab === 'playlists' && (
          <>
            {loadState === 'loading' && <div className="music-loading">{text.loading}</div>}

            {loadState === 'error' && (
              <div className="music-error">
                <span>{error}</span>
                <button className="music-btn music-btn-sm" onClick={() => void loadPlaylists()}>
                  {text.retry}
                </button>
              </div>
            )}

            {loadState === 'ready' && (
              <PlaylistGrid
                playlists={playlists}
                language={language}
                showAlbumCover={showAlbumCover}
                currentTrackId={currentTrack?.id ?? 0}
                onPlayTrack={handlePlayTrack}
              />
            )}
          </>
        )}

        {activeTab === 'explore' && (
          <>
            {exploreLoadState === 'loading' && <div className="music-loading">{text.loading}</div>}

            {exploreLoadState === 'error' && (
              <div className="music-error">
                <span>{exploreError}</span>
                <button className="music-btn music-btn-sm" onClick={() => void loadExplorePlaylists()}>
                  {text.retry}
                </button>
              </div>
            )}

            {exploreLoadState === 'ready' && (
              <PlaylistGrid
                playlists={explorePlaylists}
                language={language}
                showAlbumCover={showAlbumCover}
                currentTrackId={currentTrack?.id ?? 0}
                onPlayTrack={handlePlayTrack}
              />
            )}
          </>
        )}
      </div>

      <MusicPlayerBar
        track={currentTrack}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        language={language}
        onPlayPause={handlePlayPause}
        onSeek={handleSeek}
        onVolume={handleVolume}
        onPrev={handlePrev}
        onNext={handleNext}
      />
    </div>
  )
}
