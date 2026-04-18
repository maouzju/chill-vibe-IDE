import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

import { getAttachmentProtocolUrl } from '../shared/attachment-protocol.js'

ipcRenderer.on('chat:stream-event', (_event, payload) => {
  window.dispatchEvent(
    new CustomEvent('chill-vibe:chat-stream', {
      detail: payload as {
        subscriptionId: string
        event: string
        data: unknown
      },
    }),
  )
})

ipcRenderer.on('app:flush-state-before-quit', () => {
  window.dispatchEvent(new Event('chill-vibe:flush-state-before-quit'))
})

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize') as Promise<boolean>,
  closeWindow: () => ipcRenderer.invoke('window:close'),
  flashWindowOnce: () => ipcRenderer.invoke('window:flash-once') as Promise<boolean>,
  setUiZoomFactor: (zoomFactor: number) => ipcRenderer.invoke('window:set-zoom-factor', zoomFactor),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
  onWindowMaximizedChanged: (listener: (maximized: boolean) => void) => {
    const handler = (_event: IpcRendererEvent, maximized: boolean) => {
      listener(maximized)
    }

    ipcRenderer.on('window:maximized-changed', handler)

    return () => {
      ipcRenderer.removeListener('window:maximized-changed', handler)
    }
  },
  openFolderDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openFolder') as Promise<string | null>,
  openMessageLocalLink: (href: string, workspacePath?: string) =>
    ipcRenderer.invoke('desktop:open-message-local-link', { href, workspacePath }) as Promise<void>,
  openExternalLink: (href: string) =>
    ipcRenderer.invoke('desktop:open-external-link', href) as Promise<void>,
  fetchState: () => ipcRenderer.invoke('desktop:fetch-state'),
  loadSessionHistoryEntry: (request: unknown) =>
    ipcRenderer.invoke('desktop:load-session-history-entry', request),
  saveState: (state: unknown) => ipcRenderer.invoke('desktop:save-state', state),
  syncRuntimeSettings: (settings: unknown) =>
    ipcRenderer.invoke('desktop:sync-runtime-settings', settings),
  queueStateSave: (state: unknown) => {
    ipcRenderer.send('desktop:queue-state-save', state)
  },
  resetState: () => ipcRenderer.invoke('desktop:reset-state'),
  resolveStateRecoveryOption: (request: unknown) =>
    ipcRenderer.invoke('desktop:resolve-state-recovery-option', request),
  captureRendererCrash: (request: unknown) =>
    ipcRenderer.invoke('desktop:capture-renderer-crash', request),
  dismissRecentCrashRecovery: () =>
    ipcRenderer.invoke('desktop:dismiss-recent-crash-recovery'),
  fetchProviders: () => ipcRenderer.invoke('desktop:fetch-providers'),
  importCcSwitchRouting: (request: unknown) =>
    ipcRenderer.invoke('desktop:import-cc-switch-routing', request),
  fetchSetupStatus: () => ipcRenderer.invoke('desktop:fetch-setup-status'),
  runEnvironmentSetup: () => ipcRenderer.invoke('desktop:run-environment-setup'),
  fetchOnboardingStatus: () => ipcRenderer.invoke('desktop:fetch-onboarding-status'),
  fetchGitStatus: (workspacePath: string) => ipcRenderer.invoke('desktop:fetch-git-status', workspacePath),
  setGitStage: (request: unknown) => ipcRenderer.invoke('desktop:set-git-stage', request),
  initGitWorkspace: (request: unknown) => ipcRenderer.invoke('desktop:init-git-workspace', request),
  commitGitChanges: (request: unknown) => ipcRenderer.invoke('desktop:commit-git-changes', request),
  pullGitChanges: (request: unknown) => ipcRenderer.invoke('desktop:pull-git-changes', request),
  pushGitChanges: (request: unknown) => ipcRenderer.invoke('desktop:push-git-changes', request),
  commitAllGitChanges: (request: unknown) => ipcRenderer.invoke('desktop:commit-all-git-changes', request),
  fetchGitLog: (request: unknown) => ipcRenderer.invoke('desktop:fetch-git-log', request),
  fetchCommitDiff: (request: unknown) => ipcRenderer.invoke('desktop:fetch-commit-diff', request),
  fetchSlashCommands: (request: unknown) => ipcRenderer.invoke('desktop:fetch-slash-commands', request),
  requestChat: (request: unknown) => ipcRenderer.invoke('desktop:request-chat', request),
  uploadImageAttachment: (request: unknown) =>
    ipcRenderer.invoke('desktop:upload-image-attachment', request),
  stopChat: (streamId: string) => ipcRenderer.invoke('desktop:stop-chat', streamId),
  listExternalHistory: (request: unknown) =>
    ipcRenderer.invoke('desktop:list-external-history', request),
  loadExternalSession: (request: unknown) =>
    ipcRenderer.invoke('desktop:load-external-session', request),
  subscribeChatStream: (streamId: string, subscriptionId: string) =>
    ipcRenderer.invoke('desktop:subscribe-chat-stream', streamId, subscriptionId),
  unsubscribeChatStream: (subscriptionId: string) =>
    ipcRenderer.invoke('desktop:unsubscribe-chat-stream', subscriptionId),
  getAttachmentUrl: getAttachmentProtocolUrl,

  // ── Music ──────────────────────────────────────────────────────────────────
  fetchMusicLoginStatus: () => ipcRenderer.invoke('desktop:music-login-status'),
  createMusicQrLogin: () => ipcRenderer.invoke('desktop:music-qr-create'),
  checkMusicQrLogin: (key: string) => ipcRenderer.invoke('desktop:music-qr-check', key),
  musicLogout: () => ipcRenderer.invoke('desktop:music-logout'),
  fetchMusicPlaylists: () => ipcRenderer.invoke('desktop:music-playlists'),
  fetchMusicPlaylistTracks: (playlistId: number) =>
    ipcRenderer.invoke('desktop:music-playlist-tracks', playlistId),
  getMusicSongUrl: (songId: number, quality?: string) =>
    ipcRenderer.invoke('desktop:music-song-url', songId, quality),
  recordMusicPlay: (trackId: number) =>
    ipcRenderer.invoke('desktop:music-record-play', trackId),
  fetchMusicExplorePlaylists: (query?: string) =>
    ipcRenderer.invoke('desktop:music-explore', query),

  // ── White Noise ────────────────────────────────────────────────────────────
  fetchWhiteNoiseScenes: () => ipcRenderer.invoke('desktop:whitenoise-scenes'),
  generateWhiteNoiseScene: (prompt: string | null) =>
    ipcRenderer.invoke('desktop:whitenoise-generate', prompt),
  deleteWhiteNoiseScene: (sceneId: string) =>
    ipcRenderer.invoke('desktop:whitenoise-delete', sceneId),
  ensureAmbientAudio: (generator: string, url?: string) =>
    ipcRenderer.invoke('desktop:whitenoise-ensure-audio', generator, url),
  readAmbientAudioBuffer: (generator: string, url?: string) =>
    ipcRenderer.invoke('desktop:whitenoise-read-audio', generator, url) as Promise<ArrayBuffer>,

  // ── File System ───────────────────────────────────────────────────────────
  listFiles: (request: unknown) =>
    ipcRenderer.invoke('desktop:list-files', request),
  searchFiles: (request: unknown) =>
    ipcRenderer.invoke('desktop:search-files', request),
  createFile: (request: unknown) =>
    ipcRenderer.invoke('desktop:create-file', request),
  createDirectory: (request: unknown) =>
    ipcRenderer.invoke('desktop:create-directory', request),
  renameEntry: (request: unknown) =>
    ipcRenderer.invoke('desktop:rename-entry', request),
  moveEntry: (request: unknown) =>
    ipcRenderer.invoke('desktop:move-entry', request),
  deleteEntry: (request: unknown) =>
    ipcRenderer.invoke('desktop:delete-entry', request),
  readFile: (request: unknown) =>
    ipcRenderer.invoke('desktop:read-file', request),
  writeFile: (request: unknown) =>
    ipcRenderer.invoke('desktop:write-file', request),

  // ── Proxy Stats ───────────────────────────────────────────────────────────
  fetchProxyStats: (since?: number) =>
    ipcRenderer.invoke('desktop:fetch-proxy-stats', since),
  resetProxyStats: () => ipcRenderer.invoke('desktop:reset-proxy-stats'),

  // ── Weather ──────────────────────────────────────────────────────────────
  fetchWeather: (city?: string) =>
    ipcRenderer.invoke('desktop:fetch-weather', city),
  searchCities: (query: string) =>
    ipcRenderer.invoke('desktop:search-cities', query),

  // ── Crash Logging ─────────────────────────────────────────────────────────
  logError: (level: string, message: string, meta?: unknown) =>
    ipcRenderer.invoke('crash-log:write', level, message, meta),

  // ── App Update ──────────────────────────────────────────────────────────
  getAppVersion: () => ipcRenderer.invoke('desktop:get-app-version') as Promise<string>,
  checkForUpdate: () => ipcRenderer.invoke('desktop:check-for-update'),
  downloadUpdate: (assetUrl: string) =>
    ipcRenderer.invoke('desktop:download-update', assetUrl) as Promise<string>,
  installUpdate: (assetPath: string) =>
    ipcRenderer.invoke('desktop:install-update', assetPath) as Promise<void>,
  clearUserData: () =>
    ipcRenderer.invoke('desktop:clear-user-data') as Promise<void>,
  onUpdateDownloadProgress: (listener: (progress: number) => void) => {
    const handler = (_event: IpcRendererEvent, progress: number) => {
      listener(progress)
    }
    ipcRenderer.on('update:download-progress', handler)
    return () => {
      ipcRenderer.removeListener('update:download-progress', handler)
    }
  },
})
