import type { Page } from '@playwright/test'

export const installMockElectronBridge = async (page: Page) => {
  await page.addInitScript(() => {
    const streamSources = new Map()
    const stickyNotes = new Map()

    const parseJson = async (response) => {
      const raw = await response.text().catch(() => '')
      let payload = null

      if (raw.trim().length > 0) {
        try {
          payload = JSON.parse(raw)
        } catch {
          payload = raw
        }
      }

      if (!response.ok) {
        const message =
          payload && typeof payload === 'object' && typeof payload.message === 'string'
            ? payload.message
            : typeof payload === 'string' && payload.trim().length > 0
              ? payload
              : `Request failed (${response.status}).`

        throw new Error(message)
      }

      return payload
    }

    const jsonRequest = async (url, init) => parseJson(await fetch(url, init))

    const dispatchStreamEvent = (subscriptionId, eventName, data) => {
      window.dispatchEvent(
        new CustomEvent('chill-vibe:chat-stream', {
          detail: {
            subscriptionId,
            event: eventName,
            data,
          },
        }),
      )
    }

    window.electronAPI = {
      minimizeWindow: async () => undefined,
      toggleMaximizeWindow: async () => false,
      closeWindow: async () => undefined,
      isWindowMaximized: async () => false,
      onWindowMaximizedChanged: () => () => undefined,
      openFolderDialog: async () => null,
      listStickyNotes: async ({ workspacePath }) => ({
        notes: Array.from(stickyNotes.values())
          .filter((note) => note.workspacePath === workspacePath)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      }),
      loadStickyNote: async ({ workspacePath, noteId }) => {
        const note = stickyNotes.get(`${workspacePath}|${noteId}`)
        if (!note) throw new Error('Sticky note not found')
        return { ...note }
      },
      saveStickyNote: async ({ workspacePath, noteId, title, content, checkpoint = false }) => {
        const key = `${workspacePath}|${noteId}`
        const previous = stickyNotes.get(key)
        const now = new Date().toISOString()
        const versions = [...(previous?.versions ?? [])]
        if (checkpoint && versions[0]?.preview !== content.trim().split(/\r?\n/, 1)[0]) {
          versions.unshift({
            id: `mock-version-${versions.length + 1}`,
            createdAt: now,
            title,
            preview: content.trim().split(/\r?\n/, 1)[0] ?? '',
          })
        }
        const note = {
          workspacePath,
          noteId,
          title,
          fileName: `${title}--${noteId}.md`,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          preview: content.trim().split(/\r?\n/, 1)[0] ?? '',
          content,
          versions,
        }
        stickyNotes.set(key, note)
        return { ...note }
      },
      searchStickyNotes: async ({ workspacePath, query }) => {
        const normalized = query.trim().toLocaleLowerCase()
        return {
          notes: Array.from(stickyNotes.values())
            .filter((note) => note.workspacePath === workspacePath)
            .filter((note) =>
              !normalized ||
              note.title.toLocaleLowerCase().includes(normalized) ||
              note.content.toLocaleLowerCase().includes(normalized),
            )
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
        }
      },
      loadStickyNoteVersion: async ({ workspacePath, noteId, versionId }) => {
        const note = stickyNotes.get(`${workspacePath}|${noteId}`)
        const version = note?.versions.find((entry) => entry.id === versionId)
        if (!note || !version) throw new Error('Sticky note version not found')
        return { version: 1, ...version, content: version.preview }
      },
      restoreStickyNoteVersion: async ({ workspacePath, noteId, versionId }) => {
        const note = stickyNotes.get(`${workspacePath}|${noteId}`)
        const version = note?.versions.find((entry) => entry.id === versionId)
        if (!note || !version) throw new Error('Sticky note version not found')
        const restored = { ...note, title: version.title, content: version.preview, preview: version.preview }
        stickyNotes.set(`${workspacePath}|${noteId}`, restored)
        return restored
      },
      revealStickyNoteLocation: async () => undefined,
      fetchState: async () => jsonRequest('/api/state'),
      loadSessionHistoryEntry: async (request) =>
        jsonRequest(`/api/session-history/${encodeURIComponent(request.entryId)}`),
      saveClosedWorkspaceSnapshot: async (snapshot) =>
        jsonRequest('/api/closed-workspace', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(snapshot),
        }),
      loadClosedWorkspaceSnapshot: async (request) =>
        jsonRequest(`/api/closed-workspace?workspacePath=${encodeURIComponent(request.workspacePath)}`),
      saveState: async (state) =>
        jsonRequest('/api/state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state),
        }),
      queueStateSave: (state) => {
        void fetch('/api/state/snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state),
          keepalive: true,
        }).catch(() => undefined)
      },
      resetState: async () =>
        jsonRequest('/api/state/reset', {
          method: 'POST',
        }),
      clearUserData: async () => undefined,
      fetchProviders: async () => jsonRequest('/api/providers'),
      importCcSwitchRouting: async (request) =>
        jsonRequest('/api/routing/import/cc-switch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      fetchSetupStatus: async () => jsonRequest('/api/setup/status'),
      runEnvironmentSetup: async (request) =>
        jsonRequest('/api/setup/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request ?? {}),
        }),
      fetchOnboardingStatus: async () => jsonRequest('/api/onboarding/status'),
      fetchGitStatusPreview: async (workspacePath) =>
        jsonRequest(`/api/git/status/preview?workspacePath=${encodeURIComponent(workspacePath)}`),
      fetchGitStatus: async (workspacePath) =>
        jsonRequest(`/api/git/status?workspacePath=${encodeURIComponent(workspacePath)}`),
      setGitStage: async (request) =>
        jsonRequest('/api/git/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      discardGitChanges: async (request) =>
        jsonRequest('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      initGitWorkspace: async (request) =>
        jsonRequest('/api/git/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      commitGitChanges: async (request) =>
        jsonRequest('/api/git/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      pullGitChanges: async (request) =>
        jsonRequest('/api/git/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      fetchSlashCommands: async (request) =>
        jsonRequest('/api/slash-commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      requestChat: async (request) =>
        jsonRequest('/api/chat/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      uploadImageAttachment: async (request) =>
        jsonRequest('/api/attachments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      stopChat: async (streamId) =>
        jsonRequest(`/api/chat/stop/${encodeURIComponent(streamId)}`, {
          method: 'POST',
        }),
      subscribeChatStream: async (streamId, subscriptionId) => {
        const source = new EventSource(`/api/chat/stream/${encodeURIComponent(streamId)}`)
        const eventNames = [
          'session',
          'delta',
          'log',
          'assistant_message',
          'activity',
          'done',
          'error',
        ]

        for (const eventName of eventNames) {
          source.addEventListener(eventName, (event) => {
            if (!(event instanceof MessageEvent)) {
              return
            }

            dispatchStreamEvent(subscriptionId, eventName, JSON.parse(event.data))
          })
        }

        source.onerror = () => {
          dispatchStreamEvent(subscriptionId, 'error', {
            message: 'The desktop stream could not be opened.',
          })
        }

        streamSources.set(subscriptionId, source)
      },
      unsubscribeChatStream: async (subscriptionId) => {
        streamSources.get(subscriptionId)?.close()
        streamSources.delete(subscriptionId)
      },
      getAttachmentUrl: (attachmentId) => `/api/attachments/${encodeURIComponent(attachmentId)}`,
    }
  })
}
