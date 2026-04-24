import { expect, test, type Page } from '@playwright/test'

import { MUSIC_TOOL_MODEL } from '../shared/models.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

type ThemeName = 'dark' | 'light'

const createTracks = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: 1000 + index,
    name: `Track ${index + 1}`,
    artists: [`Artist ${index + 1}`],
    artistEntries: [{ id: 2000 + index, name: `Artist ${index + 1}` }],
    album: 'Regression Album',
    albumId: 3000,
    albumCoverUrl: '',
    durationMs: 180000,
    position: index + 1,
  }))

const createState = (theme: ThemeName) => createPlaywrightState({
  version: 1 as const,
  settings: {
    language: 'en',
    theme,
    activeTopTab: 'ambience' as const,
    fontScale: 1,
    lineHeightScale: 1,
    resilientProxyEnabled: true,
    cliRoutingEnabled: true,
    resilientProxyStallTimeoutSec: 60,
    resilientProxyFirstByteTimeoutSec: 90,
    resilientProxyMaxRetries: 6,
    musicAlbumCoverEnabled: false,
    experimentalMusicEnabled: true,
    experimentalWhiteNoiseEnabled: false,
    experimentalWeatherEnabled: false,
    requestModels: {
      codex: 'gpt-5.5',
      claude: 'claude-opus-4-7',
    },
    modelReasoningEfforts: {
      codex: {},
      claude: {},
    },
    providerProfiles: {
      codex: {
        activeProfileId: '',
        profiles: [],
      },
      claude: {
        activeProfileId: '',
        profiles: [],
      },
    },
    gitAgentModel: 'gpt-5.5 low',
    recentWorkspaces: [],
  },
  updatedAt: '2026-04-07T00:00:00.000Z',
  columns: [
    {
      id: 'col-1',
      title: 'Music Workspace',
      provider: 'codex' as const,
      workspacePath: 'd:\\Git\\chill-vibe',
      model: 'gpt-5.5',
      cards: [
        {
          id: 'card-1',
          title: 'Music',
          status: 'idle' as const,
          size: 340,
          provider: 'codex' as const,
          model: MUSIC_TOOL_MODEL,
          reasoningEffort: 'medium',
          draft: '',
          messages: [],
        },
      ],
    },
  ],
  sessionHistory: [],
})

const installMockApis = async (page: Page, theme: ThemeName) => {
  await installMockElectronBridge(page)

  let state = createState(theme)
  const playlistTracks = createTracks(40)

  await page.addInitScript((tracks) => {
    window.electronAPI = {
      ...window.electronAPI,
      fetchMusicLoginStatus: async () => ({
        authenticated: true,
        userId: 7,
        nickname: 'Regression DJ',
        avatarUrl: '',
      }),
      fetchMusicPlaylists: async () => ([
        {
          id: 11,
          sourcePlaylistId: 11,
          name: 'Long Playlist',
          trackCount: tracks.length,
          coverUrl: '',
          specialType: 0,
          subscribed: false,
          creatorId: 7,
          creatorName: 'Regression DJ',
          description: '',
          playCount: 0,
          copywriter: '',
          exploreSourceLabel: '',
          isExplore: false,
        },
      ]),
      fetchMusicPlaylistTracks: async () => tracks,
      fetchMusicExplorePlaylists: async () => [],
      musicLogout: async () => undefined,
      getMusicSongUrl: async () => ({
        url: null,
        level: 'standard',
        streamDurationMs: 0,
        previewStartMs: 0,
        previewEndMs: 0,
        fee: 0,
        code: 200,
        freeTrialInfo: null,
      }),
      recordMusicPlay: async () => 1,
    }
  }, playlistTracks)

  await page.route('**/api/state', async (route) => {
    const request = route.request()

    if (request.method() === 'GET') {
      await route.fulfill({ json: state })
      return
    }

    if (request.method() === 'PUT') {
      state = createPlaywrightState(JSON.parse(request.postData() ?? '{}'))
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/state/snapshot', async (route) => {
    state = createPlaywrightState(JSON.parse(route.request().postData() ?? '{}'))
    await route.fulfill({ status: 204 })
  })

  await page.route('**/api/providers', async (route) => {
    await route.fulfill({
      json: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })
  })

  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      json: {
        state: 'idle',
        logs: [],
      },
    })
  })

  await page.route('**/api/onboarding/status', async (route) => {
    await route.fulfill({
      json: {
        completed: true,
        dismissed: false,
      },
    })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`music card keeps a fixed shell height and scrolls internally in ${theme} theme`, async ({ page }) => {
    await installMockApis(page, theme)
    await page.setViewportSize({ width: 1280, height: 960 })
    await page.goto('http://localhost:5173')

    const cardShell = page.locator('.card-shell').first()
    const playlistHeader = page.locator('.music-playlist-header').first()
    const trackList = page.locator('.music-track-list')

    await expect(cardShell).toBeVisible()
    await expect(playlistHeader).toBeVisible()

    const initialShellHeight = await cardShell.evaluate((node) => node.getBoundingClientRect().height)

    await playlistHeader.click()
    await expect(trackList).toBeVisible()

    const metrics = await page.evaluate(() => {
      const cardShell = document.querySelector('.card-shell')
      const musicBody = document.querySelector('.music-card-body')

      if (!(cardShell instanceof HTMLElement) || !(musicBody instanceof HTMLElement)) {
        throw new Error('Expected music card shell and body to exist')
      }

      return {
        shellHeight: cardShell.getBoundingClientRect().height,
        bodyClientHeight: musicBody.clientHeight,
        bodyScrollHeight: musicBody.scrollHeight,
      }
    })

    expect(metrics.shellHeight).toBeLessThanOrEqual(initialShellHeight + 2)
    expect(metrics.bodyScrollHeight).toBeGreaterThan(metrics.bodyClientHeight + 20)
  })
}
