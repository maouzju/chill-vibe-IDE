import { expect, test, type Locator, type Page } from '@playwright/test'

import { attachImagesToMessageMeta } from '../shared/chat-attachments.ts'
import {
  createDefaultState,
  createPane,
  createSplit,
  minLineHeightScale,
} from '../shared/default-state.ts'
import {
  BRAINSTORM_TOOL_MODEL,
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
} from '../shared/models.ts'
import type { AppState, SetupStatus } from '../shared/schema.ts'
import { installMockElectronBridge } from './electron-bridge.ts'
import { createPlaywrightState } from './playwright-state.ts'

const appUrl = process.env.PLAYWRIGHT_APP_URL ?? 'http://localhost:5173'

const attachmentPreviewSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
    <rect width="960" height="640" fill="#0f1726" />
    <rect x="72" y="72" width="816" height="496" rx="28" fill="#5ca6ff" opacity="0.22" />
    <rect x="128" y="132" width="704" height="376" rx="24" fill="#f4f8ff" />
    <circle cx="214" cy="220" r="54" fill="#0f1726" opacity="0.18" />
    <rect x="300" y="188" width="378" height="44" rx="12" fill="#0f1726" opacity="0.74" />
    <rect x="300" y="262" width="280" height="28" rx="12" fill="#0f1726" opacity="0.42" />
    <rect x="128" y="544" width="262" height="22" rx="11" fill="#f4f8ff" opacity="0.72" />
  </svg>
`.trim()

const tinyGifBase64 = 'R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=='

const readRgb = (value: string) => {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  const srgbMatch = value.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/)

  if (match) {
    return match.slice(1, 4).map(Number)
  }

  if (srgbMatch) {
    return srgbMatch.slice(1, 4).map((channel) => Math.round(Number(channel) * 255))
  }

  if (value.includes('oklab(')) {
    const body = value.slice(value.indexOf('oklab(') + 'oklab('.length, value.lastIndexOf(')'))
    const parts = body
      .split('/')[0]
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .map(Number)

    if (parts.length === 3 && parts.every((part) => Number.isFinite(part))) {
      const [lightness, a, b] = parts
      const lComponent = lightness + 0.3963377774 * a + 0.2158037573 * b
      const mComponent = lightness - 0.1055613458 * a - 0.0638541728 * b
      const sComponent = lightness - 0.0894841775 * a - 1.291485548 * b

      const linearRed =
        4.0767416621 * lComponent ** 3 - 3.3077115913 * mComponent ** 3 + 0.2309699292 * sComponent ** 3
      const linearGreen =
        -1.2684380046 * lComponent ** 3 + 2.6097574011 * mComponent ** 3 - 0.3413193965 * sComponent ** 3
      const linearBlue =
        -0.0041960863 * lComponent ** 3 - 0.7034186147 * mComponent ** 3 + 1.707614701 * sComponent ** 3

      const toSrgb = (channel: number) => {
        const clamped = Math.min(Math.max(channel, 0), 1)

        if (clamped <= 0.0031308) {
          return Math.round(clamped * 12.92 * 255)
        }

        return Math.round((1.055 * clamped ** (1 / 2.4) - 0.055) * 255)
      }

      return [toSrgb(linearRed), toSrgb(linearGreen), toSrgb(linearBlue)]
    }
  }

  throw new Error(`Could not parse RGB value: ${value}`)
}

const maxChannel = (value: number[]) => Math.max(...value)

const isBlueTint = ([red, green, blue]: number[]) => blue > red && blue > green
const lacksGreenCast = ([, green, blue]: number[]) => blue >= green
const isTransparentColor = (value: string) => {
  const trimmed = value.trim()

  if (trimmed === 'transparent') {
    return true
  }

  if (/rgba?\(\s*\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?){2}\s*,\s*0(?:\.0+)?\s*\)/.test(trimmed)) {
    return true
  }

  const slashAlphaMatch = trimmed.match(/\/\s*([0-9.]+)\s*\)$/)
  return slashAlphaMatch ? Number(slashAlphaMatch[1]) === 0 : false
}

const readComputedValue = async (locator: Locator, property: string) =>
  locator.evaluate((node, cssProperty) => getComputedStyle(node).getPropertyValue(cssProperty), property)

const readComputedRgb = async (locator: Locator, property: string) =>
  readRgb(await readComputedValue(locator, property))

const readRect = async (locator: Locator) =>
  locator.evaluate((node) => {
    const rect = node.getBoundingClientRect()

    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    }
  })

const pasteImageIntoTextarea = async (textarea: Locator) => {
  await textarea.evaluate((node, base64) => {
    const binary = window.atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const file = new File([bytes], 'pasted-image.gif', { type: 'image/gif' })
    const dataTransfer = new DataTransfer()
    const event = new Event('paste', { bubbles: true, cancelable: true })

    dataTransfer.items.add(file)
    Object.defineProperty(event, 'clipboardData', {
      configurable: true,
      value: dataTransfer,
    })

    node.dispatchEvent(event)
  }, tinyGifBase64)
}

const expectChildToFitWithinParent = async (parent: Locator, child: Locator, label: string) => {
  const [parentRect, childRect] = await Promise.all([readRect(parent), readRect(child)])

  expect(
    childRect.top >= parentRect.top - 1,
    `${label} overflowed above its parent. parent=${JSON.stringify(parentRect)} child=${JSON.stringify(childRect)}`,
  ).toBeTruthy()
  expect(
    childRect.bottom <= parentRect.bottom + 1,
    `${label} overflowed below its parent. parent=${JSON.stringify(parentRect)} child=${JSON.stringify(childRect)}`,
  ).toBeTruthy()
}

const expectTextBlockNotClipped = async (locator: Locator, label: string) => {
  await expect
    .poll(
      async () =>
        locator.evaluate((node) => ({
          display: getComputedStyle(node).display,
          verticallyClipped: node.scrollHeight > node.clientHeight + 1,
          horizontallyClipped: node.scrollWidth > node.clientWidth + 1,
        })),
      { message: `${label} should stay fully visible without clipping.` },
    )
    .toEqual({
      display: 'block',
      verticallyClipped: false,
      horizontallyClipped: false,
    })
}

const readContentWidth = async (locator: Locator) =>
  locator.evaluate((node) => {
    const styles = getComputedStyle(node)
    const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0
    const paddingRight = Number.parseFloat(styles.paddingRight) || 0

    return node.clientWidth - paddingLeft - paddingRight
  })

const expectAddLaneIconToMatchBorder = async (locator: Locator) => {
  await expect
    .poll(async () => {
      const [iconColor, borderColor] = await Promise.all([
        readComputedRgb(locator, 'color'),
        readComputedRgb(locator, 'border-top-color'),
      ])

      return JSON.stringify(iconColor) === JSON.stringify(borderColor)
    })
    .toBeTruthy()
}

const readHitTarget = async (page: Page, x: number, y: number) =>
  page.evaluate(
    ({ pointX, pointY }) => {
      const element = document.elementFromPoint(pointX, pointY)
      const htmlElement = element instanceof HTMLElement ? element : null

      return {
        className: htmlElement?.className ?? '',
        text: htmlElement?.innerText?.slice(0, 120) ?? '',
        insideDialog: Boolean(element?.closest('.structured-preview-card')),
        insideCard: Boolean(element?.closest('.card-shell')),
      }
    },
    { pointX: x, pointY: y },
  )

const createMockState = (): AppState => ({
    version: 1 as const,
    settings: {
      language: 'zh-CN',
      theme: 'dark' as const,
      fontScale: 1,
      lineHeightScale: 1,
      resilientProxyEnabled: true,
      requestModels: {
        codex: 'gpt-5.4',
        claude: 'claude-opus-4-6',
      },
      modelReasoningEfforts: {
        codex: {},
        claude: {},
      },
      providerProfiles: {
        codex: {
          activeProfileId: 'codex-profile-1',
          profiles: [
            {
              id: 'codex-profile-1',
              name: 'Codex Proxy',
              apiKey: 'sk-codex',
              baseUrl: 'https://api.openai.example/v1',
            },
          ],
        },
        claude: {
          activeProfileId: 'claude-profile-1',
          profiles: [
            {
              id: 'claude-profile-1',
              name: 'Claude Proxy',
              apiKey: 'sk-claude',
              baseUrl: 'https://api.anthropic.example',
            },
          ],
        },
      },
    },
    updatedAt: new Date().toISOString(),
    columns: [
      {
        id: 'col-1',
        title: 'Development Channel',
        provider: 'codex' as const,
        workspacePath: 'd:\\Git\\chill-vibe',
        model: 'gpt-5.4',
        cards: [
          {
            id: 'card-1',
            title: 'Feature Chat',
            status: 'idle' as const,
            size: 560,
            provider: 'codex' as const,
            model: 'gpt-5.4',
            reasoningEffort: 'medium',
            draft: '',
            messages: [],
          },
        ],
      },
    ],
  })

const createColumnHeaderDropState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.columns = [
    {
      ...state.columns[0]!,
      id: 'col-1',
      title: 'Source Workspace',
      provider: 'codex',
      workspacePath: 'd:\\Git\\source-workspace',
      model: 'gpt-5.4',
      cards: [
        {
          ...state.columns[0]!.cards[0]!,
          id: 'card-1',
          title: 'Source Chat',
          provider: 'codex',
          model: 'gpt-5.4',
        },
      ],
    },
    {
      id: 'col-2',
      title: 'Target Workspace',
      provider: 'claude',
      workspacePath: 'd:\\Git\\target-workspace',
      model: 'claude-opus-4-6',
      cards: [
        {
          ...state.columns[0]!.cards[0]!,
          id: 'card-2',
          title: 'Target Chat',
          provider: 'claude',
          model: 'claude-opus-4-6',
        },
      ],
    },
  ]

  return state
}

const createWeatherMenuState = (theme: 'dark' | 'light'): AppState => {
  const state = createMockState()
  state.settings.theme = theme
  state.settings.experimentalWeatherEnabled = true
  state.columns[0]!.title = 'Layering Test'
  state.columns[0]!.cards[0] = {
    ...state.columns[0]!.cards[0]!,
    title: '问题2',
    provider: 'codex',
    model: WEATHER_TOOL_MODEL,
    reasoningEffort: 'medium',
  }

  return state
}

const configureColumnCardsAndLayout = (
  state: AppState,
  cards: Array<Record<string, unknown> & { id: string }>,
  layout: ReturnType<typeof createPane> | ReturnType<typeof createSplit>,
  columnIndex = 0,
) => {
  const column = state.columns[columnIndex] as AppState['columns'][number] & {
    cards: Record<string, unknown>
    layout: ReturnType<typeof createPane> | ReturnType<typeof createSplit>
  }

  column.cards = Object.fromEntries(cards.map((card) => [card.id, card]))
  column.layout = layout

  return state
}

const createPaneTabsState = (theme: 'dark' | 'light'): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.settings.theme = theme

  const firstCard = state.columns[0]!.cards[0]!
  const firstCardId = firstCard.id
  const secondCardId = 'card-pane-review'
  const thirdCardId = 'card-pane-notes'

  state.columns[0] = {
    ...state.columns[0]!,
    cards: {
      [firstCardId]: {
        ...firstCard,
        id: firstCardId,
        title: 'Feature chat',
        draft: 'Refine tab drag targets',
      },
      [secondCardId]: {
        ...firstCard,
        id: secondCardId,
        title: 'Review',
        status: 'streaming',
        draft: '',
        messages: [],
      },
      [thirdCardId]: {
        ...firstCard,
        id: thirdCardId,
        title: 'Notes',
        status: 'idle',
        draft: 'Track follow-up polish',
        messages: [],
      },
    },
    layout: createSplit(
      'horizontal',
      [
        createPane([firstCardId, secondCardId], firstCardId, 'pane-left'),
        createPane([thirdCardId], thirdCardId, 'pane-right'),
      ],
      [0.62, 0.38],
      'split-root',
    ),
  }
  state.columns = [state.columns[0]!]

  return state
}

const createActiveStreamingPaneTabsState = (theme: 'dark' | 'light'): AppState => {
  const state = createPaneTabsState(theme)
  const layout = state.columns[0]!.layout

  if (layout.type === 'split' && layout.children[0]?.type === 'pane') {
    layout.children[0] = createPane(layout.children[0].tabs, 'card-pane-review', layout.children[0].id)
  }

  return state
}

const createMultiTabGitPaneState = (theme: 'dark' | 'light'): AppState => {
  const state = createMockState()
  state.settings.language = 'zh-CN'
  state.settings.theme = theme

  const baseCard = state.columns[0]!.cards[0]!
  const gitCardId = 'card-pane-git'
  const notesCardId = 'card-pane-notes'

  configureColumnCardsAndLayout(
    state,
    [
      {
        ...baseCard,
        id: gitCardId,
        title: '新会话',
        provider: 'codex',
        model: GIT_TOOL_MODEL,
        reasoningEffort: 'medium',
        size: 640,
        messages: [],
      },
      {
        ...baseCard,
        id: notesCardId,
        title: '123123',
        draft: 'Keep this tab mounted while Git stays active.',
        messages: [],
      },
    ],
    createPane([gitCardId, notesCardId], gitCardId, 'pane-git'),
  )

  return state
}

const createTrailingActivePaneTabsState = (theme: 'dark' | 'light'): AppState => {
  const state = createPaneTabsState(theme)
  const layout = state.columns[0]!.layout

  if (layout.type === 'split' && layout.children[0]?.type === 'pane') {
    layout.children[0] = createPane(layout.children[0].tabs, 'card-pane-review', layout.children[0].id)
  }

  return state
}

const createTopbarToolLauncherState = (
  theme: 'dark' | 'light',
  openAmbienceModel?: string,
): AppState => {
  const state = createMockState()
  state.settings.theme = theme
  state.settings.experimentalMusicEnabled = true
  state.settings.experimentalWhiteNoiseEnabled = true
  state.settings.experimentalWeatherEnabled = true

  if (openAmbienceModel) {
    const chatCard = state.columns[0]!.cards[0]!
    const ambienceCard = {
      ...chatCard,
      id: `open-${openAmbienceModel}`,
      title: openAmbienceModel === WEATHER_TOOL_MODEL ? 'Weather' : 'Ambience',
      provider: 'codex' as const,
      model: openAmbienceModel,
      reasoningEffort: 'medium',
      messages: [],
    }

    state.columns[0] = {
      ...state.columns[0]!,
      cards: {
        [chatCard.id]: chatCard,
        [ambienceCard.id]: ambienceCard,
      },
      layout: createPane([chatCard.id, ambienceCard.id], chatCard.id, 'pane-topbar-tool-launchers'),
    }
  }

  return state
}

const createBrainstormToolState = (theme: 'dark' | 'light'): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.settings.theme = theme
  state.columns = [
    {
      ...state.columns[0]!,
      title: 'Brainstorm Workspace',
      cards: [
        {
          ...state.columns[0]!.cards[0]!,
          id: 'brainstorm-card',
          title: 'Brainstorm',
          provider: 'codex',
          model: BRAINSTORM_TOOL_MODEL,
          reasoningEffort: 'medium',
          size: 660,
          draft: 'How can we make onboarding feel more playful for new users?',
          brainstorm: {
            prompt: 'How can we make onboarding feel more playful for new users?',
            provider: 'codex',
            model: 'gpt-5.4',
            answerCount: 6,
            failedAnswers: [],
            answers: [
              {
                id: 'idea-1',
                content: 'Starter streak\n- Reward the first three setup steps\n- Show a visible momentum meter',
                status: 'done',
                error: '',
              },
              {
                id: 'idea-2',
                content: 'Choose-your-own setup path\n- Let users pick ship fast or learn deeply\n- Tailor the checklist tone',
                status: 'done',
                error: '',
              },
              {
                id: 'idea-3',
                content: 'First-win remix\n- Turn the first success into a shareable mini card\n- Encourage team bragging rights',
                status: 'done',
                error: '',
              },
              {
                id: 'idea-4',
                content: 'Workspace side quest\n- Hide one optional surprise action after the basics',
                status: 'done',
                error: '',
              },
              {
                id: 'idea-5',
                content: '',
                status: 'error',
                error: 'Route was unavailable for this answer.',
              },
              {
                id: 'idea-6',
                content: 'Buddy unlock\n- Let an invited teammate unlock an extra onboarding shortcut',
                status: 'done',
                error: '',
              },
            ],
          },
          messages: [],
        },
      ],
    },
  ]

  return state
}

const createMusicToolState = (theme: 'dark' | 'light'): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.settings.theme = theme
  state.settings.experimentalMusicEnabled = true
  state.settings.musicAlbumCoverEnabled = true
  state.columns = [
    {
      ...state.columns[0]!,
      title: 'Music Workspace',
      cards: [
        {
          ...state.columns[0]!.cards[0]!,
          id: 'music-card',
          title: 'Music',
          provider: 'codex',
          model: MUSIC_TOOL_MODEL,
          reasoningEffort: 'medium',
          size: 620,
          messages: [],
        },
      ],
    },
  ]

  return state
}

const createMusicSplitDropState = (theme: 'dark' | 'light'): AppState => {
  const state = createColumnHeaderDropState()
  state.settings.theme = theme
  state.settings.experimentalMusicEnabled = true
  state.settings.musicAlbumCoverEnabled = true
  state.columns[1] = {
    ...state.columns[1]!,
    title: 'Music Workspace',
    provider: 'codex',
    model: 'gpt-5.4',
    cards: [
      {
        ...state.columns[1]!.cards[0]!,
        id: 'music-card',
        title: 'Music',
        provider: 'codex',
        model: MUSIC_TOOL_MODEL,
        reasoningEffort: 'medium',
        size: 620,
        messages: [],
      },
    ],
  }

  return state
}

const createCrossWorkspaceWeatherDragState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.settings.experimentalWeatherEnabled = true
  state.columns = [
    {
      ...state.columns[0]!,
      id: 'col-1',
      title: 'Weather Workspace',
      provider: 'codex',
      workspacePath: 'd:\\Git\\weather-workspace',
      model: 'gpt-5.4',
      cards: [
        {
          ...state.columns[0]!.cards[0]!,
          id: 'weather-card',
          title: 'Weather',
          provider: 'codex',
          model: WEATHER_TOOL_MODEL,
          reasoningEffort: 'medium',
          messages: [],
        },
      ],
    },
    {
      id: 'col-2',
      title: 'Target Workspace',
      provider: 'claude',
      workspacePath: 'd:\\Git\\target-workspace',
      model: 'claude-opus-4-6',
      cards: [
        {
          ...state.columns[0]!.cards[0]!,
          id: 'target-chat',
          title: 'Target Chat',
          provider: 'claude',
          model: 'claude-opus-4-6',
          reasoningEffort: 'medium',
          messages: [],
        },
      ],
    },
  ]

  return state
}

const createShrinkingPaneTabsState = (theme: 'dark' | 'light'): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.settings.theme = theme
  state.columns[0]!.width = 440

  const baseCard = state.columns[0]!.cards[0]!
  const cards = [
    {
      ...baseCard,
      id: 'card-shrink-1',
      title: 'Feature Chat',
      draft: 'Keep tabs compact',
      messages: [],
    },
    {
      ...baseCard,
      id: 'card-shrink-2',
      title: 'Review and polish',
      draft: '',
      messages: [],
    },
    {
      ...baseCard,
      id: 'card-shrink-3',
      title: 'Release notes',
      draft: '',
      messages: [],
    },
    {
      ...baseCard,
      id: 'card-shrink-4',
      title: 'Follow-up fixes',
      draft: '',
      messages: [],
    },
  ]

  configureColumnCardsAndLayout(
    state,
    cards,
    createPane(cards.map((card) => card.id), 'card-shrink-2', 'pane-shrink'),
  )

  return state
}

const createSinglePaneChromeState = (theme: 'dark' | 'light'): AppState => {
  const state = createDefaultState('d:\\Git\\chill-vibe', 'zh-CN')
  state.settings.theme = theme
  state.columns = [state.columns[0]!]

  return state
}

const createStructuredChatState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.columns[0]!.cards[0]!.status = 'streaming'
  state.columns[0]!.cards[0]!.messages = [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'I inspected the workspace entrypoints first.',
      createdAt: '2026-04-05T12:00:00.000Z',
      meta: {
        provider: 'codex',
      },
    },
    {
      id: 'command-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:00:02.000Z',
      meta: {
        provider: 'codex',
        kind: 'command',
        structuredData: JSON.stringify({
          itemId: 'item_1',
          status: 'completed',
          command: 'git status --short',
          output: 'M src/App.tsx\nM src/index.css',
          exitCode: 0,
        }),
      },
    },
    {
      id: 'command-2',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:00:03.000Z',
      meta: {
        provider: 'codex',
        kind: 'command',
        structuredData: JSON.stringify({
          itemId: 'item_2',
          status: 'completed',
          command: 'Get-Content C:\\Users\\demo\\.codex\\skills\\chill-vibe-full-regression\\SKILL.md',
          output: '---\nname: chill-vibe-full-regression\ndescription: Run Chill Vibe regressions',
          exitCode: 0,
        }),
      },
    },
    {
      id: 'reasoning-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:00:04.000Z',
      meta: {
        provider: 'codex',
        kind: 'reasoning',
        structuredData: JSON.stringify({
          itemId: 'item_3',
          status: 'completed',
          text: '**Planning**\n\nCheck the renderer bridge next.',
        }),
      },
    },
  ]

  return state
}

const createStructuredChatStateZh = (): AppState => {
  const state = createMockState()
  state.settings.language = 'zh-CN'
  state.columns[0]!.cards[0]!.status = 'streaming'
  state.columns[0]!.cards[0]!.messages = [
    {
      id: 'command-zh-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:10:00.000Z',
      meta: {
        provider: 'codex',
        kind: 'command',
        structuredData: JSON.stringify({
          itemId: 'zh_item_1',
          status: 'completed',
          command: '$content = Get-Content -Path src\\components\\ChatCard.tsx; $content[1638..1698]',
          output: 'test body...',
          exitCode: 0,
        }),
      },
    },
    {
      id: 'command-zh-2',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:10:01.000Z',
      meta: {
        provider: 'codex',
        kind: 'command',
        structuredData: JSON.stringify({
          itemId: 'zh_item_2',
          status: 'completed',
          command: '$content = Get-Content -Path src\\index.css; $content[3478..3855]',
          output: 'more test body...',
          exitCode: 0,
        }),
      },
    },
    {
      id: 'command-zh-3',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:10:02.000Z',
      meta: {
        provider: 'codex',
        kind: 'command',
        structuredData: JSON.stringify({
          itemId: 'zh_item_3',
          status: 'completed',
          command: 'git status --short',
          output: 'M src/components/MessageBubble.tsx\nM src/index.css',
          exitCode: 0,
        }),
      },
    },
    {
      id: 'reasoning-zh-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:10:03.000Z',
      meta: {
        provider: 'codex',
        kind: 'reasoning',
        structuredData: JSON.stringify({
          itemId: 'zh_item_4',
          status: 'completed',
          text: '**Inspecting image support** I might need to inspect the current status and view the image if necessary.',
        }),
      },
    },
  ]

  return state
}

const createQuietMarkdownState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'zh-CN'
  state.columns[0]!.cards[0]!.messages = [
    {
      id: 'assistant-inline-markdown-1',
      role: 'assistant',
      content: [
        '我把真正还在发蓝的部分缩到这三个：',
        '',
        '- `codex exec` / `codex exec resume` 这种 inline code pill',
        '- [`shared/i18n.ts`](shared/i18n.ts) 这种本地文件链接',
        '- [`server/providers.ts`](server/providers.ts) 和 `/compact` 这种正文里的强调片段',
      ].join('\n'),
      createdAt: '2026-04-12T03:30:00.000Z',
    },
  ]

  return state
}

const createStreamingPlainTranscriptState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'zh-CN'
  state.columns[0]!.cards[0]!.status = 'streaming'
  state.columns[0]!.cards[0]!.messages = [
    {
      id: 'assistant-streaming-plain-1',
      role: 'assistant',
      content: [
        '尚未解决：已定位为桌面聊天链路没有把可续传状态正确传到前端重试分支。',
        '',
        '我先把可恢复会话和 UI 残留一起核对。',
      ].join('\n'),
      createdAt: '2026-04-12T03:35:00.000Z',
    },
  ]

  return state
}

const createStreamingStructuredCommandGroupState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.columns[0]!.cards[0]!.status = 'streaming'
  state.columns[0]!.cards[0]!.messages = [
    {
      id: 'command-streaming-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:00:02.000Z',
      meta: {
        provider: 'codex',
        kind: 'command',
        structuredData: JSON.stringify({
          itemId: 'streaming_item_1',
          status: 'completed',
          command: 'Get-ChildItem src/components | Select-Object Name',
          output: 'Name\n----\nChatCard.tsx\nStructuredBlocks.tsx',
          exitCode: 0,
        }),
      },
    },
    {
      id: 'command-streaming-2',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:00:03.000Z',
      meta: {
        provider: 'codex',
        kind: 'command',
        structuredData: JSON.stringify({
          itemId: 'streaming_item_2',
          status: 'completed',
          command: 'Get-ChildItem server | Select-Object Name',
          output: 'Name\n----\nchat-manager.ts\nproviders.ts',
          exitCode: 0,
        }),
      },
    },
    {
      id: 'command-streaming-3',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:00:04.000Z',
      meta: {
        provider: 'codex',
        kind: 'command',
        structuredData: JSON.stringify({
          itemId: 'streaming_item_3',
          status: 'completed',
          command: 'Get-Content package.json | Select-Object -First 220',
          output: '{\n  "name": "chill-vibe"\n}',
          exitCode: 0,
        }),
      },
    },
  ]

  return state
}

const createClaudeStructuredChatState = (): AppState => {
  const state = createMockState()
  state.columns[0]!.provider = 'claude'
  state.columns[0]!.model = 'claude-opus-4-6'
  state.columns[0]!.cards[0] = {
    ...state.columns[0]!.cards[0]!,
    provider: 'claude',
    model: 'claude-opus-4-6',
    messages: [
      {
        id: 'tool-1',
        role: 'assistant',
        content: '',
        createdAt: '2026-04-05T12:05:00.000Z',
        meta: {
          provider: 'claude',
          kind: 'tool',
          structuredData: JSON.stringify({
            itemId: 'toolu_grep',
            status: 'completed',
            toolName: 'Grep',
            summary: '搜索文本：游戏|玩法|设计|机制|循环',
            toolInput: {
              pattern: '游戏|玩法|设计|机制|循环',
              path: 'sample-wiki',
            },
          }),
        },
      },
      {
        id: 'tool-2',
        role: 'assistant',
        content: '',
        createdAt: '2026-04-05T12:05:01.000Z',
        meta: {
          provider: 'claude',
          kind: 'tool',
          structuredData: JSON.stringify({
            itemId: 'toolu_glob',
            status: 'completed',
            toolName: 'Glob',
            summary: '搜索文件：sample-wiki/*MOC*',
            toolInput: {
              pattern: 'sample-wiki/*MOC*',
              path: '.',
            },
          }),
        },
      },
      {
        id: 'tool-3',
        role: 'assistant',
        content: '',
        createdAt: '2026-04-05T12:05:02.000Z',
        meta: {
          provider: 'claude',
          kind: 'tool',
          structuredData: JSON.stringify({
            itemId: 'toolu_read',
            status: 'completed',
            toolName: 'Read',
            summary: '读取 游戏设计 MOC.md',
            toolInput: {
              file_path: '游戏设计 MOC.md',
            },
          }),
        },
      },
    ],
  }

  return state
}

const createStructuredTodoState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.columns[0]!.provider = 'claude'
  state.columns[0]!.model = 'claude-opus-4-6'
  state.columns[0]!.cards[0] = {
    ...state.columns[0]!.cards[0]!,
    provider: 'claude',
    model: 'claude-opus-4-6',
    status: 'streaming',
    messages: [
      {
        id: 'todo-1',
        role: 'assistant',
        content: '',
        createdAt: '2026-04-10T12:05:00.000Z',
        meta: {
          provider: 'claude',
          kind: 'todo',
          structuredData: JSON.stringify({
            itemId: 'todo_update',
            status: 'completed',
            items: [
              {
                id: 'task-1',
                content: 'Inspect the current agent activity pipeline',
                status: 'completed',
              },
              {
                id: 'task-2',
                content: 'Render the VS Code-like task panel',
                activeForm: 'Rendering the VS Code-like task panel',
                status: 'in_progress',
                priority: 'high',
              },
              {
                id: 'task-3',
                content: 'Verify the new task surface in both themes',
                status: 'pending',
              },
            ],
          }),
        },
      },
    ],
  }

  return state
}

const createChangesSummaryState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'zh-CN'
  state.columns[0]!.cards[0]!.messages = [
    {
      id: 'changes-summary-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-09T12:06:00.000Z',
      meta: {
        provider: 'codex',
        kind: 'changes-summary',
        structuredData: JSON.stringify([
          {
            path: 'D:\\Git\\chill-vibe\\src\\index.css',
            addedLines: 20,
            removedLines: 17,
          },
          {
            path: 'D:\\Git\\chill-vibe\\src\\components\\MessageBubble.tsx',
            addedLines: 38,
            removedLines: 38,
          },
          {
            path: 'D:\\Git\\chill-vibe\\src\\components\\StructuredBlocks.tsx',
            addedLines: 5,
            removedLines: 6,
          },
        ]),
      },
    },
  ]

  return state
}

const createEditedFilesStructuredState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.columns[0]!.cards[0]!.messages = [
    {
      id: 'edits-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:06:00.000Z',
      meta: {
        provider: 'codex',
        kind: 'edits',
        structuredData: JSON.stringify({
          itemId: 'workspace_edits',
          status: 'completed',
          files: [
            {
              path: 'D:\\Git\\chill-vibe\\src\\components\\GitFullDialog.tsx',
              kind: 'modified',
              addedLines: 1,
              removedLines: 1,
              patch:
                'diff --git a/src/components/GitFullDialog.tsx b/src/components/GitFullDialog.tsx\nindex abc1234..def5678 100644\n--- a/src/components/GitFullDialog.tsx\n+++ b/src/components/GitFullDialog.tsx\n@@ -198,2 +198,2 @@\n-          autoStagePaths.length > 0\n+          mode === \'incremental\' && autoStagePaths.length > 0\n           ? await setGitStage({',
            },
          ],
        }),
      },
    },
  ]

  return state
}

const createOverflowEditedFilesStructuredState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'zh-CN'
  state.columns[0]!.width = 420
  state.columns[0]!.cards[0]!.messages = [
    {
      id: 'edits-overflow-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:06:30.000Z',
      meta: {
        provider: 'codex',
        kind: 'edits',
        structuredData: JSON.stringify({
          itemId: 'workspace_edits_overflow',
          status: 'completed',
          files: [
            {
              path: 'D:\\Git\\baztato\\client\\Assets\\Scripts\\Game\\Backpack\\System\\BazEffects\\EconomyShop\\BazEffectGuaranteedPatchedItemOnShopRefreshPerRound.cs.meta',
              kind: 'added',
              addedLines: 11,
              removedLines: 0,
              patch: [
                'diff --git a/Assets/Scripts/Game/Backpack/System/BazEffects/EconomyShop/BazEffectGuaranteedPatchedItemOnShopRefreshPerRound.cs.meta b/Assets/Scripts/Game/Backpack/System/BazEffects/EconomyShop/BazEffectGuaranteedPatchedItemOnShopRefreshPerRound.cs.meta',
                'new file mode 100644',
                'index 0000000..abc1234',
                '--- /dev/null',
                '+++ b/Assets/Scripts/Game/Backpack/System/BazEffects/EconomyShop/BazEffectGuaranteedPatchedItemOnShopRefreshPerRound.cs.meta',
                '@@ -0,0 +1,11 @@',
                '+fileFormatVersion: 2',
                '+guid: 701e2295416e4ba7bc943e7bf9fbfec3',
                '+MonoImporter:',
                '+  externalObjects: {}',
                '+  serializedVersion: 2',
                '+  defaultReferences: []',
                '+  executionOrder: 0',
                '+  icon: {fileID: 0}',
                '+  userData: ',
                '+  assetBundleName: ',
                '+  assetBundleVariant: ',
              ].join('\n'),
            },
          ],
        }),
      },
    },
  ]

  return state
}

const createOverflowStructuredState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.columns[0]!.width = 420
  state.columns[0]!.cards[0]!.messages = [
    {
      id: 'command-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:07:00.000Z',
      meta: {
        provider: 'codex',
        kind: 'command',
        structuredData: JSON.stringify({
          itemId: 'item_1',
          status: 'completed',
          command: 'pnpm test -- --runInBand',
          output:
            'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12',
          exitCode: 0,
        }),
      },
    },
    {
      id: 'reasoning-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:07:01.000Z',
      meta: {
        provider: 'codex',
        kind: 'reasoning',
        structuredData: JSON.stringify({
          itemId: 'item_2',
          status: 'completed',
          text:
            'Step 1 keeps the board shell quiet.\nStep 2 removes redundant borders.\nStep 3 aligns the column header actions.\nStep 4 verifies the compact preview state.\nStep 5 checks the expanded dialog content.\nStep 6 confirms the light theme surface.\nStep 7 confirms the dark theme surface.\nStep 8 reruns the visual regression.',
        }),
      },
    },
    {
      id: 'tool-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:07:02.000Z',
      meta: {
        provider: 'claude',
        kind: 'tool',
        structuredData: JSON.stringify({
          itemId: 'toolu_read',
          status: 'completed',
          toolName: 'Read',
          summary:
            'Inspected ChatCard.tsx, App.tsx, index.css, the shared schema, provider parsing, renderer state hydration, board layout constraints, theme tokens, card sizing behavior, and message rendering flow to trace how structured activity renders inside the board and why long summaries need compact truncation before the detail dialog opens without blowing up the current card height.',
        }),
      },
    },
    {
      id: 'edits-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-04-05T12:07:03.000Z',
      meta: {
        provider: 'codex',
        kind: 'edits',
        structuredData: JSON.stringify({
          itemId: 'workspace_edits',
          status: 'completed',
          files: [
            {
              path: 'src/components/ChatCard.tsx',
              kind: 'modified',
              addedLines: 18,
              removedLines: 2,
              patch:
                '@@ -1,4 +1,14 @@\n-const oldValue = true\n+const newValue = true\n+const secondValue = true\n+const thirdValue = true\n+const fourthValue = true\n+const fifthValue = true\n+const sixthValue = true\n+const seventhValue = true\n+const eighthValue = true\n+const ninthValue = true\n+const tenthValue = true\n+const eleventhValue = true',
            },
          ],
        }),
      },
    },
  ]

  state.columns.push({
    id: 'col-2',
    title: 'Review Workspace',
    provider: 'claude',
    workspacePath: 'd:\\Git\\review-workspace',
    model: 'claude-opus-4-6',
    width: 420,
    cards: [
      {
        id: 'card-2',
        title: 'Draft chat',
        status: 'idle',
        size: 540,
        provider: 'claude',
        model: 'claude-opus-4-6',
        reasoningEffort: 'medium',
        draft: '',
        messages: [],
      },
    ],
  })

  return state
}

const createAttachmentPreviewState = (): AppState => {
  const state = createMockState()
  state.settings.language = 'en'
  state.columns[0]!.cards[0]!.messages = [
    {
      id: 'user-image-1',
      role: 'user',
      content: '',
      createdAt: '2026-04-05T12:08:00.000Z',
      meta: attachImagesToMessageMeta([
        {
          id: 'attachment-preview-1',
          fileName: 'design-reference.png',
          mimeType: 'image/png',
          sizeBytes: 24_576,
        },
      ]),
    },
  ]

  return state
}

const mockAppApis = async (
  page: Page,
  options?: {
    state?: AppState
    setupStatus?: SetupStatus
  },
) => {
  await installMockElectronBridge(page)

  let state = options?.state ?? createMockState()
  const setupStatus: SetupStatus = options?.setupStatus ?? {
    state: 'idle',
    logs: [],
  }

  await page.route('**/api/state', async (route) => {
    const request = route.request()

    if (request.method() === 'GET') {
      await route.fulfill({ json: createPlaywrightState(state) })
      return
    }

    if (request.method() === 'PUT') {
      state = JSON.parse(request.postData() ?? '{}')
      await route.fulfill({ json: state })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/state/snapshot', async (route) => {
    state = JSON.parse(route.request().postData() ?? '{}')
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
    await route.fulfill({ json: setupStatus })
  })
}

const mockMissingEnvironmentStatus = async (page: Page) => {
  await page.route('**/api/onboarding/status', async (route) => {
    await route.fulfill({
      json: {
        environment: {
          ready: false,
          checks: [
            { id: 'git', label: 'Git', available: false },
            { id: 'node', label: 'Node.js', available: true },
            { id: 'claude', label: 'Claude CLI', available: true },
            { id: 'codex', label: 'Codex CLI', available: false },
          ],
        },
        ccSwitch: {
          available: false,
        },
      },
    })
  })
}

const mockGitAnalysisResult = async (page: Page, content: string) => {
  await page.evaluate((analysisContent) => {
    const dispatchStreamEvent = (subscriptionId: string, eventName: string, data: unknown) => {
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

    if (!window.electronAPI) {
      throw new Error('Electron bridge is unavailable.')
    }

    window.electronAPI.requestChat = async () => ({ streamId: 'git-analysis-stream' })
    window.electronAPI.stopChat = async () => undefined
    window.electronAPI.subscribeChatStream = async (_streamId, subscriptionId) => {
      window.setTimeout(() => {
        dispatchStreamEvent(subscriptionId, 'assistant_message', {
          itemId: 'git-analysis-result',
          content: analysisContent,
        })
        dispatchStreamEvent(subscriptionId, 'done', {})
      }, 20)
    }
  }, content)
}

const installMockMusicApis = async (page: Page) => {
  await page.addInitScript((coverBase64) => {
    const coverUrl = `data:image/gif;base64,${coverBase64}`
    const tracks = Array.from({ length: 5 }, (_, index) => ({
      id: 1000 + index,
      name: `Track ${index + 1}`,
      artists: [`Artist ${index + 1}`],
      artistEntries: [{ id: 2000 + index, name: `Artist ${index + 1}` }],
      album: 'Regression Album',
      albumId: 3000,
      albumCoverUrl: coverUrl,
      durationMs: 180000 + index * 1000,
      position: index + 1,
    }))

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
          name: 'Late Night Shipping',
          trackCount: tracks.length,
          coverUrl,
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
  }, tinyGifBase64)
}

const mountThemeFixtures = async (page: Page) => {
  await page.evaluate(() => {
    document.getElementById('theme-fixtures')?.remove()

    const root = document.createElement('div')
    root.id = 'theme-fixtures'
    root.setAttribute('aria-hidden', 'true')
    root.style.cssText = [
      'position: fixed',
      'left: -9999px',
      'top: 0',
      'width: 260px',
      'display: grid',
      'gap: 12px',
      'pointer-events: none',
      'z-index: -1',
    ].join(';')
    root.innerHTML = `
      <div class="empty-card" id="fixture-empty-card">
        <div class="eyebrow">Empty</div>
        <h3 id="fixture-empty-title">Drop a card here</h3>
        <p id="fixture-empty-copy">Drag a card into this lane to keep working.</p>
      </div>
      <div class="empty-card is-drop-target" id="fixture-empty-card-active">
        <div class="eyebrow">Empty</div>
        <h3>Drop a card here</h3>
        <p>Drag a card into this lane to keep working.</p>
      </div>
      <div class="lane-drop-zone is-active" id="fixture-lane-drop-zone"></div>
      <input class="control control-title" id="fixture-control-title" value="Theme-safe title" />
      <div class="slash-command-menu" id="fixture-slash-menu">
        <button type="button" class="slash-command-item is-selected" id="fixture-slash-item">
          <span class="slash-command-name">/status</span>
          <span class="slash-command-meta">
            <span class="slash-command-badge is-native">Native</span>
            <span class="slash-command-description">Show workspace status</span>
          </span>
        </button>
      </div>
      <div class="message-content" id="fixture-message-content">
        <div class="message-attachment-list">
          <a class="message-attachment-frame" id="fixture-message-attachment" href="#">
            <img
              class="message-attachment-image"
              alt="Pasted image 1"
              src="data:image/gif;base64,R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=="
            />
          </a>
        </div>
      </div>
      <div class="composer-attachment-list">
        <div class="composer-attachment-item" id="fixture-composer-attachment">
          <img
            class="composer-attachment-image"
            alt="Pasted image 1"
            src="data:image/gif;base64,R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw=="
          />
          <button type="button" class="composer-attachment-remove" id="fixture-composer-remove">x</button>
        </div>
      </div>
      <div class="composer-attachment-note" id="fixture-composer-note">
        1 pasted image ready to send with the next message.
      </div>
    `

    document.body.appendChild(root)
  })
}

test('theme toggle applies dark and light surfaces consistently', async ({ page }) => {
  await mockAppApis(page, { state: createOverflowStructuredState() })
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()
  await mountThemeFixtures(page)

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const cardShell = page.locator('.card-shell').first()
  const cardHeader = page.locator('.composer-input-row').first()

  const readCardBackgroundValue = async () =>
    readComputedValue(cardShell, 'background-color')

  const readCardBackgroundImage = async () =>
    readComputedValue(cardShell, 'background-image')

  const readCardHeaderBackground = async () =>
    readComputedRgb(cardHeader, 'background-color')

  const readCardHeaderBackgroundValue = async () =>
    readComputedValue(cardHeader, 'background-color')

  const readPageBackground = async () =>
    readComputedRgb(page.locator('body'), 'background-color')

  const readPageBackgroundImage = async () =>
    readComputedValue(page.locator('body'), 'background-image')

  const readPrimaryButtonBackgroundImage = async () =>
    readComputedValue(page.locator('.icon-button.is-primary').first(), 'background-image')

  const readSelectBackground = async () =>
    readComputedRgb(page.locator('.model-select').first(), 'background-color')

  const readReasoningBackground = async () => {
    await page.locator('.composer-settings-trigger').first().click()
    await page.locator('.composer-settings-menu').first().waitFor()
    const result = await readComputedRgb(page.locator('.reasoning-select').first(), 'background-color')
    await page.keyboard.press('Escape')
    return result
  }

  const readAddWorkspaceButtonBackground = async () =>
    readComputedValue(page.locator('.app-topbar-add-column'), 'background-color')

  const readAddWorkspaceButtonRect = async () =>
    readRect(page.locator('.app-topbar-add-column'))

  const ambienceTab = page.getByRole('tab', { name: /Chill Vibe/ })
  const routingTab = page.getByRole('tab', { name: /路由|接口|Routing/ })
  const settingsTab = page.getByRole('tab', { name: /设置|Settings/ })

  const appTopbar = page.locator('.app-topbar-frame')
  const appTopbarShell = page.locator('.app-topbar')

  const expectTopbarToStayPinned = async (themeLabel: string) => {
    const viewportSize = page.viewportSize()
    if (!viewportSize) {
      throw new Error('Expected Playwright to provide a viewport size')
    }

    const compactHeight = Math.min(viewportSize.height, 560)
    if (compactHeight !== viewportSize.height) {
      await page.setViewportSize({ width: viewportSize.width, height: compactHeight })
    }

    const initialRect = await readRect(appTopbarShell)

    const readScrollHostMetrics = () => page.evaluate(() => {
      const overflowScrollablePattern = /(auto|scroll|overlay)/
      const appShell = document.querySelector('.app-shell')
      const messageList = document.querySelector('.message-list')
      let host: HTMLElement =
        document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement
      let hostLabel = 'document'

      if (appShell instanceof HTMLElement) {
        const style = getComputedStyle(appShell)
        if (overflowScrollablePattern.test(style.overflowY) && appShell.scrollHeight > appShell.clientHeight + 1) {
          host = appShell
          hostLabel = 'app-shell'
        }
      }

      if (hostLabel === 'document' && messageList instanceof HTMLElement && messageList.scrollHeight > messageList.clientHeight + 1) {
        host = messageList
        hostLabel = 'message-list'
      }

      return {
        hostLabel,
        maxScrollTop: Math.max(host.scrollHeight - host.clientHeight, 0),
        scrollTop: host.scrollTop,
      }
    })

    const { hostLabel, maxScrollTop } = await readScrollHostMetrics()
    if (maxScrollTop <= 0) {
      const pinnedRect = await readRect(appTopbarShell)
      expect(Math.abs(pinnedRect.top), `Expected the topbar to stay pinned in ${themeLabel} theme (found ${hostLabel})`).toBeLessThanOrEqual(1)
      expect(Math.abs(pinnedRect.top - initialRect.top)).toBeLessThanOrEqual(1)

      if (compactHeight !== viewportSize.height) {
        await page.setViewportSize(viewportSize)
      }

      return
    }

    await page.evaluate(() => {
      const overflowScrollablePattern = /(auto|scroll|overlay)/
      const appShell = document.querySelector('.app-shell')
      const messageList = document.querySelector('.message-list')
      let host: HTMLElement =
        document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement

      if (appShell instanceof HTMLElement) {
        const style = getComputedStyle(appShell)
        if (overflowScrollablePattern.test(style.overflowY) && appShell.scrollHeight > appShell.clientHeight + 1) {
          host = appShell
        }
      }

      if (messageList instanceof HTMLElement && messageList.scrollHeight > messageList.clientHeight + 1 && host === document.documentElement) {
        host = messageList
      }

      host.scrollTop = Math.min(Math.max(host.scrollHeight - host.clientHeight, 0), 320)
    })

    await expect.poll(async () => (await readScrollHostMetrics()).scrollTop).toBeGreaterThan(0)

    const pinnedRect = await readRect(appTopbarShell)
    expect(Math.abs(pinnedRect.top)).toBeLessThanOrEqual(1)
    expect(Math.abs(pinnedRect.top - initialRect.top)).toBeLessThanOrEqual(1)

    await page.evaluate(() => {
      const overflowScrollablePattern = /(auto|scroll|overlay)/
      const appShell = document.querySelector('.app-shell')
      const messageList = document.querySelector('.message-list')
      let host: HTMLElement =
        document.scrollingElement instanceof HTMLElement ? document.scrollingElement : document.documentElement

      if (appShell instanceof HTMLElement) {
        const style = getComputedStyle(appShell)
        if (overflowScrollablePattern.test(style.overflowY) && appShell.scrollHeight > appShell.clientHeight + 1) {
          host = appShell
        }
      }

      if (messageList instanceof HTMLElement && messageList.scrollHeight > messageList.clientHeight + 1 && host === document.documentElement) {
        host = messageList
      }

      host.scrollTop = 0
    })
    await expect.poll(async () => (await readScrollHostMetrics()).scrollTop).toBe(0)

    if (compactHeight !== viewportSize.height) {
      await page.setViewportSize(viewportSize)
    }
  }

  await expect(page.locator('.model-select-shell .model-option-icon').first()).toBeVisible()
  await expect(ambienceTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#app-panel-ambience')).toBeVisible()
  await expect(page.locator('#app-panel-routing')).toBeHidden()
  await expect(page.locator('#app-panel-settings')).toBeHidden()

  const darkEmptyBackground = await readComputedRgb(page.locator('#fixture-empty-card'), 'background-color')
  const darkEmptyActiveBackground = await readComputedRgb(page.locator('#fixture-empty-card-active'), 'background-color')
  const darkEmptyTitle = await readComputedRgb(page.locator('#fixture-empty-title'), 'color')
  const darkEmptyCopy = await readComputedRgb(page.locator('#fixture-empty-copy'), 'color')
  const darkLaneDropBackground = await readComputedRgb(page.locator('#fixture-lane-drop-zone'), 'background-color')
  const darkLaneDropBorder = await readComputedRgb(page.locator('#fixture-lane-drop-zone'), 'border-top-color')
  const darkSlashMenuBackground = await readComputedRgb(page.locator('#fixture-slash-menu'), 'background-color')
  const darkControlTitleBackground = await readComputedRgb(page.locator('#fixture-control-title'), 'background-color')
  const darkMessageAttachmentBackgroundImage = await readComputedValue(
    page.locator('#fixture-message-attachment'),
    'background-image',
  )
  const darkComposerAttachmentBackground = await readComputedRgb(
    page.locator('#fixture-composer-attachment'),
    'background-color',
  )
  const darkComposerNoteBackground = await readComputedRgb(page.locator('#fixture-composer-note'), 'background-color')
  const darkAddWorkspaceButtonBackground = await readAddWorkspaceButtonBackground()
  const darkAddWorkspaceButtonRect = await readAddWorkspaceButtonRect()

  const darkCardBackgroundValue = await readCardBackgroundValue()
  const darkCardBackgroundImage = await readCardBackgroundImage()
  const darkCardHeaderBackground = await readCardHeaderBackground()
  await cardHeader.hover()
  await expect.poll(() => cardHeader.evaluate((node) => node.matches(':hover'))).toBeTruthy()
  await expect.poll(async () => isTransparentColor(await readCardHeaderBackgroundValue())).toBeFalsy()
  const darkCardHeaderHoverBackground = await readCardHeaderBackground()
  await page.locator('body').hover()
  const darkPageBackground = await readPageBackground()
  const darkPageBackgroundImage = await readPageBackgroundImage()
  const darkPrimaryButtonBackgroundImage = await readPrimaryButtonBackgroundImage()
  const darkSelectBackground = await readSelectBackground()
  const darkReasoningBackground = await readReasoningBackground()
  const darkModelIconColor = await readComputedRgb(
    page.locator('.model-select-shell .model-option-icon').first(),
    'color',
  )
  const darkTopbarBackground = await readComputedRgb(appTopbar, 'background-color')
  const darkInactiveTabBackground = await readComputedRgb(routingTab, 'background-color')
  const darkActiveTabBackground = await readComputedRgb(ambienceTab, 'background-color')
  const darkTopbarRect = await readRect(appTopbar)

  expect(isTransparentColor(darkCardBackgroundValue)).toBeTruthy()
  expect(darkCardBackgroundImage).toBe('none')
  expect(maxChannel(darkCardHeaderBackground)).toBeLessThan(90)
  expect(maxChannel(darkPageBackground)).toBeLessThan(80)
  expect(darkPageBackgroundImage).toBe('none')
  expect(darkPrimaryButtonBackgroundImage).toBe('none')
  expect(maxChannel(darkSelectBackground)).toBeLessThan(80)
  expect(maxChannel(darkReasoningBackground)).toBeLessThan(80)
  expect(maxChannel(darkEmptyBackground)).toBeLessThan(80)
  expect(isTransparentColor(darkAddWorkspaceButtonBackground)).toBeTruthy()
  expect(maxChannel(darkSlashMenuBackground)).toBeLessThan(80)
  expect(maxChannel(darkControlTitleBackground)).toBeLessThan(80)
  expect(darkMessageAttachmentBackgroundImage).not.toBe('none')
  expect(maxChannel(darkComposerAttachmentBackground)).toBeLessThan(80)
  expect(maxChannel(darkComposerNoteBackground)).toBeLessThan(80)
  expect(maxChannel(darkTopbarBackground)).toBeLessThan(80)
  expect(maxChannel(darkInactiveTabBackground)).toBeLessThan(80)
  expect(darkAddWorkspaceButtonRect.height).toBeLessThan(80)
  expect(Math.abs(darkAddWorkspaceButtonRect.width - darkAddWorkspaceButtonRect.height)).toBeLessThan(6)
  expect(lacksGreenCast(darkPageBackground)).toBeTruthy()
  expect(lacksGreenCast(darkSelectBackground)).toBeTruthy()
  expect(lacksGreenCast(darkReasoningBackground)).toBeTruthy()
  expect(lacksGreenCast(darkEmptyBackground)).toBeTruthy()
  expect(lacksGreenCast(darkSlashMenuBackground)).toBeTruthy()
  expect(lacksGreenCast(darkControlTitleBackground)).toBeTruthy()
  expect(lacksGreenCast(darkComposerAttachmentBackground)).toBeTruthy()
  expect(lacksGreenCast(darkComposerNoteBackground)).toBeTruthy()
  expect(lacksGreenCast(darkModelIconColor)).toBeTruthy()
  expect(lacksGreenCast(darkTopbarBackground)).toBeTruthy()
  expect(lacksGreenCast(darkInactiveTabBackground)).toBeTruthy()
  expect(isTransparentColor(await readCardHeaderBackgroundValue())).toBeFalsy()
  expect(maxChannel(darkCardHeaderBackground)).toBeLessThan(90)
  expect(darkCardHeaderHoverBackground).toEqual(darkCardHeaderBackground)
  expect(maxChannel(darkEmptyTitle)).toBeGreaterThan(maxChannel(darkEmptyCopy))
  expect(isBlueTint(darkEmptyActiveBackground)).toBeTruthy()
  expect(isBlueTint(darkLaneDropBackground)).toBeTruthy()
  expect(darkActiveTabBackground).toEqual(darkTopbarBackground)
  expect(maxChannel(darkLaneDropBorder)).toBeGreaterThan(150)
  expect(darkTopbarRect.height).toBeGreaterThanOrEqual(34)
  expect(darkTopbarRect.height).toBeLessThanOrEqual(42)
  expect(await readComputedValue(appTopbarShell, 'position')).toBe('sticky')
  await expectTopbarToStayPinned('dark')
  await expect(appTopbar).toHaveScreenshot('app-titlebar-dark.png', {
    animations: 'disabled',
  })

  const slashMenuPosition = await readComputedValue(page.locator('#fixture-slash-menu'), 'position')
  expect(slashMenuPosition).toBe('absolute')
  const slashMenuOverflowY = await readComputedValue(page.locator('#fixture-slash-menu'), 'overflow-y')
  expect(slashMenuOverflowY).toBe('auto')
  const slashMenuMaxHeight = await readComputedValue(page.locator('#fixture-slash-menu'), 'max-height')
  expect(slashMenuMaxHeight).not.toBe('none')

  await settingsTab.click()
  await expect(settingsTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#app-panel-ambience')).toBeHidden()
  await expect(page.locator('#app-panel-routing')).toBeHidden()
  await expect(page.locator('#app-panel-settings')).toBeVisible()
  await expect(page.locator('#line-height-range')).toHaveAttribute('min', `${minLineHeightScale}`)
  const scopedDarkThemeButton = page.locator('#app-panel-settings').getByRole('button', {
    name: /\u6df1\u8272|Dark/,
  })
  const scopedLightThemeButton = page.locator('#app-panel-settings').getByRole('button', {
    name: /\u6d45\u8272|Light/,
  })
  const scopedDarkProxyToggleTrack = page.locator('#app-panel-routing .toggle-switch-track').first()
  const darkActiveThemeChipBackgroundImage = await readComputedValue(
    scopedDarkThemeButton,
    'background-image',
  )
  let darkProxyEnabledBackgroundImage = 'none'
  const darkLanguageSelectBackground = await readComputedRgb(
    page.locator('#language-select'),
    'background-color',
  )
  await expect(page.locator('.settings-field-icon')).toHaveCount(4)
  const darkSettingsModelIconColor = await readComputedRgb(page.locator('.settings-field-icon').first(), 'color')
  expect(darkActiveThemeChipBackgroundImage).toBe('none')
  expect(darkProxyEnabledBackgroundImage).toBe('none')
  expect(maxChannel(darkLanguageSelectBackground)).toBeLessThan(80)
  expect(lacksGreenCast(darkLanguageSelectBackground)).toBeTruthy()
  expect(lacksGreenCast(darkSettingsModelIconColor)).toBeTruthy()
  await routingTab.click()
  await expect(routingTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#app-panel-ambience')).toBeHidden()
  await expect(page.locator('#app-panel-routing')).toBeVisible()
  await expect(page.locator('#app-panel-settings')).toBeHidden()
  await expect(scopedDarkProxyToggleTrack).toBeVisible()
  darkProxyEnabledBackgroundImage = await readComputedValue(
    scopedDarkProxyToggleTrack,
    'background-image',
  )
  expect(darkProxyEnabledBackgroundImage).toBe('none')
  const darkSwitchPanelBackground = await readComputedRgb(page.locator('.switch-panel'), 'background-color')
  const darkSwitchProfileBackground = await readComputedRgb(
    page.locator('.provider-profile-card').first(),
    'background-color',
  )
  expect(maxChannel(darkSwitchPanelBackground)).toBeLessThan(80)
  expect(maxChannel(darkSwitchProfileBackground)).toBeLessThan(80)
  expect(lacksGreenCast(darkSwitchPanelBackground)).toBeTruthy()
  expect(lacksGreenCast(darkSwitchProfileBackground)).toBeTruthy()
  await settingsTab.click()
  await scopedLightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(async () => isTransparentColor(await readCardHeaderBackgroundValue())).toBeFalsy()
  const lightActiveThemeChipBackgroundImage = await readComputedValue(
    scopedLightThemeButton,
    'background-image',
  )
  let lightProxyEnabledBackgroundImage = 'none'
  await expect
    .poll(async () => maxChannel(await readComputedRgb(page.locator('#language-select'), 'background-color')))
    .toBeGreaterThan(180)
  const lightLanguageSelectBackground = await readComputedRgb(
    page.locator('#language-select'),
    'background-color',
  )
  await ambienceTab.click()
  await expect(ambienceTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#app-panel-ambience')).toBeVisible()
  await expect(page.locator('#app-panel-routing')).toBeHidden()
  await expect(page.locator('#app-panel-settings')).toBeHidden()

  const lightCardBackgroundValue = await readCardBackgroundValue()
  const lightCardBackgroundImage = await readCardBackgroundImage()
  const lightCardHeaderBackground = await readCardHeaderBackground()
  await cardHeader.hover()
  await expect.poll(() => cardHeader.evaluate((node) => node.matches(':hover'))).toBeTruthy()
  await expect.poll(async () => isTransparentColor(await readCardHeaderBackgroundValue())).toBeFalsy()
  const lightCardHeaderHoverBackground = await readCardHeaderBackground()
  await page.locator('body').hover()
  const lightPageBackground = await readPageBackground()
  const lightPageBackgroundImage = await readPageBackgroundImage()
  const lightPrimaryButtonBackgroundImage = await readPrimaryButtonBackgroundImage()
  const lightSelectBackground = await readSelectBackground()
  const lightReasoningBackground = await readReasoningBackground()
  const lightEmptyBackground = await readComputedRgb(page.locator('#fixture-empty-card'), 'background-color')
  const lightEmptyActiveBackground = await readComputedRgb(page.locator('#fixture-empty-card-active'), 'background-color')
  const lightSlashMenuBackground = await readComputedRgb(page.locator('#fixture-slash-menu'), 'background-color')
  const lightControlTitleBackground = await readComputedRgb(page.locator('#fixture-control-title'), 'background-color')
  const lightMessageAttachmentBackgroundImage = await readComputedValue(
    page.locator('#fixture-message-attachment'),
    'background-image',
  )
  const lightComposerAttachmentBackground = await readComputedRgb(
    page.locator('#fixture-composer-attachment'),
    'background-color',
  )
  const lightComposerNoteBackground = await readComputedRgb(page.locator('#fixture-composer-note'), 'background-color')
  const lightAddWorkspaceButtonBackground = await readAddWorkspaceButtonBackground()
  const lightAddWorkspaceButtonRect = await readAddWorkspaceButtonRect()
  const lightTopbarBackground = await readComputedRgb(appTopbar, 'background-color')
  const lightInactiveTabBackground = await readComputedRgb(routingTab, 'background-color')
  const lightActiveTabBackground = await readComputedRgb(ambienceTab, 'background-color')
  const lightTopbarRect = await readRect(appTopbar)
  await expect(page.locator('#line-height-range')).toHaveAttribute('min', `${minLineHeightScale}`)
  await ambienceTab.click()
  await expect(ambienceTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#app-panel-ambience')).toBeVisible()
  await expect(page.locator('#app-panel-routing')).toBeHidden()
  await expect(page.locator('#app-panel-settings')).toBeHidden()

  expect(isTransparentColor(lightCardBackgroundValue)).toBeTruthy()
  expect(lightCardBackgroundImage).toBe('none')
  expect(maxChannel(lightCardHeaderBackground)).toBeGreaterThan(180)
  expect(maxChannel(lightPageBackground)).toBeGreaterThan(200)
  expect(lightPageBackgroundImage).toBe('none')
  expect(lightPrimaryButtonBackgroundImage).toBe('none')
  expect(lightActiveThemeChipBackgroundImage).toBe('none')
  expect(lightProxyEnabledBackgroundImage).toBe('none')
  expect(maxChannel(lightSelectBackground)).toBeGreaterThan(200)
  expect(maxChannel(lightReasoningBackground)).toBeGreaterThan(200)
  expect(maxChannel(lightLanguageSelectBackground)).toBeGreaterThan(180)
  expect(maxChannel(lightEmptyBackground)).toBeGreaterThan(200)
  expect(isTransparentColor(lightAddWorkspaceButtonBackground)).toBeTruthy()
  expect(maxChannel(lightSlashMenuBackground)).toBeGreaterThan(200)
  expect(maxChannel(lightControlTitleBackground)).toBeGreaterThan(180)
  expect(lightMessageAttachmentBackgroundImage).not.toBe('none')
  expect(maxChannel(lightComposerAttachmentBackground)).toBeGreaterThan(180)
  expect(maxChannel(lightComposerNoteBackground)).toBeGreaterThan(180)
  expect(maxChannel(lightTopbarBackground)).toBeGreaterThan(180)
  expect(maxChannel(lightInactiveTabBackground)).toBeGreaterThan(180)
  expect(lightTopbarRect.height).toBeGreaterThanOrEqual(34)
  expect(lightTopbarRect.height).toBeLessThanOrEqual(42)
  expect(await readComputedValue(appTopbarShell, 'position')).toBe('sticky')
  await expectTopbarToStayPinned('light')
  expect(lightAddWorkspaceButtonRect.height).toBeLessThan(80)
  expect(Math.abs(lightAddWorkspaceButtonRect.width - lightAddWorkspaceButtonRect.height)).toBeLessThan(6)
  expect(isTransparentColor(await readCardHeaderBackgroundValue())).toBeFalsy()
  expect(maxChannel(lightCardHeaderBackground)).toBeGreaterThan(180)
  expect(lightCardHeaderHoverBackground).toEqual(lightCardHeaderBackground)
  expect(isBlueTint(lightEmptyActiveBackground)).toBeTruthy()
  expect(lightActiveTabBackground).toEqual(lightTopbarBackground)
  await expect(appTopbar).toHaveScreenshot('app-titlebar-light.png', {
    animations: 'disabled',
  })

  await routingTab.click()
  await expect(page.locator('#app-panel-ambience')).toBeHidden()
  await expect(page.locator('#app-panel-routing')).toBeVisible()
  await expect(page.locator('#app-panel-settings')).toBeHidden()
  await expect(scopedDarkProxyToggleTrack).toBeVisible()
  lightProxyEnabledBackgroundImage = await readComputedValue(
    scopedDarkProxyToggleTrack,
    'background-image',
  )
  expect(lightProxyEnabledBackgroundImage).toBe('none')
  const lightSwitchPanelBackground = await readComputedRgb(page.locator('.switch-panel'), 'background-color')
  const lightSwitchProfileBackground = await readComputedRgb(
    page.locator('.provider-profile-card').first(),
    'background-color',
  )
  expect(maxChannel(lightSwitchPanelBackground)).toBeLessThan(10)
  expect(maxChannel(lightSwitchProfileBackground)).toBeGreaterThan(180)
  await settingsTab.click()

  await scopedDarkThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(async () => maxChannel(await readCardHeaderBackground())).toBeLessThan(90)
  await ambienceTab.click()
  await expect(ambienceTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#app-panel-ambience')).toBeVisible()
  await expect(page.locator('#app-panel-routing')).toBeHidden()
  await expect(page.locator('#app-panel-settings')).toBeHidden()

  const restoredCardBackgroundValue = await readCardBackgroundValue()
  const restoredCardBackgroundImage = await readCardBackgroundImage()
  const restoredCardHeaderBackground = await readCardHeaderBackground()
  const restoredPageBackground = await readPageBackground()
  const restoredPageBackgroundImage = await readPageBackgroundImage()
  const restoredPrimaryButtonBackgroundImage = await readPrimaryButtonBackgroundImage()
  const restoredSelectBackground = await readSelectBackground()
  const restoredReasoningBackground = await readReasoningBackground()
  const restoredLanguageSelectBackground = await readComputedRgb(
    page.locator('#language-select'),
    'background-color',
  )
  const restoredModelIconColor = await readComputedRgb(
    page.locator('.model-select-shell .model-option-icon').first(),
    'color',
  )
  const restoredEmptyBackground = await readComputedRgb(page.locator('#fixture-empty-card'), 'background-color')
  const restoredSlashMenuBackground = await readComputedRgb(page.locator('#fixture-slash-menu'), 'background-color')
  const restoredMessageAttachmentBackgroundImage = await readComputedValue(
    page.locator('#fixture-message-attachment'),
    'background-image',
  )
  const restoredComposerAttachmentBackground = await readComputedRgb(
    page.locator('#fixture-composer-attachment'),
    'background-color',
  )
  const restoredComposerNoteBackground = await readComputedRgb(
    page.locator('#fixture-composer-note'),
    'background-color',
  )
  const restoredAddWorkspaceButtonBackground = await readAddWorkspaceButtonBackground()
  const restoredAddWorkspaceButtonRect = await readAddWorkspaceButtonRect()
  const restoredTopbarBackground = await readComputedRgb(appTopbar, 'background-color')
  const restoredInactiveTabBackground = await readComputedRgb(routingTab, 'background-color')
  const restoredActiveTabBackground = await readComputedRgb(ambienceTab, 'background-color')

  expect(isTransparentColor(restoredCardBackgroundValue)).toBeTruthy()
  expect(restoredCardBackgroundImage).toBe('none')
  expect(maxChannel(restoredCardHeaderBackground)).toBeLessThan(90)
  expect(maxChannel(restoredPageBackground)).toBeLessThan(80)
  expect(restoredPageBackgroundImage).toBe('none')
  expect(restoredPrimaryButtonBackgroundImage).toBe('none')
  expect(maxChannel(restoredSelectBackground)).toBeLessThan(80)
  expect(maxChannel(restoredReasoningBackground)).toBeLessThan(80)
  expect(maxChannel(restoredLanguageSelectBackground)).toBeLessThan(80)
  expect(maxChannel(restoredEmptyBackground)).toBeLessThan(80)
  expect(isTransparentColor(restoredAddWorkspaceButtonBackground)).toBeTruthy()
  expect(maxChannel(restoredSlashMenuBackground)).toBeLessThan(80)
  expect(restoredMessageAttachmentBackgroundImage).not.toBe('none')
  expect(maxChannel(restoredComposerAttachmentBackground)).toBeLessThan(80)
  expect(maxChannel(restoredComposerNoteBackground)).toBeLessThan(80)
  expect(maxChannel(restoredTopbarBackground)).toBeLessThan(80)
  expect(maxChannel(restoredInactiveTabBackground)).toBeLessThan(80)
  expect(restoredAddWorkspaceButtonRect.height).toBeLessThan(80)
  expect(Math.abs(restoredAddWorkspaceButtonRect.width - restoredAddWorkspaceButtonRect.height)).toBeLessThan(6)
  expect(lacksGreenCast(restoredPageBackground)).toBeTruthy()
  expect(lacksGreenCast(restoredSelectBackground)).toBeTruthy()
  expect(lacksGreenCast(restoredReasoningBackground)).toBeTruthy()
  expect(lacksGreenCast(restoredLanguageSelectBackground)).toBeTruthy()
  expect(lacksGreenCast(restoredEmptyBackground)).toBeTruthy()
  expect(lacksGreenCast(restoredSlashMenuBackground)).toBeTruthy()
  expect(lacksGreenCast(restoredComposerAttachmentBackground)).toBeTruthy()
  expect(lacksGreenCast(restoredComposerNoteBackground)).toBeTruthy()
  expect(lacksGreenCast(restoredModelIconColor)).toBeTruthy()
  expect(lacksGreenCast(restoredTopbarBackground)).toBeTruthy()
  expect(lacksGreenCast(restoredInactiveTabBackground)).toBeTruthy()
  expect(isTransparentColor(await readCardHeaderBackgroundValue())).toBeFalsy()
  expect(maxChannel(restoredCardHeaderBackground)).toBeLessThan(90)
  expect(restoredActiveTabBackground).toEqual(restoredTopbarBackground)

  await routingTab.click()
  await expect(page.locator('#app-panel-ambience')).toBeHidden()
  await expect(page.locator('#app-panel-routing')).toBeVisible()
  await expect(page.locator('#app-panel-settings')).toBeHidden()
  const restoredSwitchPanelBackground = await readComputedRgb(
    page.locator('.switch-panel'),
    'background-color',
  )
  const restoredSwitchProfileBackground = await readComputedRgb(
    page.locator('.provider-profile-card').first(),
    'background-color',
  )
  expect(maxChannel(restoredSwitchPanelBackground)).toBeLessThan(80)
  expect(maxChannel(restoredSwitchProfileBackground)).toBeLessThan(80)
  expect(lacksGreenCast(restoredSwitchPanelBackground)).toBeTruthy()
  expect(lacksGreenCast(restoredSwitchProfileBackground)).toBeTruthy()

  await page.waitForTimeout(200)
})

test('add workspace button keeps its icon aligned with the chrome tone in both themes', async ({ page }) => {
  await mockAppApis(page)
  await page.goto(appUrl)

  const addWorkspaceButton = page.locator('.app-topbar-add-column')
  await addWorkspaceButton.waitFor()

  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((nextTheme) => {
      document.documentElement.setAttribute('data-theme', nextTheme)
    }, theme)

    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expectAddLaneIconToMatchBorder(addWorkspaceButton)
    await expect(addWorkspaceButton).toHaveScreenshot(`app-topbar-add-column-${theme}.png`, {
      animations: 'disabled',
    })

    await addWorkspaceButton.hover()
    await expect.poll(() => addWorkspaceButton.evaluate((node) => node.matches(':hover'))).toBeTruthy()
    await expectAddLaneIconToMatchBorder(addWorkspaceButton)
    await page.locator('body').hover()
  }
})

test('proxy stats panel keeps the filter row readable in both themes', async ({ page }) => {
  await mockAppApis(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(appUrl)

  const routingTab = page.getByRole('tab', { name: /\u8def\u7531|\u63a5\u53e3|Routing/ })
  const settingsTab = page.getByRole('tab', { name: /\u8bbe\u7f6e|Settings/ })
  const proxyTab = page.getByRole('button', { name: /\u81ea\u52a8\u7eed\u4f20|\u65ad\u7ebf\u7eed\u4f20|Auto-retry/ })
  const lightThemeButton = page.getByRole('button', { name: /\u6d45\u8272|Light/ })
  const proxyStatsSection = page.locator('#app-panel-routing .settings-section').filter({
    has: page.locator('.proxy-stats-filter'),
  }).first()

  await routingTab.click()
  await proxyTab.click()
  await expect(proxyStatsSection).toHaveScreenshot('proxy-stats-panel-dark.png', {
    animations: 'disabled',
  })

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await routingTab.click()
  await proxyTab.click()
  await expect(proxyStatsSection).toHaveScreenshot('proxy-stats-panel-light.png', {
    animations: 'disabled',
  })
})

test('routing providers panel keeps the same card rhythm in both themes', async ({ page }) => {
  await mockAppApis(page)
  await page.setViewportSize({ width: 1280, height: 1400 })
  await page.goto(appUrl)

  const routingTab = page.getByRole('tab', { name: /\u8def\u7531|\u63a5\u53e3|Routing/ })
  const settingsTab = page.getByRole('tab', { name: /\u8bbe\u7f6e|Settings/ })
  const lightThemeButton = page.getByRole('button', { name: /\u6d45\u8272|Light/ })
  const routingPanel = page.locator('#app-panel-routing .switch-panel')

  await routingTab.click()
  await expect(routingPanel).toHaveScreenshot('routing-panel-providers-dark.png', {
    animations: 'disabled',
  })

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await routingTab.click()
  await expect(routingPanel).toHaveScreenshot('routing-panel-providers-light.png', {
    animations: 'disabled',
  })
})

test('routing proxy panel keeps the same card rhythm in both themes', async ({ page }) => {
  await mockAppApis(page)
  await page.setViewportSize({ width: 1280, height: 1200 })
  await page.goto(appUrl)

  const routingTab = page.getByRole('tab', { name: /\u8def\u7531|\u63a5\u53e3|Routing/ })
  const settingsTab = page.getByRole('tab', { name: /\u8bbe\u7f6e|Settings/ })
  const proxyTab = page.getByRole('button', { name: /\u81ea\u52a8\u7eed\u4f20|\u65ad\u7ebf\u7eed\u4f20|Auto-retry/ })
  const lightThemeButton = page.getByRole('button', { name: /\u6d45\u8272|Light/ })
  const routingPanel = page.locator('#app-panel-routing .switch-panel')

  await routingTab.click()
  await proxyTab.click()
  await expect(routingPanel).toHaveScreenshot('routing-panel-proxy-dark.png', {
    animations: 'disabled',
  })

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await routingTab.click()
  await proxyTab.click()
  await expect(routingPanel).toHaveScreenshot('routing-panel-proxy-light.png', {
    animations: 'disabled',
  })
})

test('language setting updates the interface copy in both themes', async ({ page }) => {
  await mockAppApis(page)
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()
  const settingsPanel = page.locator('#app-panel-settings')
  const languageSelect = settingsPanel.locator('#language-select')

  await page.locator('#app-tab-settings').click()
  await expect(settingsPanel).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect
    .poll(async () =>
      languageSelect.evaluate((node) =>
        Array.from((node as HTMLSelectElement).options).map((option) => option.text.trim()),
      ),
    )
    .toEqual(['\u{1F1E8}\u{1F1F3} \u4E2D\u6587', '\u{1F1FA}\u{1F1F8} English'])
  await expect.poll(() => languageSelect.inputValue()).toBe('zh-CN')
  await expect(page.getByRole('heading', { name: '\u754C\u9762\u548C\u8BF7\u6C42\u8BBE\u7F6E' })).toBeVisible()

  await languageSelect.selectOption('en')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: 'Interface and request settings' })).toBeVisible()
  await page
    .locator('#app-panel-settings .theme-chip')
    .first()
    .evaluate((node) => (node as HTMLButtonElement).click())
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await page.locator('#app-tab-settings').click()
  await expect(settingsPanel).toBeVisible()
  await languageSelect.selectOption('zh-CN')
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await page.locator('#app-tab-settings').click()
  await expect(settingsPanel).toBeVisible()
  await expect(settingsPanel).toContainText('\u754C\u9762\u548C\u8BF7\u6C42\u8BBE\u7F6E')
  await expect(settingsPanel).toContainText('\u6D45\u8272')
  await expect(settingsPanel).toContainText('\u6DF1\u8272')
})

test('card type settings group keeps tool toggles readable in both themes', async ({ page }) => {
  await mockAppApis(page)
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()

  const settingsTab = page.getByRole('tab', { name: /设置|Settings/ })
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()
  const cardTypeSettingsGroup = page
    .locator('#app-panel-settings .settings-group')
    .filter({ hasText: /卡片类型|Card Type/ })
    .first()

  await settingsTab.click()
  await expect(page.locator('#app-panel-settings')).toBeVisible()
  await expect(cardTypeSettingsGroup).toContainText(/网易云音乐|NetEase Music/)
  await expect(cardTypeSettingsGroup).toContainText(/Git/)
  await expect(cardTypeSettingsGroup).toContainText(/Files|\u6587\u4ef6/)
  await expect(cardTypeSettingsGroup).toContainText(/Sticky Note|\u4fbf\u7b7e/)
  await expect(cardTypeSettingsGroup).toContainText(/Weather|\u5929\u6c14/)
  await expect(cardTypeSettingsGroup).toContainText(/White Noise|\u767d\u566a\u97f3/)
  await expect(cardTypeSettingsGroup).toHaveScreenshot('experimental-settings-group-dark.png', {
    animations: 'disabled',
  })

  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(cardTypeSettingsGroup).toContainText(/网易云音乐|NetEase Music/)
  await expect(cardTypeSettingsGroup).toContainText(/Git/)
  await expect(cardTypeSettingsGroup).toContainText(/Files|\u6587\u4ef6/)
  await expect(cardTypeSettingsGroup).toContainText(/Sticky Note|\u4fbf\u7b7e/)
  await expect(cardTypeSettingsGroup).toContainText(/Weather|\u5929\u6c14/)
  await expect(cardTypeSettingsGroup).toContainText(/White Noise|\u767d\u566a\u97f3/)
  await expect(cardTypeSettingsGroup).toHaveScreenshot('experimental-settings-group-light.png', {
    animations: 'disabled',
  })
})

test('weather city input stays directly under the weather toggle in both themes', async ({ page }) => {
  await mockAppApis(page)
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()

  const settingsTab = page.getByRole('tab', { name: /设置|Settings/ })
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()
  const cardTypeSettingsGroup = page
    .locator('#app-panel-settings .settings-group')
    .filter({ hasText: /卡片类型|Card Type/ })
    .first()
  const weatherToggle = cardTypeSettingsGroup.locator('label.settings-toggle').filter({
    hasText: /Weather|\u5929\u6c14/,
  })
  const musicToggle = cardTypeSettingsGroup.locator('label.settings-toggle').filter({
    hasText: /\u7f51\u6613\u4e91\u97f3\u4e50|NetEase Music/,
  })
  const weatherInput = cardTypeSettingsGroup.locator('#weather-city-input')

  await settingsTab.click()
  await expect(page.locator('#app-panel-settings')).toBeVisible()
  await weatherToggle.click()
  await expect(weatherInput).toBeVisible()

  const assertWeatherInputPlacement = async () => {
    const weatherBox = await weatherToggle.boundingBox()
    const inputBox = await weatherInput.boundingBox()
    const musicBox = await musicToggle.boundingBox()

    expect(weatherBox).not.toBeNull()
    expect(inputBox).not.toBeNull()
    expect(musicBox).not.toBeNull()

    expect(inputBox!.y).toBeGreaterThan(weatherBox!.y + weatherBox!.height - 1)
    expect(inputBox!.y + inputBox!.height).toBeLessThan(musicBox!.y + 1)
  }

  await assertWeatherInputPlacement()
  await expect(cardTypeSettingsGroup).toHaveScreenshot('experimental-settings-group-weather-input-dark.png', {
    animations: 'disabled',
  })

  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await assertWeatherInputPlacement()
  await expect(cardTypeSettingsGroup).toHaveScreenshot('experimental-settings-group-weather-input-light.png', {
    animations: 'disabled',
  })
})

test('environment setup group highlights only missing tools in both themes', async ({ page }) => {
  await mockAppApis(page)
  await mockMissingEnvironmentStatus(page)

  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()

  const settingsTab = page.locator('#app-tab-settings')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()
  const environmentSettingsGroup = page
    .locator('#app-panel-settings .settings-group')
    .filter({ has: page.locator('.setup-missing-list') })
    .first()

  await settingsTab.click()
  await expect(page.locator('#app-panel-settings')).toBeVisible()
  await expect(environmentSettingsGroup).toContainText(/Git/)
  await expect(environmentSettingsGroup).toContainText(/Codex CLI/)
  await expect(environmentSettingsGroup.getByRole('button', { name: /Install missing tools|\u4e00\u952e\u5b89\u88c5\u7f3a\u5931\u73af\u5883/ })).toBeVisible()
  await expect(environmentSettingsGroup).toHaveScreenshot('environment-settings-group-dark.png', {
    animations: 'disabled',
  })

  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(environmentSettingsGroup).toContainText(/Git/)
  await expect(environmentSettingsGroup).toContainText(/Codex CLI/)
  await expect(environmentSettingsGroup).toHaveScreenshot('environment-settings-group-light.png', {
    animations: 'disabled',
  })
})

test('settings panel flows category cards through two waterfall columns in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 })
  await mockAppApis(page)
  await mockMissingEnvironmentStatus(page)
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()

  const settingsTab = page.locator('#app-tab-settings')
  const settingsPanel = page.locator('#app-panel-settings .settings-panel')
  const settingsGroups = settingsPanel.locator('.settings-group')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await settingsTab.click()
  await expect(settingsPanel).toBeVisible()
  await expect(settingsGroups).toHaveCount(7)

  const settingsGroupRects = await settingsGroups.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()

      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
      }
    }),
  )

  const columnLefts = Array.from(
    new Set(settingsGroupRects.map((rect) => Math.round(rect.left / 10) * 10)),
  ).sort((a, b) => a - b)

  expect(columnLefts).toHaveLength(2)

  const columns = columnLefts.map((left) =>
    settingsGroupRects
      .filter((rect) => Math.abs(Math.round(rect.left / 10) * 10 - left) <= 1)
      .sort((a, b) => a.top - b.top),
  )

  expect(columns.every((column) => column.length > 0)).toBe(true)
  expect(columns.flat().every((rect) => rect.width > 360)).toBe(true)
  expect(columns.every((column) => column.every((rect, index) => index === 0 || rect.top > column[index - 1]!.top + 1))).toBe(true)

  await expect(settingsPanel).toHaveScreenshot('settings-panel-card-grid-dark.png', {
    animations: 'disabled',
  })

  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(settingsPanel).toHaveScreenshot('settings-panel-card-grid-light.png', {
    animations: 'disabled',
  })
})

test('settings panel stacks category cards cleanly on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockAppApis(page)
  await mockMissingEnvironmentStatus(page)
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()

  const settingsTab = page.locator('#app-tab-settings')
  const settingsPanel = page.locator('#app-panel-settings .settings-panel')
  const settingsGroups = settingsPanel.locator('.settings-group')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await settingsTab.click()
  await expect(settingsPanel).toBeVisible()
  await expect(settingsGroups).toHaveCount(7)

  const [firstGroupRect, secondGroupRect] = await Promise.all([
    readRect(settingsGroups.nth(0)),
    readRect(settingsGroups.nth(1)),
  ])

  expect(Math.abs(firstGroupRect.left - secondGroupRect.left)).toBeLessThan(2)
  expect(secondGroupRect.top).toBeGreaterThan(firstGroupRect.bottom - 1)

  await expect(settingsPanel).toHaveScreenshot('settings-panel-card-stack-dark.png', {
    animations: 'disabled',
  })

  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(settingsPanel).toHaveScreenshot('settings-panel-card-stack-light.png', {
    animations: 'disabled',
  })
})

test('clear user data dialog stays legible across themes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 960 })
  await mockAppApis(page)
  await mockMissingEnvironmentStatus(page)
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()

  const settingsTab = page.locator('#app-tab-settings')
  const settingsPanel = page.locator('#app-panel-settings .settings-panel')
  const dangerButton = page.getByRole('button', { name: /清理用户数据|Clear User Data/ })
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await settingsTab.click()
  await expect(settingsPanel).toBeVisible()

  await dangerButton.click()
  const darkDialog = page.getByRole('dialog', { name: /清理用户数据？|Clear User Data\?/ })
  await expect(darkDialog).toBeVisible()
  await expect(darkDialog.locator('.settings-danger-card')).toHaveScreenshot('clear-user-data-dialog-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await darkDialog.locator('.settings-danger-actions').getByRole('button', { name: /取消|Cancel/ }).click()
  await expect(darkDialog).toBeHidden()

  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await dangerButton.click()

  const lightDialog = page.getByRole('dialog', { name: /清理用户数据？|Clear User Data\?/ })
  await expect(lightDialog).toBeVisible()
  await expect(lightDialog.locator('.settings-danger-card')).toHaveScreenshot('clear-user-data-dialog-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('column header actions stay minimal while pane chat chrome keeps destructive controls in tabs', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 })
  await mockAppApis(page)
  await page.goto(appUrl)
  await page.locator('.workspace-column').first().waitFor()

  const columnActionButtons = page.locator('.column-actions .icon-button')
  await expect(columnActionButtons).toHaveCount(2)

  const historyButton = columnActionButtons.nth(0)
  const deleteColumnButton = columnActionButtons.nth(1)
  const copyColumnButton = page.locator('.column-actions [aria-label="Copy column"]')
  const addChatButton = page.locator('.column-actions [aria-label="Add chat"]')
  const paneView = page.locator('.pane-view').first()
  const composerModelSelect = paneView.locator('.composer-input-row .model-select-shell').first()
  const deleteCardButtons = page.locator('.card-close-button')
  const paneTabCloseButton = page.locator('.pane-tab-close').first()
  const columnActions = page.locator('.column-actions').first()
  const columnTitleRow = page.locator('.column-title-row').first()
  const ambienceTab = page.locator('.app-tab').nth(0)
  const settingsTab = page.locator('.app-tab').nth(2)
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()
  const darkThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').nth(1)

  const expectMinimalColumnActionChrome = async () => {
    await page.mouse.move(4, 4)

    await expect
      .poll(async () => ({
        historyBackground: await readComputedValue(historyButton, 'background-color'),
        historyBorder: await readComputedValue(historyButton, 'border-top-color'),
        historyShadow: await readComputedValue(historyButton, 'box-shadow'),
        columnColor: await readComputedValue(deleteColumnButton, 'color'),
        columnBackground: await readComputedValue(deleteColumnButton, 'background-color'),
        columnBorder: await readComputedValue(deleteColumnButton, 'border-top-color'),
        columnShadow: await readComputedValue(deleteColumnButton, 'box-shadow'),
        columnOpacity: Number(await readComputedValue(deleteColumnButton, 'opacity')),
      }))
      .toMatchObject({
        historyBackground: 'rgba(0, 0, 0, 0)',
        historyBorder: 'rgba(0, 0, 0, 0)',
        historyShadow: 'none',
        columnBackground: 'rgba(0, 0, 0, 0)',
        columnBorder: 'rgba(0, 0, 0, 0)',
        columnShadow: 'none',
      })

    await expect(columnActionButtons).toHaveCount(2)
    await expect(copyColumnButton).toHaveCount(0)
    await expect(addChatButton).toHaveCount(0)
    await expect.poll(async () => Number(await readComputedValue(historyButton, 'opacity'))).toBeGreaterThan(0.95)
    await expect.poll(async () => Number(await readComputedValue(deleteColumnButton, 'opacity'))).toBeGreaterThan(0.95)
  }

  const expectQuietColumnActionHover = async (button: Locator) => {
    await button.hover()

    await expect
      .poll(async () => ({
        background: await readComputedValue(button, 'background-color'),
        border: await readComputedValue(button, 'border-top-color'),
        boxShadow: await readComputedValue(button, 'box-shadow'),
        transform: await readComputedValue(button, 'transform'),
      }))
      .toMatchObject({
        background: 'rgba(0, 0, 0, 0)',
        border: 'rgba(0, 0, 0, 0)',
        boxShadow: 'none',
        transform: 'none',
      })

    await page.mouse.move(4, 4)
  }

  const expectColumnCloseOnRight = async () => {
    const [columnTitleRowBox, actionsBox, historyBox, deleteColumnBox] = await Promise.all([
      readRect(columnTitleRow),
      readRect(columnActions),
      readRect(historyButton),
      readRect(deleteColumnButton),
    ])

    expect(actionsBox.width).toBeLessThan(120)
    expect(historyBox.left - actionsBox.left).toBeLessThan(2)
    expect(columnTitleRowBox.right - actionsBox.right).toBeCloseTo(20, 0)
    expect(actionsBox.right - deleteColumnBox.right).toBeLessThan(2)
    expect(deleteColumnBox.left - historyBox.right).toBeGreaterThan(10)
  }

  const expectColumnActionsOutsideDragSurface = async () => {
    const [columnActionsDragAncestor, columnHeadlineDraggable, historyActionCursor, deleteActionCursor] = await Promise.all([
      columnActions.evaluate((node) => node.closest('[draggable="true"]')?.className ?? null),
      page.locator('.column-headline').first().getAttribute('draggable'),
      readComputedValue(historyButton, 'cursor'),
      readComputedValue(deleteColumnButton, 'cursor'),
    ])

    expect(columnActionsDragAncestor).toBeNull()
    expect(columnHeadlineDraggable).toBe('true')
    expect(historyActionCursor).not.toBe('grab')
    expect(deleteActionCursor).not.toBe('grab')
  }

  const expectUnifiedColumnActionChrome = async () => {
    const [historyBox, deleteColumnBox, historyRadius, deleteRadius, historyShadow, deleteShadow] =
      await Promise.all([
        readRect(historyButton),
        readRect(deleteColumnButton),
        readComputedValue(historyButton, 'border-radius'),
        readComputedValue(deleteColumnButton, 'border-radius'),
        readComputedValue(historyButton, 'box-shadow'),
        readComputedValue(deleteColumnButton, 'box-shadow'),
      ])

    expect(deleteColumnBox.top).toBeCloseTo(historyBox.top, 0)
    expect(deleteColumnBox.bottom).toBeCloseTo(historyBox.bottom, 0)
    expect(deleteRadius).toBe(historyRadius)
    expect(historyShadow).toBe('none')
    expect(deleteShadow).toBe('none')
  }

  const expectCardQuietRestState = async () => {
    await page.mouse.move(4, 4)

    await expect(composerModelSelect).toBeVisible()
    await expect.poll(async () => Number(await readComputedValue(composerModelSelect, 'opacity'))).toBeGreaterThan(0.95)
    await expect(deleteCardButtons).toHaveCount(0)
    await expect(paneTabCloseButton).toBeVisible()
  }

  const expectCardHoverReveal = async () => {
    await paneView.hover()
    await expect.poll(async () => Number(await readComputedValue(composerModelSelect, 'opacity'))).toBeGreaterThan(0.95)
    await expect(deleteCardButtons).toHaveCount(0)
    await expect(paneTabCloseButton).toBeVisible()
  }

  const expectColumnActionFocusVisible = async () => {
    await historyButton.evaluate((node) => node.blur())

    let focusedButton: Locator | null = null

    for (let index = 0; index < 16; index += 1) {
      await page.keyboard.press('Tab')

      if (await historyButton.evaluate((node) => document.activeElement === node)) {
        focusedButton = historyButton
        break
      }
      if (await deleteColumnButton.evaluate((node) => document.activeElement === node)) {
        focusedButton = deleteColumnButton
        break
      }
    }

    expect(focusedButton).not.toBeNull()

    const focusState = await focusedButton!.evaluate((node) => {
      const style = getComputedStyle(node)

      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      }
    })

    expect(focusState.outlineStyle).toBe('solid')
    expect(focusState.outlineWidth).toBe('2px')
  }

  const expectColumnHeaderActionsSnapshot = async (name: string) => {
    await historyButton.evaluate((node) => node.blur())
    await page.mouse.move(4, 4)
    await expect(columnTitleRow).toHaveScreenshot(name, {
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await expectMinimalColumnActionChrome()
  await expectQuietColumnActionHover(historyButton)
  await expectQuietColumnActionHover(deleteColumnButton)
  await expectColumnCloseOnRight()
  await expectColumnActionsOutsideDragSurface()
  await expectUnifiedColumnActionChrome()
  await expectColumnActionFocusVisible()
  await expectCardQuietRestState()
  await expectCardHoverReveal()
  await expectColumnHeaderActionsSnapshot('column-header-actions-dark-desktop.png')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectMinimalColumnActionChrome()
  await expectQuietColumnActionHover(historyButton)
  await expectQuietColumnActionHover(deleteColumnButton)
  await expectColumnCloseOnRight()
  await expectColumnActionsOutsideDragSurface()
  await expectUnifiedColumnActionChrome()
  await expectColumnActionFocusVisible()
  await expectCardQuietRestState()
  await expectCardHoverReveal()
  await expectColumnHeaderActionsSnapshot('column-header-actions-light-desktop.png')

  await page.setViewportSize({ width: 346, height: 900 })
  await expectColumnHeaderActionsSnapshot('column-header-actions-light-narrow.png')

  await settingsTab.click()
  await darkThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await ambienceTab.click()
  await expectColumnHeaderActionsSnapshot('column-header-actions-dark-narrow.png')
})

test('dragging a tab over a pane edge reveals a split drop target in both themes', async ({ page }) => {
  await mockAppApis(page, { state: createColumnHeaderDropState() })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(appUrl)
  await page.locator('.workspace-column').nth(1).waitFor()

  const sourceTab = page.locator('.workspace-column').first().locator('.pane-tab').first()
  const targetColumn = page.locator('.workspace-column').nth(1)
  const targetPaneContent = targetColumn.locator('.pane-content').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const activateSplitDrop = async () => {
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
    await expect(sourceTab).toBeVisible()
    await expect(targetPaneContent).toBeVisible()
    await targetPaneContent.scrollIntoViewIfNeeded()
    const paneBox = await targetPaneContent.boundingBox()

    if (!paneBox) {
      throw new Error('Expected the target pane content to be visible')
    }

    const pointer = {
      clientX: paneBox.x + paneBox.width / 2,
      clientY: paneBox.y + Math.min(paneBox.height * 0.08, 24),
      bubbles: true,
      cancelable: true,
    }

    await dataTransfer.evaluate((dt) => {
      const payload = JSON.stringify({ type: 'tab', columnId: 'col-1', paneId: 'col-1-pane', tabId: 'card-1' })
      dt.setData('application/x-chill-vibe', payload)
      dt.setData('text/plain', payload)
    })

    await sourceTab.dispatchEvent('dragstart', { dataTransfer, ...pointer })
    await targetPaneContent.dispatchEvent('dragenter', { dataTransfer, ...pointer })
    await targetPaneContent.dispatchEvent('dragover', { dataTransfer, ...pointer })

    return dataTransfer
  }

  const clearSplitDrop = async (dataTransfer: Awaited<ReturnType<typeof activateSplitDrop>>) => {
    await targetPaneContent.dispatchEvent('dragleave', {
      dataTransfer,
      bubbles: true,
      cancelable: true,
    })
    await sourceTab.dispatchEvent('dragend', {
      dataTransfer,
      bubbles: true,
      cancelable: true,
    })
  }

  const expectSplitDropTarget = async () => {
    await expect(targetPaneContent).toHaveClass(/is-drop-top/)
    await expect
      .poll(async () =>
        targetPaneContent.evaluate((node) => Number(getComputedStyle(node, '::before').opacity)),
      )
      .toBeGreaterThan(0.95)
  }

  const darkDataTransfer = await activateSplitDrop()
  await expectSplitDropTarget()
  await clearSplitDrop(darkDataTransfer)

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  const lightDataTransfer = await activateSplitDrop()
  await expectSplitDropTarget()
  await clearSplitDrop(lightDataTransfer)
})

test('idle composers keep only the send action and empty setup logs stay hidden', async ({ page }) => {
  await mockAppApis(page)
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()

  const composerButtons = page.locator('.composer-actions').first().locator('.icon-button')
  const settingsTab = page.locator('.app-tab').nth(2)
  const ambienceTab = page.locator('.app-tab').nth(0)
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await expect(composerButtons).toHaveCount(2)

  await settingsTab.click()
  await expect(page.locator('.setup-log-shell')).toHaveCount(0)

  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('.setup-log-shell')).toHaveCount(0)

  await ambienceTab.click()
  await expect(composerButtons).toHaveCount(2)
})

test('message bubbles hide redundant role labels in both themes', async ({ page }) => {
  const state = createMockState()
  const now = new Date().toISOString()

  state.columns[0].cards[0].messages = [
    {
      id: 'message-user-1',
      role: 'user',
      content: 'Need a calmer board layout.',
      createdAt: now,
    },
    {
      id: 'message-assistant-1',
      role: 'assistant',
      content: 'Start by removing idle chrome and repeated labels.',
      createdAt: now,
    },
  ]

  await mockAppApis(page, { state })
  await page.goto(appUrl)
  await page.locator('.message').first().waitFor()

  const userRole = page.locator('.message-user .message-role').first()
  const assistantRole = page.locator('.message-assistant .message-role').first()
  const userTimestamp = page.locator('.message-user time').first()
  const assistantTimestamp = page.locator('.message-assistant time').first()
  const settingsTab = page.locator('.app-tab').nth(2)
  const ambienceTab = page.locator('.app-tab').nth(0)
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await expect.poll(async () => await readComputedValue(userRole, 'display')).toBe('none')
  await expect.poll(async () => await readComputedValue(assistantRole, 'display')).toBe('none')
  await expect.poll(async () => await readComputedValue(userTimestamp, 'display')).toBe('none')
  await expect.poll(async () => await readComputedValue(assistantTimestamp, 'display')).toBe('none')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect.poll(async () => await readComputedValue(userRole, 'display')).toBe('none')
  await expect.poll(async () => await readComputedValue(assistantRole, 'display')).toBe('none')
  await expect.poll(async () => await readComputedValue(userTimestamp, 'display')).toBe('none')
  await expect.poll(async () => await readComputedValue(assistantTimestamp, 'display')).toBe('none')
})

test('user fork actions stay light and icon-only in both themes', async ({ page }) => {
  const state = createMockState()
  const now = new Date().toISOString()

  state.columns[0].cards[0].messages = [
    {
      id: 'message-user-fork-1',
      role: 'user',
      content: 'Branch from this suggestion and keep the calmer spacing.',
      createdAt: now,
    },
    {
      id: 'message-assistant-fork-1',
      role: 'assistant',
      content: 'I would remove the idle dividers first, then tighten the pane chrome.',
      createdAt: now,
    },
  ]

  await mockAppApis(page, { state })
  await page.goto(appUrl)
  const userEntry = page
    .locator('.message-list .message-entry-user')
    .filter({ has: page.locator('.message-fork-btn') })
    .first()
  const userForkButton = userEntry.locator('.message-fork-btn')
  const assistantForkButton = page.locator('.message-list .message-entry-assistant .message-fork-btn')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const expectForkAction = async (theme: 'dark' | 'light') => {
    await expect(userEntry).toBeVisible()
    await expect(userForkButton).toBeVisible()
    await expect(assistantForkButton).toHaveCount(0)
    await expect(userForkButton).toHaveAttribute('title', '从此处分叉')
    await expect.poll(async () => Number(await readComputedValue(userForkButton, 'opacity'))).toBeGreaterThan(0.6)
    await expect(userEntry).toHaveScreenshot(`message-fork-action-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await expectForkAction('dark')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectForkAction('light')
})

test('structured tool groups stay quiet without fork actions in both themes', async ({ page }) => {
  const state = createMockState()
  const now = new Date().toISOString()

  state.columns[0].cards[0].messages = [
    {
      id: 'message-user-structured-fork-1',
      role: 'user',
      content: 'Inspect the board layout and branch from the latest tool state.',
      createdAt: now,
    },
    {
      id: 'message-tool-structured-fork-1',
      role: 'assistant',
      content: '',
      createdAt: now,
      meta: {
        kind: 'tool',
        provider: 'codex',
        structuredData: JSON.stringify({
          itemId: 'tool-structured-fork-1',
          status: 'completed',
          toolName: 'Read',
          summary: 'Read src/components/ChatCard.tsx',
          toolInput: {
            file_path: 'src/components/ChatCard.tsx',
            offset: '470',
            limit: '40',
          },
        }),
      },
    },
  ]

  await mockAppApis(page, { state })
  await page.goto(appUrl)

  const structuredGroup = page.locator('.structured-command-group').first()
  const structuredForkButton = structuredGroup.locator('.message-fork-btn')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const expectStructuredForkAction = async (theme: 'dark' | 'light') => {
    await expect(structuredForkButton).toHaveCount(0)
    await expect(structuredGroup).toHaveScreenshot(`message-fork-action-structured-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await expectStructuredForkAction('dark')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectStructuredForkAction('light')
})

test('the first message starts close to the top edge in both themes', async ({ page }) => {
  const state = createMockState()
  const now = new Date().toISOString()

  state.settings.language = 'en'
  state.columns[0].cards[0].messages = [
    {
      id: 'message-user-1',
      role: 'user',
      content: 'Trim the extra top gap.',
      createdAt: now,
    },
  ]

  await mockAppApis(page, { state })
  await page.goto(appUrl)
  await page.locator('.message-user').first().waitFor()

  const messageList = page.locator('.message-list').first()
  const firstMessage = page.locator('.message-user').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const readTopGap = async () => {
    const [listRect, messageRect] = await Promise.all([readRect(messageList), readRect(firstMessage)])
    return messageRect.top - listRect.top
  }

  await expect.poll(readTopGap).toBeLessThan(6)

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect.poll(readTopGap).toBeLessThan(6)
})

test('the latest user prompt stays pinned to the top once its reply takes over and only the sticky prompt keeps a shadow in both themes', async ({ page }) => {
  const state = createMockState()
  const now = Date.UTC(2026, 3, 11, 9, 30, 0)

  state.settings.language = 'en'
  state.columns[0].cards[0].messages = [
    {
      id: 'message-assistant-context',
      role: 'assistant',
      content: 'Earlier context before the latest prompt.',
      createdAt: new Date(now - 2_000).toISOString(),
    },
    {
      id: 'message-user-sticky-first',
      role: 'user',
      content: 'Keep this first tracked prompt visible while I read the first answer below.',
      createdAt: new Date(now - 1_000).toISOString(),
    },
    {
      id: 'message-assistant-reply-1',
      role: 'assistant',
      content: Array.from(
        { length: 14 },
        (_, index) => `Reply section ${index + 1}: ${'detail '.repeat(48)}`,
      ).join('\n\n'),
      createdAt: new Date(now).toISOString(),
    },
    {
      id: 'message-user-sticky-second',
      role: 'user',
      content: 'Keep this latest prompt visible while I read the answer below.',
      createdAt: new Date(now + 1_000).toISOString(),
    },
    {
      id: 'message-assistant-reply-2',
      role: 'assistant',
      content: Array.from(
        { length: 14 },
        (_, index) => `Second reply section ${index + 1}: ${'detail '.repeat(48)}`,
      ).join('\n\n'),
      createdAt: new Date(now + 2_000).toISOString(),
    },
  ]

  await mockAppApis(page, { state })
  await page.goto(appUrl)

  const messageList = page.locator('.message-list').first()
  const stickyShell = page.locator('.message-sticky-shell').first()
  const stickyBubble = stickyShell.locator('.message-user').first()
  const firstUserBubble = page.locator('[data-renderable-id="message-user-sticky-first"] .message-user').first()
  const secondUserMessage = page.locator('[data-renderable-id="message-user-sticky-second"]').first()
  const firstReply = page.locator('[data-renderable-id="message-assistant-reply-1"]').first()
  const secondReply = page.locator('[data-renderable-id="message-assistant-reply-2"]').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const scrollEntryPastTop = async (entryLocator: Locator, offsetPastTop: number) => {
    await entryLocator.evaluate((node, nextOffsetPastTop) => {
      const container = node.closest('.message-list') as HTMLElement | null
      if (!container) {
        return
      }

      const targetTop =
        node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      container.scrollTop = Math.max(targetTop + nextOffsetPastTop, 0)
    }, offsetPastTop)
  }

  const expectStickyPrompt = async (theme: 'dark' | 'light') => {
    await scrollEntryPastTop(firstReply, 140)
    await expect(stickyShell).toContainText('Keep this first tracked prompt visible while I read the first answer below.')

    await scrollEntryPastTop(secondUserMessage, 12)
    await page.waitForTimeout(100)
    await expect(stickyShell).toHaveCount(0)

    await scrollEntryPastTop(secondReply, 140)
    await page.waitForTimeout(100)
    await expect(stickyShell).toHaveCount(1)
    await expect(stickyShell).toContainText('Keep this latest prompt visible while I read the answer below.')
    await expect.poll(async () => {
      const [listRect, stickyRect] = await Promise.all([readRect(messageList), readRect(stickyShell)])
      return Math.round(stickyRect.top - listRect.top)
    }).toBe(10)
    await expect.poll(async () => await readComputedValue(firstUserBubble, 'box-shadow')).toBe('none')
    await expect.poll(async () => await readComputedValue(stickyBubble, 'box-shadow')).not.toBe('none')

    await expect(stickyBubble).toHaveScreenshot(`message-last-user-sticky-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await expectStickyPrompt('dark')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectStickyPrompt('light')
})

test('sticky user prompts keep image attachments compact while reading the reply in both themes', async ({ page }) => {
  const state = createAttachmentPreviewState()
  state.settings.language = 'en'
  state.columns[0].cards[0].messages.push({
    id: 'assistant-image-sticky-reply',
    role: 'assistant',
    content: Array.from(
      { length: 12 },
      (_, index) => `Reply block ${index + 1}: ${'detail '.repeat(40)}`,
    ).join('\n\n'),
    createdAt: '2026-04-05T12:09:00.000Z',
  })

  await mockAppApis(page, { state })
  await page.route('**/api/attachments/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: attachmentPreviewSvg,
    })
  })
  await page.goto(appUrl)

  const messageList = page.locator('.message-list').first()
  const reply = page.locator('[data-renderable-id="assistant-image-sticky-reply"]').first()
  const stickyShell = page.locator('.message-sticky-shell').first()
  const stickyBubble = stickyShell.locator('.message-user').first()
  const stickyAttachmentFrame = stickyShell.locator('.message-attachment-frame').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const scrollReplyPastTop = async () => {
    await reply.evaluate((node) => {
      const container = node.closest('.message-list') as HTMLElement | null
      if (!container) {
        return
      }

      const targetTop =
        node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      container.scrollTop = Math.max(targetTop + 160, 0)
    })
  }

  const expectStickyAttachment = async (theme: 'dark' | 'light') => {
    await scrollReplyPastTop()
    await expect(stickyShell).toBeVisible()
    await expect.poll(async () => {
      const [listRect, stickyRect] = await Promise.all([readRect(messageList), readRect(stickyShell)])
      return Math.round(stickyRect.top - listRect.top)
    }).toBe(10)
    await expect.poll(async () => (await readRect(stickyShell)).height).toBeLessThan(190)
    await expect
      .poll(async () => {
        const rect = await readRect(stickyAttachmentFrame)
        return Math.abs(rect.width - rect.height)
      })
      .toBeLessThan(3)
    await expect(stickyBubble).toHaveScreenshot(`message-sticky-attachment-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await expectStickyAttachment('dark')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectStickyAttachment('light')
})

test('sticky user prompts clamp long prompt previews in both themes', async ({ page }) => {
  const state = createMockState()
  const now = Date.UTC(2026, 3, 11, 10, 15, 0)

  state.settings.language = 'en'
  state.columns[0].cards[0].messages = [
    {
      id: 'message-assistant-long-sticky-context',
      role: 'assistant',
      content: 'Earlier context before the long prompt.',
      createdAt: new Date(now - 2_000).toISOString(),
    },
    {
      id: 'message-user-long-sticky',
      role: 'user',
      content: Array.from(
        { length: 10 },
        (_, index) => `Long sticky prompt line ${index + 1}: ${'detail '.repeat(18)}`,
      ).join('\n'),
      createdAt: new Date(now - 1_000).toISOString(),
    },
    {
      id: 'message-assistant-long-sticky-reply',
      role: 'assistant',
      content: Array.from(
        { length: 14 },
        (_, index) => `Reply section ${index + 1}: ${'detail '.repeat(48)}`,
      ).join('\n\n'),
      createdAt: new Date(now).toISOString(),
    },
  ]

  await mockAppApis(page, { state })
  await page.goto(appUrl)

  const messageList = page.locator('.message-list').first()
  const reply = page.locator('[data-renderable-id="message-assistant-long-sticky-reply"]').first()
  const stickyShell = page.locator('.message-sticky-shell').first()
  const stickyBubble = stickyShell.locator('.message-user').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const scrollReplyPastTop = async () => {
    await reply.evaluate((node) => {
      const container = node.closest('.message-list') as HTMLElement | null
      if (!container) {
        return
      }

      const targetTop =
        node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      container.scrollTop = Math.max(targetTop + 180, 0)
    })
  }

  const expectClampedStickyPrompt = async (theme: 'dark' | 'light') => {
    await scrollReplyPastTop()
    await expect(stickyShell).toBeVisible()
    await expect(stickyShell).toContainText('Long sticky prompt line 1')
    await expect.poll(async () => {
      const [listRect, stickyRect] = await Promise.all([readRect(messageList), readRect(stickyShell)])
      return Math.round(stickyRect.top - listRect.top)
    }).toBe(10)
    await expect.poll(async () => (await readRect(stickyBubble)).height).toBeLessThan(180)

    await expect(stickyBubble).toHaveScreenshot(`message-sticky-long-prompt-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await expectClampedStickyPrompt('dark')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectClampedStickyPrompt('light')
})

test('sticky prompt waits until the latest image prompt has fully cleared the top edge in both themes', async ({ page }) => {
  const state = createMockState()
  const now = Date.UTC(2026, 3, 11, 11, 0, 0)
  state.settings.language = 'en'
  state.columns[0].cards[0].messages = [
    {
      id: 'assistant-image-boundary-context',
      role: 'assistant',
      content: 'Earlier context before the tracked prompt.',
      createdAt: new Date(now - 2_000).toISOString(),
    },
    {
      id: 'user-image-boundary-first',
      role: 'user',
      content: 'Keep this first prompt pinned until the image prompt has fully passed the top edge.',
      createdAt: new Date(now - 1_000).toISOString(),
    },
    {
      id: 'assistant-image-boundary-reply-1',
      role: 'assistant',
      content: Array.from(
        { length: 14 },
        (_, index) => `First reply block ${index + 1}: ${'detail '.repeat(44)}`,
      ).join('\n\n'),
      createdAt: new Date(now).toISOString(),
    },
    {
      id: 'user-image-boundary-second',
      role: 'user',
      content: 'Only pin this image prompt after its reply actually takes over the reading area.',
      createdAt: new Date(now + 1_000).toISOString(),
      meta: attachImagesToMessageMeta([
        {
          id: 'attachment-boundary-1',
          fileName: 'boundary-reference.png',
          mimeType: 'image/png',
          sizeBytes: 38_400,
        },
      ]),
    },
    {
      id: 'assistant-image-boundary-reply-2',
      role: 'assistant',
      content: Array.from(
        { length: 12 },
        (_, index) => `Second reply block ${index + 1}: ${'detail '.repeat(40)}`,
      ).join('\n\n'),
      createdAt: new Date(now + 2_000).toISOString(),
    },
  ]

  await mockAppApis(page, { state })
  await page.route('**/api/attachments/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: attachmentPreviewSvg,
    })
  })
  await page.goto(appUrl)

  const messageList = page.locator('.message-list').first()
  const imagePrompt = messageList.locator('[data-renderable-id="user-image-boundary-second"]').first()
  const secondReply = messageList.locator('[data-renderable-id="assistant-image-boundary-reply-2"]').first()
  const stickyShell = page.locator('.message-sticky-shell').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const scrollEntryPastTop = async (entryLocator: Locator, offsetPastTop: number) => {
    await entryLocator.evaluate((node, nextOffsetPastTop) => {
      const container = node.closest('.message-list') as HTMLElement | null
      if (!container) {
        return
      }

      const targetTop =
        node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
      container.scrollTop = Math.max(targetTop + nextOffsetPastTop, 0)
    }, offsetPastTop)
  }

  const expectStickyBoundary = async () => {
    await scrollEntryPastTop(imagePrompt, 16)
    await page.waitForTimeout(100)
    await expect(stickyShell).toHaveCount(0)

    await scrollEntryPastTop(secondReply, 140)
    await page.waitForTimeout(100)
    await expect(stickyShell).toHaveCount(1)
    await expect(stickyShell).toContainText(
      'Only pin this image prompt after its reply actually takes over the reading area.',
    )
  }

  await expectStickyBoundary()

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectStickyBoundary()
})

test('assistant replies use the full message lane in both themes and narrow layouts', async ({ page }) => {
  const state = createMockState()
  const now = new Date().toISOString()

  state.columns[0].cards[0].messages = [
    {
      id: 'message-assistant-wide-1',
      role: 'assistant',
      content: [
        '可以，下面直接给你一组“结构化输出”示例，覆盖常见形式。',
        '',
        '1. 列表',
        '',
        '- 状态：成功',
        '- 模式：演示',
        '- 数量：多种格式',
        '',
        '2. 说明',
        '',
        'This intentionally long assistant reply should stretch across the full available lane instead of stopping early and leaving an empty gutter on the right. '.repeat(
          6,
        ),
      ].join('\n'),
      createdAt: now,
    },
  ]

  await mockAppApis(page, { state })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(appUrl)

  const messageList = page.locator('.message-list').first()
  const assistantMessage = page.locator('.message-assistant').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()
  const darkThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').nth(1)

  const expectAssistantToFillLane = async () => {
    await assistantMessage.scrollIntoViewIfNeeded()
    await expect.poll(async () => {
      const [laneWidth, bubbleWidth] = await Promise.all([
        readContentWidth(messageList),
        assistantMessage.evaluate((node) => node.getBoundingClientRect().width),
      ])

      return laneWidth - bubbleWidth
    }).toBeLessThan(8)
  }

  await expect(assistantMessage).toBeVisible()
  await expectAssistantToFillLane()

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()
  await expectAssistantToFillLane()

  await page.setViewportSize({ width: 390, height: 844 })
  await expectAssistantToFillLane()

  await settingsTab.click()
  await darkThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await ambienceTab.click()
  await expectAssistantToFillLane()
})

test('message section headings stay quiet while nested bullets remain readable in both themes', async ({ page }) => {
  const state = createMockState()
  const now = new Date().toISOString()

  state.columns[0].cards[0].messages = [
    {
      id: 'message-assistant-section-list-1',
      role: 'assistant',
      content: [
        '下面是这次 IDE 优化的处理情况：',
        '',
        '- 已经做过的部分:',
        '  - ChatCard、PaneView、WorkspaceColumn 先做了渲染减负',
        '  - 流式输出改成 requestAnimationFrame 节流，避免每个 token 都直接刷一次 React',
        '',
        '- 还没兜住的地方:',
        '  - App render 仍会重算部分会话摘要',
        '  - 草稿同步路径还有多余写入',
      ].join('\n'),
      createdAt: now,
    },
  ]

  await mockAppApis(page, { state })
  await page.goto(appUrl)

  const assistantMessage = page.locator('.message-assistant').first()
  const topLevelSection = assistantMessage.locator('.message-content > ul > li').first()
  const nestedBullet = topLevelSection.locator('ul > li').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const expectSectionGrouping = async (theme: 'dark' | 'light') => {
    await expect(assistantMessage).toBeVisible()
    await expect.poll(async () => await readComputedValue(topLevelSection, 'list-style-type')).toBe('none')
    await expect.poll(async () => (await readComputedValue(nestedBullet, 'list-style-type')) !== 'none').toBeTruthy()
    await expect(assistantMessage).toHaveScreenshot(`message-section-list-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await expectSectionGrouping('dark')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectSectionGrouping('light')
})

test('assistant markdown inline code and file links stay quiet in both themes', async ({ page }) => {
  await mockAppApis(page, { state: createQuietMarkdownState() })
  await page.goto(appUrl)

  const assistantMessage = page.locator('[data-renderable-id="assistant-inline-markdown-1"]').first()
  const inlineCode = assistantMessage.locator('code').first()
  const firstLink = assistantMessage.locator('a').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const expectQuietMarkdown = async (theme: 'dark' | 'light') => {
    await expect(assistantMessage).toBeVisible()
    await expect(inlineCode).toContainText('codex exec')
    await expect(firstLink).toContainText('shared/i18n.ts')

    await expect(assistantMessage).toHaveScreenshot(`message-inline-markdown-quiet-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await expectQuietMarkdown('dark')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectQuietMarkdown('light')
})

test('structured command and reasoning blocks stay quiet across themes', async ({ page }) => {
  await mockAppApis(page, { state: createStructuredChatState() })
  await page.goto(appUrl)
  await page.locator('.structured-group-summary-row').first().waitFor()

  const commandGroup = page.locator('.structured-command-group').first()
  const groupSummaryRow = page.locator('.structured-group-summary-row').first()
  const groupSummaryText = groupSummaryRow.locator('.structured-group-summary-text')
  const commandInline = commandGroup.locator('.structured-command-inline').first()
  const secondCommandInline = commandGroup.locator('.structured-command-inline').nth(1)
  const commandRow = commandInline.locator('.structured-command-inline-row')
  const commandLabel = commandInline.locator('.structured-command-label')
  const commandText = commandInline.locator('.structured-command-text')
  const reasoningCard = page.locator('.structured-reasoning-card').first()
  const reasoningText = reasoningCard.locator('.structured-preview-text')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await expect(commandGroup.locator('.structured-command-inline-row')).toHaveCount(0)
  await expect(commandGroup.locator('.structured-group-summary-text')).toContainText('Ran 2 commands')
  await expect(reasoningCard).toContainText('Check the renderer bridge next')
  await expect(reasoningCard.locator('.structured-reasoning-label')).toContainText('Thinking')
  expect((await readRect(groupSummaryRow)).height).toBeLessThan(32)
  expect((await readRect(reasoningCard)).height).toBeLessThan(36)
  expect(isTransparentColor(await readComputedValue(groupSummaryRow, 'background-color'))).toBeTruthy()
  expect(isTransparentColor(await readComputedValue(reasoningCard, 'background-color'))).toBeTruthy()
  await expect(commandGroup).toHaveScreenshot('structured-command-group-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  const darkReasoningBackground = await readComputedRgb(reasoningCard, 'background-color')
  expect(maxChannel(darkReasoningBackground)).toBeLessThan(90)
  expect(lacksGreenCast(darkReasoningBackground)).toBeTruthy()

  await groupSummaryRow.click()
  await expect(commandGroup.locator('.structured-command-inline-row')).toHaveCount(2)
  await expect(commandLabel).toContainText('Git command')
  await expect(secondCommandInline).toContainText('Read file')
  await expect(commandInline.locator('.structured-command-dot')).toHaveCount(0)
  expect(await readComputedValue(commandLabel, 'font-size')).toBe(await readComputedValue(commandText, 'font-size'))
  expect(await readComputedValue(commandLabel, 'font-family')).toBe(await readComputedValue(commandText, 'font-family'))
  expect(await readComputedValue(commandLabel, 'text-transform')).toBe('none')
  expect(Number.parseFloat(await readComputedValue(groupSummaryText, 'font-size'))).toBeLessThanOrEqual(10.25)
  expect(Number.parseFloat(await readComputedValue(commandText, 'font-size'))).toBeLessThanOrEqual(10.75)
  expect(Number.parseFloat(await readComputedValue(reasoningText, 'font-size'))).toBeLessThanOrEqual(10.25)
  await commandRow.click()
  const dialog = page.getByRole('dialog')
  const dialogCard = dialog.locator('.structured-preview-card')
  await expect(dialog).toContainText('git status --short')
  await expect(dialog).toContainText('M src/App.tsx')
  const darkDialogBackground = await readComputedRgb(dialogCard, 'background-color')
  expect(maxChannel(darkDialogBackground)).toBeLessThan(90)
  expect(lacksGreenCast(darkDialogBackground)).toBeTruthy()
  await dialog.getByRole('button', { name: 'Close details' }).click()
  await expect(dialog).toBeHidden()
  await groupSummaryRow.click()

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect(commandGroup.locator('.structured-command-inline-row')).toHaveCount(0)
  expect((await readRect(groupSummaryRow)).height).toBeLessThan(32)
  expect((await readRect(reasoningCard)).height).toBeLessThan(36)
  await expect(commandGroup).toHaveScreenshot('structured-command-group-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await groupSummaryRow.click()
  await expect(commandGroup.locator('.structured-command-inline-row')).toHaveCount(2)
  await expect(commandInline).toBeVisible()
  await commandRow.click()
  await expect(dialog).toContainText('git status --short')
  const lightDialogBackground = await readComputedRgb(dialogCard, 'background-color')
  expect(maxChannel(lightDialogBackground)).toBeGreaterThan(180)
})

test('structured zh-CN activity rows keep compact typography across themes', async ({ page }) => {
  await mockAppApis(page, { state: createStructuredChatStateZh() })
  await page.goto(appUrl)
  await page.locator('.structured-group-summary-row').first().waitFor()

  const commandGroup = page.locator('.structured-command-group').first()
  const groupSummaryRow = page.locator('.structured-group-summary-row').first()
  const groupSummaryText = groupSummaryRow.locator('.structured-group-summary-text')
  const groupSummaryChevron = groupSummaryRow.locator('.structured-group-chevron')
  const reasoningCard = page.locator('.structured-reasoning-card').first()
  const reasoningText = reasoningCard.locator('.structured-preview-text')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const expectCompactTypography = async () => {
    await expect(commandGroup.locator('.structured-command-inline-row')).toHaveCount(0)
    await expect(groupSummaryText).toContainText('\u6267\u884C\u4E86 3 \u6761\u547D\u4EE4')
    await expect(reasoningCard).toContainText('Inspecting image support')
    await expect(reasoningCard.locator('.structured-reasoning-label')).toContainText('\u601D\u8003\u4E2D')

    const [summaryTextRect, summaryChevronRect] = await Promise.all([
      readRect(groupSummaryText),
      readRect(groupSummaryChevron),
    ])
    expect(summaryChevronRect.left).toBeGreaterThanOrEqual(summaryTextRect.right - 1)

    await groupSummaryRow.click()

    const commandRows = commandGroup.locator('.structured-command-inline-row')
    await expect(commandRows).toHaveCount(3)

    const firstLabel = commandRows.nth(0).locator('.structured-command-label')
    const firstText = commandRows.nth(0).locator('.structured-command-text')
    const thirdLabel = commandRows.nth(2).locator('.structured-command-label')
    const summaryFontSize = await readComputedValue(groupSummaryText, 'font-size')

    await expect(firstLabel).toContainText('\u8BFB\u53D6\u6587\u4EF6')
    await expect(commandRows.nth(0)).toContainText('ChatCard.tsx')
    await expect(commandRows.nth(1)).toContainText('index.css')
    await expect(thirdLabel).toContainText('Git \u547D\u4EE4')
    expect(summaryFontSize).toBe(await readComputedValue(firstLabel, 'font-size'))
    expect(summaryFontSize).toBe(await readComputedValue(firstText, 'font-size'))
    expect(summaryFontSize).toBe(await readComputedValue(thirdLabel, 'font-size'))
    expect(summaryFontSize).toBe(await readComputedValue(reasoningText, 'font-size'))
    expect(await readComputedValue(firstLabel, 'text-transform')).toBe('none')
    expect(Number.parseFloat(summaryFontSize)).toBeLessThanOrEqual(10.25)
    expect(isTransparentColor(await readComputedValue(reasoningCard, 'background-color'))).toBeTruthy()

    await groupSummaryRow.click()
    await expect(commandRows).toHaveCount(0)
  }

  await expectCompactTypography()

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectCompactTypography()
})

test('structured activity rows wrap cleanly on narrow viewports in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockAppApis(page, { state: createStructuredChatStateZh() })
  await page.goto(appUrl)
  await page.locator('.structured-group-summary-row').first().waitFor()

  const commandGroup = page.locator('.structured-command-group').first()
  const groupSummaryRow = page.locator('.structured-group-summary-row').first()
  const reasoningCard = page.locator('.structured-reasoning-card').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const expectNarrowLayout = async (theme: 'dark' | 'light') => {
    await expect(commandGroup.locator('.structured-command-inline-row')).toHaveCount(0)
    await groupSummaryRow.click()

    const commandRows = commandGroup.locator('.structured-command-inline-row')
    await expect(commandRows).toHaveCount(3)

    const groupRect = await readRect(commandGroup)
    for (let index = 0; index < 3; index += 1) {
      const rowRect = await readRect(commandRows.nth(index))
      expect(rowRect.left).toBeGreaterThanOrEqual(groupRect.left - 1)
      expect(rowRect.right).toBeLessThanOrEqual(groupRect.right + 1)
    }

    const reasoningRect = await readRect(reasoningCard)
    expect(reasoningRect.left).toBeGreaterThanOrEqual(groupRect.left - 1)
    expect(reasoningRect.right).toBeLessThanOrEqual(groupRect.right + 1)

    await expect(commandGroup).toHaveScreenshot(`structured-command-group-zh-narrow-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })

    await groupSummaryRow.click()
    await expect(commandRows).toHaveCount(0)
  }

  await expectNarrowLayout('dark')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectNarrowLayout('light')
})

test('structured activity stays quiet inside the full chat card across themes', async ({ page }) => {
  await mockAppApis(page, { state: createStructuredChatStateZh() })
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()

  const cardShell = page.locator('.card-shell').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await expect(cardShell).toHaveScreenshot('structured-command-card-full-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect(cardShell).toHaveScreenshot('structured-command-card-full-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('streaming structured command groups avoid duplicate inline cursors across themes', async ({ page }) => {
  await mockAppApis(page, { state: createStreamingStructuredCommandGroupState() })
  await page.goto(appUrl)
  await page.locator('.structured-command-group').first().waitFor()

  const commandGroup = page.locator('.structured-command-group').first()
  const streamingIndicator = page.locator('.streaming-indicator')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const countInlineGroupCursors = async () =>
    commandGroup.evaluate((node) =>
      Array.from(node.children).filter((child) => {
        const pseudoContent = getComputedStyle(child, '::after').content
        return pseudoContent !== 'none' && pseudoContent !== 'normal' && pseudoContent !== '""'
      }).length,
    )

  await expect(commandGroup.locator('.structured-command-inline-row')).toHaveCount(3)
  await expect(commandGroup.locator('.structured-group-summary-text')).toContainText('Ran 3 commands')
  await expect(streamingIndicator).toContainText('Running command')
  expect(await countInlineGroupCursors()).toBe(0)
  await expect(commandGroup).toHaveScreenshot('structured-command-group-streaming-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect(commandGroup.locator('.structured-command-inline-row')).toHaveCount(3)
  await expect(streamingIndicator).toContainText('Running command')
  expect(await countInlineGroupCursors()).toBe(0)
  await expect(commandGroup).toHaveScreenshot('structured-command-group-streaming-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('streaming plain replies keep inline cursor blocks out of the transcript across themes', async ({ page }) => {
  await mockAppApis(page, { state: createStreamingPlainTranscriptState() })
  await page.goto(appUrl)

  const assistantArticle = page
    .locator('[data-renderable-id="assistant-streaming-plain-1"] article.message-assistant')
    .first()
  const streamingIndicator = page.locator('.streaming-indicator')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const countInlineCursors = async () =>
    assistantArticle.evaluate((node) =>
      Array.from(node.children).filter((child) => {
        const pseudoContent = getComputedStyle(child, '::after').content
        return pseudoContent !== 'none' && pseudoContent !== 'normal' && pseudoContent !== '""' && pseudoContent !== "''"
      }).length,
    )

  const expectQuietStreamingReply = async (theme: 'dark' | 'light') => {
    await expect(assistantArticle).toBeVisible()
    await expect(assistantArticle).toContainText('尚未解决')
    await expect(streamingIndicator).toContainText('生成中')
    expect(await countInlineCursors()).toBe(0)
    await expect(assistantArticle).toHaveScreenshot(`message-streaming-no-inline-cursor-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await expectQuietStreamingReply('dark')

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expectQuietStreamingReply('light')
})

test('message attachment previews open larger dialogs and stay legible across themes', async ({ page }) => {
  await mockAppApis(page, { state: createAttachmentPreviewState() })
  await page.route('**/api/attachments/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: attachmentPreviewSvg,
    })
  })
  await page.goto(appUrl)
  await page.locator('.message-attachment-frame').first().waitFor()

  const attachmentFrame = page.locator('.message-attachment-frame').first()
  const attachmentImage = attachmentFrame.locator('.message-attachment-image')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()
  await expect(attachmentImage).toBeVisible()
  await expect
    .poll(() => attachmentImage.evaluate((node) => (node as HTMLImageElement).complete))
    .toBeTruthy()
  const inlineFrameRect = await readRect(attachmentFrame)
  expect(inlineFrameRect.width).toBeLessThan(160)
  expect(inlineFrameRect.height).toBeLessThan(160)
  expect(Math.abs(inlineFrameRect.width - inlineFrameRect.height)).toBeLessThan(3)
  await expect(attachmentFrame).toHaveScreenshot('message-attachment-inline-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await attachmentFrame.click()

  const dialog = page.getByRole('dialog')
  const dialogCard = dialog.locator('.message-attachment-preview-card')
  const dialogImage = dialog.locator('.message-attachment-preview-image')
  const minimumPreviewWidth = inlineFrameRect.width * 1.6

  await expect(dialog).toBeVisible()
  await expect(dialogImage).toBeVisible()
  await expect.poll(async () => (await readRect(dialogImage)).width).toBeGreaterThan(minimumPreviewWidth)
  expect(maxChannel(await readComputedRgb(dialogCard, 'background-color'))).toBeLessThan(90)
  expect(lacksGreenCast(await readComputedRgb(dialogCard, 'background-color'))).toBeTruthy()
  await expect(dialogCard).toHaveScreenshot('message-attachment-preview-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await dialog.locator('.message-attachment-preview-close').click()
  await expect(dialog).toBeHidden()

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()
  await expect(attachmentFrame).toHaveScreenshot('message-attachment-inline-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
  await attachmentFrame.click()

  await expect(dialog).toBeVisible()
  await expect.poll(async () => (await readRect(dialogImage)).width).toBeGreaterThan(minimumPreviewWidth)
  expect(maxChannel(await readComputedRgb(dialogCard, 'background-color'))).toBeGreaterThan(180)
  await expect(dialogCard).toHaveScreenshot('message-attachment-preview-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

for (const theme of ['dark', 'light'] as const) {
  test(`settings panel shows named auto urge profiles in ${theme} theme`, async ({ page }) => {
    const state = createMockState()
    state.settings.language = 'en'
    state.settings.theme = theme
    state.settings.autoUrgeEnabled = true
    state.settings.autoUrgeProfiles = [
      {
        id: 'profile-release',
        name: 'Release Guard',
        message: 'Keep checking until release evidence is attached.',
        successKeyword: 'SHIP',
      },
      {
        id: 'profile-review',
        name: 'Code Review',
        message: 'Keep reviewing until every risk is grounded in evidence.',
        successKeyword: 'APPROVED',
      },
    ]
    state.settings.autoUrgeActiveProfileId = 'profile-review'
    state.settings.autoUrgeMessage = 'Keep reviewing until every risk is grounded in evidence.'
    state.settings.autoUrgeSuccessKeyword = 'APPROVED'

    await mockAppApis(page, { state })
    await page.goto(appUrl)

    const settingsTab = page.locator('#app-tab-settings')
    const utilityGroup = page.locator('#app-panel-settings .settings-group').filter({ hasText: 'Utility' }).first()

    await settingsTab.click()
    await expect(utilityGroup).toBeVisible()
    await expect(utilityGroup.locator('.auto-urge-profile-card')).toHaveCount(2)
    await expect(utilityGroup.getByRole('button', { name: 'Use This Type' })).toHaveCount(0)
    await expect(utilityGroup.getByRole('button', { name: 'Current Type' })).toHaveCount(0)

    await expect(utilityGroup).toHaveScreenshot(`settings-auto-urge-profiles-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`chat composer nests auto urge inside the settings menu in ${theme} theme`, async ({ page }) => {
    const state = createMockState()
    state.settings.theme = theme
    state.settings.autoUrgeEnabled = true
    state.settings.autoUrgeProfiles = [
      {
        id: 'profile-release',
        name: 'Release Guard',
        message: 'Please keep verifying until you have evidence.',
        successKeyword: 'YES',
      },
      {
        id: 'profile-review',
        name: 'Code Review',
        message: 'List the risks before you stop.',
        successKeyword: 'APPROVED',
      },
    ]
    const firstCard = Object.values(state.columns[0]?.cards ?? {})[0]
    if (firstCard) {
      firstCard.autoUrgeProfileId = 'profile-review'
    }

    await mockAppApis(page, { state })
    await page.goto(appUrl)

    const cardShell = page.locator('.card-shell').first()
    const settingsTrigger = page.locator('.composer-settings-trigger').first()
    const settingsMenu = page.locator('.composer-settings-menu').first()
    const autoUrgeStatus = page.locator('.composer-auto-urge-status').first()

    await expect(page.locator('.composer-auto-pua-toggle')).toHaveCount(0)
    await expect(settingsTrigger).not.toHaveClass(/has-auto-urge/)
    await expect(autoUrgeStatus).toHaveCount(0)

    await settingsTrigger.click()
    await expect(settingsMenu).toBeVisible()
    await expect(settingsMenu).toContainText(/Auto Urge|自动鞭策/)
    await expect(settingsMenu.getByLabel(/Auto Urge|自动鞭策/)).not.toBeChecked()
    await expect(settingsMenu.locator('.composer-auto-urge-profile-select')).toHaveValue('profile-review')

    const [cardRect, menuRect] = await Promise.all([readRect(cardShell), readRect(settingsMenu)])
    expect(menuRect.top).toBeGreaterThanOrEqual(cardRect.top + 6)
    expect(menuRect.right).toBeLessThanOrEqual(cardRect.right - 6)
    expect(menuRect.bottom).toBeLessThanOrEqual(cardRect.bottom - 6)

    await expect(settingsMenu).toHaveScreenshot(`composer-settings-menu-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })

    await expect(cardShell).toHaveScreenshot(`composer-auto-urge-settings-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`pasted image composer stays compact without ready notice in ${theme} theme`, async ({ page }) => {
    const state = createMockState()
    state.settings.theme = theme

    await mockAppApis(page, { state })
    await page.goto(appUrl)

    const composer = page.locator('.composer').first()
    const textarea = composer.locator('textarea').first()
    const attachmentImage = composer.locator('.composer-attachment-image').first()

    await expect(textarea).toBeVisible()
    await pasteImageIntoTextarea(textarea)
    await expect(attachmentImage).toBeVisible()
    await expect
      .poll(() => attachmentImage.evaluate((node) => (node as HTMLImageElement).complete))
      .toBeTruthy()
    await expect(composer.locator('.composer-attachment-note')).toHaveCount(0)

    await expect(composer).toHaveScreenshot(`composer-pasted-image-no-ready-note-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`chat composer grows taller for multiline drafts in ${theme} theme`, async ({ page }) => {
    const state = createMockState()
    state.settings.theme = theme

    await mockAppApis(page, { state })
    await page.goto(appUrl)

    const composer = page.locator('.composer').first()
    const textarea = composer.locator('textarea').first()
    const multilineDraft = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'].join('\n')

    await expect(textarea).toBeVisible()

    const initialBox = await textarea.boundingBox()
    if (!initialBox) {
      throw new Error('Expected the composer textarea to have measurable geometry before typing')
    }

    await textarea.fill(multilineDraft)
    await expect(textarea).toHaveValue(multilineDraft)

    await expect
      .poll(async () => {
        const box = await textarea.boundingBox()
        return box?.height ?? 0
      })
      .toBeGreaterThan(initialBox.height + 24)

    const finalBox = await textarea.boundingBox()
    if (!finalBox) {
      throw new Error('Expected the composer textarea to have measurable geometry after typing')
    }

    expect(finalBox.height).toBeGreaterThan(initialBox.height + 24)

    const overflowMetrics = await textarea.evaluate((node) => {
      const textareaNode = node as HTMLTextAreaElement
      const computed = window.getComputedStyle(textareaNode)
      textareaNode.scrollTop = 0
      textareaNode.selectionStart = 0
      textareaNode.selectionEnd = 0

      return {
        clientHeight: textareaNode.clientHeight,
        scrollHeight: textareaNode.scrollHeight,
        overflowY: computed.overflowY,
      }
    })

    expect(Math.abs(overflowMetrics.scrollHeight - overflowMetrics.clientHeight)).toBeLessThanOrEqual(4)
    expect(['hidden', 'clip']).toContain(overflowMetrics.overflowY)

    await expect(composer).toHaveScreenshot(`composer-multiline-auto-height-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

test('structured Claude tool blocks stay compact across themes', async ({ page }) => {
  await mockAppApis(page, { state: createClaudeStructuredChatState() })
  await page.goto(appUrl)
  await page.locator('.structured-tool-card').first().waitFor()

  const toolGroup = page.locator('.structured-command-group').first()
  const summaryRow = toolGroup.locator('.structured-group-summary-row')
  const summaryText = summaryRow.locator('.structured-group-summary-text')
  const toolStack = toolGroup.locator('.structured-command-stack')
  const toolCard = toolGroup.locator('.structured-tool-card').first()
  const toolRow = toolCard.locator('.structured-command-inline-row')
  const toolLabel = toolCard.locator('.structured-command-label')
  const toolSummary = toolCard.locator('.structured-command-text')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await expect(toolGroup.locator('.structured-tool-card')).toHaveCount(3)
  await expect(toolGroup).toContainText('使用了 3 个工具')
  await expect(toolGroup).toContainText('搜索文本：游戏|玩法|设计|机制|循环')
  await expect(toolGroup).toContainText('读取 游戏设计 MOC.md')

  expect(await readComputedValue(summaryRow, 'padding-top')).toBe('0px')
  expect(await readComputedValue(summaryRow, 'padding-left')).toBe('0px')
  expect(await readComputedValue(toolStack, 'padding-left')).toBe('0px')
  expect(await readComputedValue(toolCard, 'border-top-width')).toBe('0px')
  expect(await readComputedValue(toolCard, 'padding-top')).toBe('0px')
  expect(Number.parseFloat(await readComputedValue(toolRow, 'padding-top'))).toBeLessThanOrEqual(3)
  expect(Number.parseFloat(await readComputedValue(toolRow, 'padding-left'))).toBeLessThanOrEqual(5)
  await expect(toolRow.locator('.structured-command-dot')).toHaveCount(0)
  expect(await readComputedValue(toolLabel, 'font-size')).toBe(await readComputedValue(toolSummary, 'font-size'))
  expect(await readComputedValue(toolLabel, 'font-family')).toBe(await readComputedValue(toolSummary, 'font-family'))
  expect(await readComputedValue(toolLabel, 'text-transform')).toBe('none')
  expect(Number.parseFloat(await readComputedValue(summaryText, 'font-size'))).toBeLessThanOrEqual(10.25)
  expect(Number.parseFloat(await readComputedValue(toolSummary, 'font-size'))).toBeLessThanOrEqual(10.75)
  expect(isTransparentColor(await readComputedValue(toolRow, 'background-color'))).toBeTruthy()

  await expect(toolGroup).toHaveScreenshot('structured-claude-tool-group-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect(toolGroup).toBeVisible()

  await expect(toolGroup).toHaveScreenshot('structured-claude-tool-group-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('structured todo cards stay readable across themes', async ({ page }) => {
  await mockAppApis(page, { state: createStructuredTodoState() })
  await page.goto(appUrl)
  await page.locator('.structured-todo-card').first().waitFor()

  const todoCard = page.locator('.structured-todo-card').first()
  const todoItems = todoCard.locator('.structured-todo-item')
  const completedItem = todoCard.locator('.structured-todo-item.is-completed').first()
  const completedTitle = todoCard.locator('.structured-todo-item.is-completed .structured-todo-title').first()
  const inProgressBadge = todoCard.locator('.structured-todo-item.is-in_progress .structured-todo-badge').first()
  const priorityBadge = todoCard.locator('.structured-todo-badge.is-priority.is-high').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()
  const pinCompletionFlashPreview = async () => {
    await page.evaluate(() => {
      const previewStyleId = 'structured-todo-flash-preview-style'
      document.getElementById(previewStyleId)?.remove()

      const target = document.querySelector('.structured-todo-item.is-completed')
      if (!(target instanceof HTMLElement)) {
        throw new Error('Expected a completed structured todo item for flash preview.')
      }

      target.classList.add('is-newly-completed')
      target.setAttribute('data-flash-preview', 'true')

      const style = document.createElement('style')
      style.id = previewStyleId
      style.textContent = `
        .structured-todo-item[data-flash-preview='true'],
        .structured-todo-item[data-flash-preview='true']::after,
        .structured-todo-item[data-flash-preview='true'] .structured-todo-status.is-completed,
        .structured-todo-item[data-flash-preview='true'] .structured-todo-badge.is-completed {
          animation-delay: -180ms !important;
          animation-play-state: paused !important;
        }
      `
      document.head.append(style)
    })
  }

  await expect(todoItems).toHaveCount(3)
  await expect(todoCard).toContainText('Tasks')
  await expect(todoCard).toContainText('1 of 3 completed')
  await expect(inProgressBadge).toContainText('In progress')
  await expect(priorityBadge).toContainText('High priority')
  expect(await readComputedValue(completedTitle, 'text-decoration-line')).toBe('line-through')

  await expect(todoCard).toHaveScreenshot('structured-todo-card-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await pinCompletionFlashPreview()
  await expect(completedItem).toHaveClass(/is-newly-completed/)
  await expect(completedItem).toHaveScreenshot('structured-todo-card-complete-flash-dark.png', {
    caret: 'hide',
  })

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect(todoCard).toBeVisible()
  await expect(todoCard).toHaveScreenshot('structured-todo-card-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await pinCompletionFlashPreview()
  await expect(completedItem).toHaveClass(/is-newly-completed/)
  await expect(completedItem).toHaveScreenshot('structured-todo-card-complete-flash-light.png', {
    caret: 'hide',
  })
})

test('changes summary cards keep file hierarchy readable across themes', async ({ page }) => {
  await mockAppApis(page, { state: createChangesSummaryState() })
  await page.goto(appUrl)
  await page.locator('.changes-summary-card').first().waitFor()

  const summaryCard = page.locator('.changes-summary-card').first()
  const firstFile = summaryCard.locator('.changes-summary-file').first()
  const firstFileName = firstFile.locator('.changes-summary-name')
  const firstDirectory = firstFile.locator('.changes-summary-path')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await expect(summaryCard).toContainText('共变更 3 个文件')
  await expect(firstFileName).toContainText('index.css')
  await expect(firstDirectory).toContainText('D:\\Git\\chill-vibe\\src')
  expect(await readComputedValue(firstFileName, 'font-family')).not.toBe(await readComputedValue(firstDirectory, 'font-family'))

  await expect(summaryCard).toHaveScreenshot('changes-summary-card-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await page.setViewportSize({ width: 440, height: 900 })
  await expect(summaryCard).toHaveScreenshot('changes-summary-card-dark-narrow.png', {
    animations: 'disabled',
    caret: 'hide',
  })
  await page.setViewportSize({ width: 1280, height: 720 })

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect(summaryCard).toBeVisible()
  await expect(summaryCard).toHaveScreenshot('changes-summary-card-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('structured edited-file blocks stay legible across themes', async ({ page }) => {
  await mockAppApis(page, { state: createEditedFilesStructuredState() })
  await page.goto(appUrl)
  await page.locator('.structured-edits-card').first().waitFor()

  const editsCard = page.locator('.structured-edits-card').first()
  const diffBlock = editsCard.locator('.structured-preview-text').first()
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await expect(editsCard).toContainText('Edited files')
  await expect(editsCard).toContainText('GitFullDialog.tsx')
  await expect(editsCard).toContainText('Modified')
  await expect(editsCard).toContainText('+1')
  await expect(editsCard).toContainText('-1')
  await expect(diffBlock.locator('.structured-inline-diff-row.is-added')).toHaveCount(1)
  await expect(diffBlock.locator('.structured-inline-diff-row.is-removed')).toHaveCount(1)

  const darkEditsBackground = await readComputedRgb(editsCard, 'background-color')
  const darkDiffBackground = await readComputedRgb(diffBlock, 'background-color')
  expect(maxChannel(darkEditsBackground)).toBeLessThan(90)
  expect(maxChannel(darkDiffBackground)).toBeLessThan(90)
  expect(lacksGreenCast(darkEditsBackground)).toBeTruthy()
  expect(lacksGreenCast(darkDiffBackground)).toBeTruthy()

  await expect(editsCard).toHaveScreenshot('structured-edits-card-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect(editsCard).toBeVisible()

  const lightEditsBackground = await readComputedRgb(editsCard, 'background-color')
  const lightDiffBackground = await readComputedRgb(diffBlock, 'background-color')
  expect(maxChannel(lightEditsBackground)).toBeGreaterThan(180)
  expect(maxChannel(lightDiffBackground)).toBeGreaterThan(180)

  await expect(editsCard).toHaveScreenshot('structured-edits-card-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('structured edited-file overflow actions stay quiet across themes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await mockAppApis(page, { state: createOverflowEditedFilesStructuredState() })
  await page.goto(appUrl)
  await page.locator('.structured-edits-card').first().waitFor()

  const editsCard = page.locator('.structured-edits-card').first()
  const preview = editsCard.locator('.structured-preview-text').first()
  const viewDetailsButton = editsCard.locator('.structured-preview-footer .structured-preview-trigger')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  await expect(editsCard).toContainText('已编辑文件')
  await expect(editsCard).toContainText('BazEffectGuaranteedPatchedItemOnShopRefreshPerRound.cs.meta')
  await expect(editsCard).toContainText('新增')
  await expect(editsCard).toContainText('+11')
  await expect(preview).not.toContainText('new file mode')
  await expect(viewDetailsButton).toBeVisible()
  await expect(viewDetailsButton).toHaveText('查看全部')

  await expect(editsCard).toHaveScreenshot('structured-edits-card-overflow-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect(viewDetailsButton).toBeVisible()
  await expect(editsCard).toHaveScreenshot('structured-edits-card-overflow-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('edited-file preview shows only changed lines, not diff headers', async ({ page }) => {
  await mockAppApis(page, { state: createEditedFilesStructuredState() })
  await page.goto(appUrl)
  await page.locator('.structured-edits-card').first().waitFor()

  const preview = page
    .locator('.structured-edits-card')
    .first()
    .locator('.structured-preview-text')
    .first()

  await expect(preview).not.toContainText('diff --git')
  await expect(preview).not.toContainText('index ')
  await expect(preview).not.toContainText('--- a/')
  await expect(preview).not.toContainText('+++ b/')
  await expect(preview).not.toContainText('@@')
  await expect(preview).toContainText('autoStagePaths.length > 0')
  await expect(preview).toContainText("mode === 'incremental'")
})

test('structured overflow previews stay compact and open detail dialogs across themes', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 })
  await mockAppApis(page, { state: createOverflowStructuredState() })
  await page.goto(appUrl)
  await page.locator('.structured-preview-shell').first().waitFor()

  const previewShells = page.locator('.structured-preview-shell')
  const firstPreview = page.locator('.structured-reasoning-card').first().locator('.structured-preview-text')
  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()
  const siblingCard = page.locator('.workspace-column').nth(1).locator('.card-shell').first()

  const expectDialogToCoverSiblingCards = async () => {
    const dialogBounds = await readRect(dialogCard)
    const siblingBounds = await readRect(siblingCard)
    const overlapLeft = Math.max(dialogBounds.left, siblingBounds.left)
    const overlapRight = Math.min(dialogBounds.right, siblingBounds.right)
    const overlapTop = Math.max(dialogBounds.top, siblingBounds.top)
    const overlapBottom = Math.min(dialogBounds.bottom, siblingBounds.bottom)
    const overlapWidth = overlapRight - overlapLeft
    const overlapHeight = overlapBottom - overlapTop

    expect(overlapWidth).toBeGreaterThan(40)
    expect(overlapHeight).toBeGreaterThan(40)

    const hit = await readHitTarget(
      page,
      overlapLeft + overlapWidth / 2,
      overlapTop + overlapHeight / 2,
    )

    expect(
      hit.insideDialog,
      `Expected dialog to own the overlap point, but hit "${hit.className}" with text "${hit.text}".`,
    ).toBeTruthy()
  }

  await expect(previewShells).toHaveCount(2)
  const darkPreviewHeight = await firstPreview.evaluate((node) => node.getBoundingClientRect().height)
  expect(darkPreviewHeight).toBeLessThan(110)

  const darkPreviewBackground = await readComputedRgb(firstPreview, 'background-color')
  expect(maxChannel(darkPreviewBackground)).toBeLessThan(90)
  expect(lacksGreenCast(darkPreviewBackground)).toBeTruthy()

  await previewShells.first().click()

  const dialog = page.getByRole('dialog')
  const dialogCard = dialog.locator('.structured-preview-card')

  await expect(dialog).toContainText('Step 6 confirms the light theme surface.')
  const darkDialogBackground = await readComputedRgb(dialogCard, 'background-color')
  expect(maxChannel(darkDialogBackground)).toBeLessThan(90)
  expect(lacksGreenCast(darkDialogBackground)).toBeTruthy()
  await expectDialogToCoverSiblingCards()

  await dialog.getByRole('button', { name: 'Close details' }).click()
  await expect(dialog).toBeHidden()

  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  await expect(previewShells.first()).toBeVisible()

  await previewShells.first().click()
  await expect(dialog).toContainText('Step 6 confirms the light theme surface.')
  const lightDialogBackground = await readComputedRgb(dialogCard, 'background-color')
  expect(maxChannel(lightDialogBackground)).toBeGreaterThan(180)
  await expectDialogToCoverSiblingCards()

  await page.setViewportSize({ width: 390, height: 844 })
  const dialogRect = await readRect(dialogCard)
  expect(dialogRect.width).toBeLessThan(370)
})

for (const theme of ['dark', 'light'] as const) {
  test(`pane-mounted chat tabs keep the composer docked to the bottom in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 })

    const state = createPaneTabsState(theme)
    await mockAppApis(page, { state })
    await page.goto(appUrl)

    const paneView = page.locator('.pane-view').first()
    const paneContent = paneView.locator('.pane-content')
    const activePanePanel = paneView.locator('.pane-content > .pane-tab-panel.is-active')
    const cardShell = activePanePanel.locator('.card-shell').first()
    const messageList = activePanePanel.locator('.message-list').first()
    const composer = activePanePanel.locator('.composer').first()
    const composerTextarea = composer.locator('textarea')

    await expect(activePanePanel).toBeVisible()
    await expect(composerTextarea).toBeVisible()

    const [paneRect, panelRect, cardRect, messageRect, composerRect] = await Promise.all([
      readRect(paneContent),
      readRect(activePanePanel),
      readRect(cardShell),
      readRect(messageList),
      readRect(composer),
    ])

    expect(Math.abs(paneRect.height - panelRect.height)).toBeLessThanOrEqual(2)
    expect(Math.abs(panelRect.height - cardRect.height)).toBeLessThanOrEqual(2)
    expect(messageRect.height).toBeGreaterThan(cardRect.height * 0.4)
    expect(messageRect.bottom).toBeLessThanOrEqual(composerRect.top + 1)
    expect(cardRect.bottom - composerRect.bottom).toBeLessThanOrEqual(16)
  })

  test(`pane tabs keep split surfaces legible in ${theme} theme`, async ({ page }) => {
    const state = createPaneTabsState(theme)

    await installMockElectronBridge(page)
    await page.addInitScript(({ mockState, providers }) => {
      let currentState = mockState

      if (!window.electronAPI) {
        return
      }

      window.electronAPI.fetchState = async () => currentState
      window.electronAPI.saveState = async (nextState) => {
        currentState = nextState
        return nextState
      }
      window.electronAPI.queueStateSave = () => undefined
      window.electronAPI.fetchProviders = async () => providers
    }, {
      mockState: state,
      providers: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })

    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto(appUrl)

    const splitContainer = page.locator('.split-container').first()
    const tabBar = page.locator('.pane-tab-bar').first()
    const tabStrip = tabBar.locator('.pane-tab-strip')
    const activeTab = page.locator('.pane-tab.is-active').first()
    const inactiveTab = page.locator('.pane-tab').nth(1)
    const inactiveStreamingTab = tabBar.locator('.pane-tab.is-streaming:not(.is-active)')
    const activeTabClose = activeTab.locator('.pane-tab-close')
    const inactiveTabClose = inactiveTab.locator('.pane-tab-close')
    const resizeHandle = page.locator('.split-resize-handle').first()
    const embeddedComposerSelects = page.locator('.split-container .card-shell.is-pane-embedded .composer-input-row .model-select-shell')
    const embeddedTitles = page.locator('.split-container .card-shell.is-pane-embedded .card-title')
    const embeddedCloseButtons = page.locator('.split-container .card-shell.is-pane-embedded .card-close-button')

    await expect(splitContainer).toBeVisible()
    await expect(page.locator('.pane-view')).toHaveCount(2)
    await expect(tabBar).toContainText('Feature chat')
    await expect(tabBar).toContainText('Review')
    await expect(inactiveStreamingTab).toHaveCount(1)
    await expect(page.locator('.pane-tab-status.is-streaming')).toHaveCount(0)
    await expect(resizeHandle).toBeVisible()
    await expect(activeTab).toBeVisible()
    await expect(inactiveTab).toBeVisible()
    await expect(activeTabClose).toBeVisible()
    await expect(embeddedComposerSelects).toHaveCount(2)
    await expect(embeddedTitles).toHaveCount(0)
    await expect(embeddedCloseButtons).toHaveCount(0)

    expect(await readComputedValue(resizeHandle, 'width')).toBe('4px')
    expect(await readComputedValue(tabBar, 'overflow-x')).toBe('hidden')
    expect(await readComputedValue(tabStrip, 'overflow-x')).toBe('hidden')
    expect(await readComputedValue(inactiveStreamingTab, 'animation-name')).toContain('pane-tab-streaming-border-breathe')
    expect(Number(await readComputedValue(activeTabClose, 'opacity'))).toBeGreaterThan(0.9)
    expect(Number(await readComputedValue(inactiveTabClose, 'opacity'))).toBeLessThan(0.1)
    expect(
      isTransparentColor(await readComputedValue(tabBar, 'background-color')),
      `pane tab bar should remain visible in ${theme} theme`,
    ).toBeFalsy()

    await expect(splitContainer).toHaveScreenshot(`pane-split-layout-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`hovered pane group owns the active tab accent in ${theme} theme`, async ({ page }) => {
    const state = createPaneTabsState(theme)

    await installMockElectronBridge(page)
    await page.addInitScript(({ mockState, providers }) => {
      let currentState = mockState

      if (!window.electronAPI) {
        return
      }

      window.electronAPI.fetchState = async () => currentState
      window.electronAPI.saveState = async (nextState) => {
        currentState = nextState
        return nextState
      }
      window.electronAPI.queueStateSave = () => undefined
      window.electronAPI.fetchProviders = async () => providers
    }, {
      mockState: state,
      providers: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })

    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto(appUrl)

    const leftPane = page.locator('.pane-view').first()
    const rightPane = page.locator('.pane-view').nth(1)
    const leftActiveTab = leftPane.locator('.pane-tab.is-active')
    const rightActiveTab = rightPane.locator('.pane-tab.is-active')

    await expect(leftActiveTab).toContainText('Feature chat')
    await expect(rightActiveTab).toContainText('Notes')

    await leftPane.hover()

    const leftHovered = {
      left: await readComputedValue(leftActiveTab, 'box-shadow'),
      right: await readComputedValue(rightActiveTab, 'box-shadow'),
    }

    expect(leftHovered.left).not.toBe(leftHovered.right)

    await rightPane.hover()

    const rightHovered = {
      left: await readComputedValue(leftActiveTab, 'box-shadow'),
      right: await readComputedValue(rightActiveTab, 'box-shadow'),
    }

    expect(rightHovered.left).not.toBe(rightHovered.right)
    expect(leftHovered.left).toBe(rightHovered.right)
    expect(leftHovered.right).toBe(rightHovered.left)

    await leftPane.hover()
    await expect(page.locator('.split-container').first()).toHaveScreenshot(`pane-tab-hovered-group-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`active streaming pane tab keeps the warm running emphasis in ${theme} theme`, async ({ page }) => {
    const state = createActiveStreamingPaneTabsState(theme)

    await mockAppApis(page, { state })
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto(appUrl)

    const tabBar = page.locator('.pane-tab-bar').first()
    const activeStreamingTab = tabBar.locator('.pane-tab.is-active.is-streaming')

    await expect(activeStreamingTab).toContainText('Review')
    await expect(activeStreamingTab.locator('.pane-tab-status.is-streaming')).toHaveCount(0)
    await expect(tabBar).toHaveScreenshot(`pane-tab-active-streaming-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`active trailing pane tab suppresses adjacent dividers in ${theme} theme`, async ({ page }) => {
    const state = createTrailingActivePaneTabsState(theme)

    await installMockElectronBridge(page)
    await page.addInitScript(({ mockState, providers }) => {
      let currentState = mockState

      if (!window.electronAPI) {
        return
      }

      window.electronAPI.fetchState = async () => currentState
      window.electronAPI.saveState = async (nextState) => {
        currentState = nextState
        return nextState
      }
      window.electronAPI.queueStateSave = () => undefined
      window.electronAPI.fetchProviders = async () => providers
    }, {
      mockState: state,
      providers: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })

    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto(appUrl)

    const tabBar = page.locator('.pane-tab-bar').first()
    const tabStrip = tabBar.locator('.pane-tab-strip')
    const activeTab = tabBar.locator('.pane-tab.is-active')
    const tabs = tabBar.locator('.pane-tab')

    await expect(activeTab).toContainText('Review')

    const [stripRect, tabWidths] = await Promise.all([
      readRect(tabStrip),
      tabs.evaluateAll((nodes) =>
        nodes.map((node) => ({
          width: node.getBoundingClientRect().width,
        })),
      ),
    ])

    const totalTabWidth = tabWidths.reduce((sum, tab) => sum + tab.width, 0)
    expect(totalTabWidth).toBeLessThan(stripRect.width - 8)

    await expect(tabBar).toHaveScreenshot(`pane-tab-bar-trailing-active-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`single-pane chat keeps the title in tab chrome only in ${theme} theme`, async ({ page }) => {
    const state = createSinglePaneChromeState(theme)

    await installMockElectronBridge(page)
    await page.addInitScript(({ mockState, providers }) => {
      let currentState = mockState

      if (!window.electronAPI) {
        return
      }

      window.electronAPI.fetchState = async () => currentState
      window.electronAPI.saveState = async (nextState) => {
        currentState = nextState
        return nextState
      }
      window.electronAPI.queueStateSave = () => undefined
      window.electronAPI.fetchProviders = async () => providers
    }, {
      mockState: state,
      providers: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })

    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto(appUrl)

    const paneView = page.locator('.pane-view').first()
    const tabBar = paneView.locator('.pane-tab-bar')
    const contentHeader = paneView.locator('.pane-content .card-header')
    const composerModelSelect = paneView.locator('.pane-content .composer-input-row .model-select-shell').first()
    const duplicatedTitle = paneView.locator('.pane-content .card-title')

    await expect(tabBar).toContainText('新会话')
    await expect(contentHeader).toHaveCount(0)
    await expect(composerModelSelect).toContainText(/GPT-5\.4/i)
    await expect(duplicatedTitle).toHaveCount(0)
    await expect(paneView).toHaveScreenshot(`pane-single-tab-chrome-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`pane tabs shrink before requiring horizontal panning in ${theme} theme`, async ({ page }) => {
    const state = createShrinkingPaneTabsState(theme)

    await installMockElectronBridge(page)
    await page.addInitScript(({ mockState, providers }) => {
      let currentState = mockState

      if (!window.electronAPI) {
        return
      }

      window.electronAPI.fetchState = async () => currentState
      window.electronAPI.saveState = async (nextState) => {
        currentState = nextState
        return nextState
      }
      window.electronAPI.queueStateSave = () => undefined
      window.electronAPI.fetchProviders = async () => providers
    }, {
      mockState: state,
      providers: [
        { provider: 'codex', available: true, command: 'codex' },
        { provider: 'claude', available: true, command: 'claude' },
      ],
    })

    await page.setViewportSize({ width: 1280, height: 820 })
    await page.goto(appUrl)

    const tabBar = page.locator('.pane-tab-bar').first()
    const tabStrip = tabBar.locator('.pane-tab-strip')
    await expect(tabStrip.locator('.pane-tab')).toHaveCount(4)

    const dimensions = await tabStrip.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }))

    expect(dimensions.scrollWidth - dimensions.clientWidth).toBeLessThanOrEqual(1)

    await expect(tabBar).toHaveScreenshot(`pane-tab-bar-shrink-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

test('chat panes keep the composer visible and editable after pane chrome compaction', async ({ page }) => {
  const state = createPaneTabsState('dark')

  await installMockElectronBridge(page)
  await page.addInitScript(({ mockState, providers }) => {
    let currentState = mockState

    if (!window.electronAPI) {
      return
    }

    window.electronAPI.fetchState = async () => currentState
    window.electronAPI.saveState = async (nextState) => {
      currentState = nextState
      return nextState
    }
    window.electronAPI.queueStateSave = () => undefined
    window.electronAPI.fetchProviders = async () => providers
  }, {
    mockState: state,
    providers: [
      { provider: 'codex', available: true, command: 'codex' },
      { provider: 'claude', available: true, command: 'claude' },
    ],
  })

  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto(appUrl)

  const activePane = page.locator('.pane-view').first()
  const composerTextarea = activePane.locator('.pane-content > .pane-tab-panel.is-active .composer textarea')

  await expect(composerTextarea).toBeVisible()
  await expect(composerTextarea).toBeEnabled()

  await composerTextarea.click()
  await expect(composerTextarea).toBeFocused()
  await composerTextarea.fill('hello from pane composer')
  await expect(composerTextarea).toHaveValue('hello from pane composer')
})

test('middle-clicking a pane tab closes it and promotes the next tab', async ({ page }) => {
  const state = createPaneTabsState('dark')

  await installMockElectronBridge(page)
  await page.addInitScript(({ mockState, providers }) => {
    let currentState = mockState

    if (!window.electronAPI) {
      return
    }

    window.electronAPI.fetchState = async () => currentState
    window.electronAPI.saveState = async (nextState) => {
      currentState = nextState
      return nextState
    }
    window.electronAPI.queueStateSave = () => undefined
    window.electronAPI.fetchProviders = async () => providers
  }, {
    mockState: state,
    providers: [
      { provider: 'codex', available: true, command: 'codex' },
      { provider: 'claude', available: true, command: 'claude' },
    ],
  })

  await page.setViewportSize({ width: 1280, height: 820 })
  await page.goto(appUrl)

  const leftPane = page.locator('.pane-view').first()
  const featureTab = leftPane.locator('.pane-tab', { hasText: 'Feature chat' })
  const reviewTab = leftPane.locator('.pane-tab', { hasText: 'Review' })

  await expect(featureTab).toHaveClass(/is-active/)
  await expect(reviewTab).toBeVisible()

  await featureTab.click({ button: 'middle' })

  await expect(featureTab).toHaveCount(0)
  await expect(reviewTab).toHaveClass(/is-active/)
  await expect(page.locator('.pane-tab')).toHaveCount(2)
})

for (const theme of ['dark', 'light'] as const) {
  test(`first-open guide stays legible in ${theme} theme`, async ({ page }) => {
    await installMockElectronBridge(page)

    const state = createDefaultState('d:\\Git\\chill-vibe', 'zh-CN')
    state.settings.theme = theme

    await page.addInitScript(() => {
      window.localStorage.removeItem('chill-vibe:onboarding:v1')
    })

    await page.route('**/api/state', async (route) => {
      const request = route.request()

      if (request.method() === 'GET') {
        await route.fulfill({ json: state })
        return
      }

      if (request.method() === 'PUT') {
        await route.fulfill({ json: state })
        return
      }

      await route.fallback()
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
          state: 'success',
          message: 'Environment setup completed.',
          logs: [],
        },
      })
    })

    await page.route('**/api/onboarding/status', async (route) => {
      await route.fulfill({
        json: {
          environment: {
            ready: true,
            checks: [
              { id: 'git', label: 'Git', available: true },
              { id: 'node', label: 'Node.js', available: true },
              { id: 'claude', label: 'Claude CLI', available: true },
              { id: 'codex', label: 'Codex CLI', available: true },
            ],
          },
          ccSwitch: {
            available: true,
            source: '~/.cc-switch/cc-switch.db',
          },
        },
      })
    })

    await page.goto(appUrl)

    const guide = page.getByRole('dialog')
    const card = page.locator('.onboarding-card')
    const zhChip = page.locator('#wizard-language-zh')
    const enChip = page.locator('#wizard-language-en')

    await expect(guide).toBeVisible()

    const cardBackground = await readComputedRgb(card, 'background-color')
    const zhBackground = await readComputedRgb(zhChip, 'background-color')
    const enBackground = await readComputedRgb(enChip, 'background-color')

    expect(isBlueTint(zhBackground)).toBeTruthy()
    expect(zhBackground).not.toEqual(enBackground)

    if (theme === 'dark') {
      expect(maxChannel(cardBackground)).toBeLessThan(90)
      expect(maxChannel(enBackground)).toBeLessThan(100)
    } else {
      expect(maxChannel(cardBackground)).toBeGreaterThan(185)
      expect(maxChannel(enBackground)).toBeGreaterThan(160)
    }
  })
}

test('git tool card stays legible across themes and exposes local changes', async ({ page }) => {
  const state = createMockState()
  state.settings.language = 'en'
  state.columns[0]!.cards[0] = {
    ...state.columns[0]!.cards[0]!,
    title: 'Git changes',
    provider: 'codex',
    model: '__git_tool__',
    reasoningEffort: 'medium',
  }

  await mockAppApis(page, { state })
  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({
      json: {
        workspacePath: 'd:\\Git\\chill-vibe',
        isRepository: true,
        repoRoot: 'd:\\Git\\chill-vibe',
        branch: 'feature/git-tool-card',
        upstream: 'origin/main',
        ahead: 2,
        behind: 1,
        hasConflicts: false,
        clean: false,
        summary: {
          staged: 1,
          unstaged: 1,
          untracked: 1,
          conflicted: 0,
        },
        changes: [
          {
            path: 'src/App.tsx',
            kind: 'modified',
            stagedStatus: 'M',
            workingTreeStatus: ' ',
            staged: true,
            conflicted: false,
            addedLines: 1,
            removedLines: 1,
            patch: '@@ -1,1 +1,1 @@\n-const oldValue = true\n+const nextValue = true',
          },
          {
            path: 'src/index.css',
            kind: 'modified',
            stagedStatus: ' ',
            workingTreeStatus: 'M',
            staged: false,
            conflicted: false,
            addedLines: 2,
            removedLines: 0,
            patch: '@@ -40,0 +41,2 @@\n+.git-card { display: grid; }\n+.git-card { gap: 8px; }',
          },
          {
            path: 'notes/todo.md',
            kind: 'untracked',
            stagedStatus: '?',
            workingTreeStatus: '?',
            staged: false,
            conflicted: false,
            addedLines: 1,
            removedLines: 0,
            patch: '@@ -0,0 +1,1 @@\n+Ship the GitHub Desktop-style review pane',
          },
        ],
        lastCommit: {
          hash: 'abc1234def5678',
          shortHash: 'abc1234',
          summary: 'Refine board chrome',
          description: '',
          authorName: 'Alex',
          authoredAt: '2026-04-05T03:00:00.000Z',
        },
      },
    })
  })

  await page.goto(appUrl)

  const gitToolCard = page.locator('.git-tool-card').first()
  const gitHeaderInfo = page.locator('.git-header-info').first()
  const gitActionsBar = page.locator('.git-dashboard-actions-bar').first()
  const fullGitButton = page.getByRole('button', { name: 'Full Git' })

  await expect(gitToolCard).toBeVisible()
  await expect(gitHeaderInfo).toBeVisible()
  await expect(page.getByText('feature/git-tool-card')).toBeVisible()
  await expect(gitActionsBar).toBeVisible()
  await expect(page.locator('.git-dashboard-summary-count')).toContainText('3')
  await expect(page.getByRole('button', { name: 'Analyze changes' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Commit new' })).toBeVisible()
  await expect(fullGitButton).toBeVisible()
  await expect(page.locator('.reasoning-select')).toHaveCount(0)

  const darkCardBackground = await readComputedRgb(gitToolCard, 'background-color')

  expect(maxChannel(darkCardBackground)).toBeLessThan(90)
  expect(lacksGreenCast(darkCardBackground)).toBeTruthy()

  await fullGitButton.click()
  const fullDialog = page.locator('.structured-preview-dialog.is-git-full')
  const fullDialogCard = page.locator('.structured-preview-card').first()
  await expect(fullDialog).toBeVisible()
  await expect(page.locator('.git-change-row')).toHaveCount(3)

  const darkDialogBackground = await readComputedRgb(fullDialogCard, 'background-color')
  expect(maxChannel(darkDialogBackground)).toBeLessThan(90)
  expect(lacksGreenCast(darkDialogBackground)).toBeTruthy()

  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(fullDialog).toBeHidden()

  await page.locator('#app-tab-settings').click()
  await page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first().click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.locator('#app-tab-ambience').click()

  await expect(gitToolCard).toBeVisible()

  const lightCardBackground = await readComputedRgb(gitToolCard, 'background-color')

  expect(maxChannel(lightCardBackground)).toBeGreaterThan(190)

  await fullGitButton.click()
  await expect(fullDialog).toBeVisible()
  await expect(page.locator('.git-change-row')).toHaveCount(3)

  const lightDialogBackground = await readComputedRgb(fullDialogCard, 'background-color')
  expect(maxChannel(lightDialogBackground)).toBeGreaterThan(180)
})

for (const theme of ['dark', 'light'] as const) {
  test(`git sync blocked-files confirmation keeps a visible panel surface in ${theme} theme`, async ({ page }) => {
    const state = createMockState()
    state.settings.language = 'en'
    state.settings.theme = theme
    state.columns[0]!.cards[0] = {
      ...state.columns[0]!.cards[0]!,
      title: 'Git changes',
      provider: 'codex',
      model: '__git_tool__',
      reasoningEffort: 'medium',
    }

    const gitStatus = {
      workspacePath: 'd:\\Git\\chill-vibe',
      isRepository: true,
      repoRoot: 'd:\\Git\\chill-vibe',
      branch: 'feature/git-sync-surface',
      upstream: 'origin/main',
      ahead: 1,
      behind: 2,
      hasConflicts: false,
      clean: false,
      summary: {
        staged: 1,
        unstaged: 1,
        untracked: 0,
        conflicted: 0,
      },
      changes: [
        {
          path: 'src/components/GitToolCard.tsx',
          kind: 'modified',
          stagedStatus: 'M',
          workingTreeStatus: ' ',
          staged: true,
          conflicted: false,
          addedLines: 3,
          removedLines: 1,
          patch: '@@ -490,3 +490,5 @@\n-<div className="git-agent-panel-shell">\n+<div className="git-agent-panel-shell">',
        },
        {
          path: 'src/index.css',
          kind: 'modified',
          stagedStatus: ' ',
          workingTreeStatus: 'M',
          staged: false,
          conflicted: false,
          addedLines: 1,
          removedLines: 0,
          patch: '@@ -7278,0 +7279,1 @@\n+.git-agent-panel { background: var(--panel); }',
        },
      ],
      lastCommit: {
        hash: 'def5678abc1234',
        shortHash: 'def5678',
        summary: 'Polish sync confirmation bubble',
        description: '',
        authorName: 'Alex',
        authoredAt: '2026-04-05T03:00:00.000Z',
      },
    }

    await mockAppApis(page, { state })
    await page.route('**/api/git/status?workspacePath=*', async (route) => {
      await route.fulfill({ json: gitStatus })
    })
    await page.route('**/api/git/pull', async (route) => {
      await route.fulfill({
        json: {
          status: gitStatus,
          blockedFiles: ['src/components/GitToolCard.tsx', 'src/index.css'],
        },
      })
    })

    await page.goto(appUrl)

    const gitToolCard = page.locator('.git-tool-card').first()
    await expect(gitToolCard).toBeVisible()

    await page.getByRole('button', { name: 'Sync' }).click()

    const blockedPanel = page.locator('.git-agent-panel-shell .git-agent-panel')
    await expect(blockedPanel).toBeVisible()
    await expect(blockedPanel).toContainText('2 local file(s) conflict with incoming remote changes')
    await expect(blockedPanel).toContainText('src/components/GitToolCard.tsx')
    await expect(blockedPanel).toContainText('src/index.css')

    const blockedPanelBackground = await readComputedRgb(blockedPanel, 'background-color')

    if (theme === 'dark') {
      expect(maxChannel(blockedPanelBackground)).toBeLessThan(90)
      expect(lacksGreenCast(blockedPanelBackground)).toBeTruthy()
    } else {
      expect(maxChannel(blockedPanelBackground)).toBeGreaterThan(180)
    }

    await expect(blockedPanel).toHaveScreenshot(`git-sync-blocked-confirm-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`git tool dashboard keeps its summary readable while actions stay top-aligned in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 980 })

    const state = createMockState()
    state.settings.language = 'en'
    state.settings.theme = theme
    let gitStatusRequests = 0

    await mockAppApis(page, { state })
    await page.route('**/api/git/status?workspacePath=*', async (route) => {
      gitStatusRequests += 1
      await route.fulfill({
        json: {
          workspacePath: 'd:\\Git\\chill-vibe',
          isRepository: true,
          repoRoot: 'd:\\Git\\chill-vibe',
          branch: 'feature/git-half-height',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          hasConflicts: false,
          clean: false,
          summary: {
            staged: 1,
            unstaged: 1,
            untracked: 0,
            conflicted: 0,
          },
          changes: [
            {
              path: 'src/components/GitToolCard.tsx',
              kind: 'modified',
              stagedStatus: 'M',
              workingTreeStatus: ' ',
              staged: true,
              conflicted: false,
              addedLines: 5,
              removedLines: 2,
              patch: '@@ -30,3 +30,6 @@\n-const compactHeight = 133\n+const compactHeight = 80',
            },
            {
              path: 'src/index.css',
              kind: 'modified',
              stagedStatus: ' ',
              workingTreeStatus: 'M',
              staged: false,
              conflicted: false,
              addedLines: 1,
              removedLines: 1,
              patch: '@@ -5154,1 +5154,1 @@\n-min-height: 133px;\n+min-height: 80px;',
            },
          ],
          lastCommit: {
            hash: 'abc1234def5678',
            shortHash: 'abc1234',
            summary: 'Compact the Git card',
            description: '',
            authorName: 'Alex',
            authoredAt: '2026-04-07T03:00:00.000Z',
          },
        },
      })
    })

    await page.goto(appUrl)

    const gitToolCard = page.locator('.git-tool-card').first()
    const gitCardShell = page.locator('.card-shell').first()
    const paneContent = page.locator('.pane-content').first()
    const summaryTop = page.locator('.git-dashboard-summary-top').first()
    const fileList = page.locator('.git-dashboard-file-list').first()
    const actionBar = page.locator('.git-dashboard-actions-bar').first()
    const gitQuickTool = page.getByRole('list', { name: 'Quick tool cards' }).getByRole('button', { name: /Git/ }).first()

    await gitQuickTool.click()
    await expect(gitToolCard).toBeVisible()
    await expect.poll(() => gitStatusRequests).toBeGreaterThan(0)
    await expect(gitCardShell).toBeVisible()
    await expect(summaryTop).toBeVisible()
    await expect(fileList).toBeVisible()
    await expect(actionBar).toBeVisible()
    await expect(actionBar.getByRole('button', { name: 'Analyze changes' })).toBeVisible()
    await expect(actionBar.getByRole('button', { name: 'Sync' })).toBeVisible()
    await expect(actionBar.getByRole('button', { name: 'Full Git' })).toBeVisible()

    const [paneRect, cardRect, summaryRect, fileListRect, actionBarRect] = await Promise.all([
      readRect(paneContent),
      readRect(gitCardShell),
      readRect(summaryTop),
      readRect(fileList),
      readRect(actionBar),
    ])

    expect(Math.abs(cardRect.height - paneRect.height)).toBeLessThanOrEqual(2)
    expect(actionBarRect.height).toBeLessThan(76)
    expect(Math.abs(actionBarRect.top - summaryRect.top)).toBeLessThanOrEqual(20)
    expect(actionBarRect.right).toBeLessThanOrEqual(cardRect.right + 2)
    expect(fileListRect.top).toBeGreaterThanOrEqual(summaryRect.bottom - 1)
    expect(fileListRect.bottom).toBeLessThanOrEqual(cardRect.bottom + 2)

    await expect(gitCardShell).toHaveScreenshot(`git-tool-card-compact-default-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`git tool keeps a tall clean-state card pinned to the top in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1320 })

    const state = createMockState()
    state.settings.language = 'zh-CN'
    state.settings.theme = theme
    state.columns[0]!.width = 560
    state.columns[0]!.cards[0] = {
      ...state.columns[0]!.cards[0]!,
      title: 'Git clean state',
      provider: 'codex',
      model: GIT_TOOL_MODEL,
      reasoningEffort: 'medium',
      size: 920,
    }

    await mockAppApis(page, { state })
    await page.route('**/api/git/status?workspacePath=*', async (route) => {
      await route.fulfill({
        json: {
          workspacePath: 'd:\\Git\\chill-vibe',
          isRepository: true,
          repoRoot: 'd:\\Git\\chill-vibe',
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          hasConflicts: false,
          clean: true,
          summary: {
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
          },
          changes: [],
          lastCommit: {
            hash: '18f0f7a1e04f50',
            shortHash: '18f0f7a',
            summary: 'Keep clean states pinned to the top',
            description: '',
            authorName: 'Alex',
            authoredAt: '2026-04-08T10:00:00.000Z',
          },
        },
      })
    })

    await page.goto(appUrl)

    const gitCardShell = page.locator('.card-shell').first()
    const gitToolCard = page.locator('.git-tool-card').first()
    const emptyState = page.locator('.git-dashboard-empty').first()
    const cleanLabel = emptyState.locator('span').first()

    await expect(gitCardShell).toBeVisible()
    await expect(emptyState).toContainText('工作区已干净')

    const [cardRect, labelRect] = await Promise.all([readRect(gitToolCard), readRect(cleanLabel)])

    expect(labelRect.top - cardRect.top).toBeLessThan(40)
    expect(cardRect.bottom - labelRect.bottom).toBeGreaterThan(240)

    await expect(gitCardShell).toHaveScreenshot(`git-tool-clean-state-top-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`git tool keeps changed files at a readable line height and scrolls overflow in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 960 })

    const state = createMockState()
    state.settings.language = 'zh-CN'
    state.settings.theme = theme
    state.columns[0]!.width = 520
    const gitCard = {
      ...state.columns[0]!.cards[0]!,
      id: 'git-overflow-card',
      title: 'Git overflow',
      provider: 'codex',
      model: GIT_TOOL_MODEL,
      reasoningEffort: 'medium',
      size: 320,
    }
    const chatCard = {
      ...state.columns[0]!.cards[0]!,
      id: 'chat-below-card',
      title: 'Below chat',
      provider: 'claude',
      model: 'claude-opus-4-6',
      reasoningEffort: 'medium',
      size: 300,
      draft: 'Keep the lower pane mounted while the Git card overflows.',
      messages: [],
    }

    configureColumnCardsAndLayout(
      state,
      [gitCard, chatCard],
      createSplit(
        'vertical',
        [
          createPane(['git-overflow-card'], 'git-overflow-card', 'pane-git-overflow'),
          createPane(['chat-below-card'], 'chat-below-card', 'pane-chat-below'),
        ],
        [0.44, 0.56],
        'git-overflow-split',
      ),
    )

    const overflowPaths = [
      'src/components/ChatCard.tsx',
      'src/index.css',
      'tests/auto-urge.spec.ts',
      'tests/git-tool-switch.spec.ts',
      'tests/git-workspace.test.ts',
      'tests/theme-check.spec.ts',
      'tests/theme-check.spec.ts-snapshots/git-tool-clean-state-top-dark-win32.png',
      'tests/theme-check.spec.ts-snapshots/git-tool-clean-state-top-light-win32.png',
      'docs/ui-principles.md',
      'notes/git-card-followup.md',
      'notes/review/2026-04-09-git-overflow.md',
      'shared/schema.ts',
      'src/components/GitToolCard.tsx',
      'src/components/GitAgentPanel.tsx',
      'src/components/GitFullDialog.tsx',
      'src/components/GitDiffPreview.tsx',
      'server/git-workspace.ts',
      'build/icon.png',
    ]

    await mockAppApis(page, { state })
    await page.route('**/api/git/status?workspacePath=*', async (route) => {
      await route.fulfill({
        json: {
          workspacePath: 'd:\\Git\\chill-vibe',
          isRepository: true,
          repoRoot: 'd:\\Git\\chill-vibe',
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          hasConflicts: false,
          clean: false,
          summary: {
            staged: 3,
            unstaged: 13,
            untracked: 2,
            conflicted: 0,
          },
          changes: overflowPaths.map((path, index) => ({
            path,
            kind: index >= 16 ? 'untracked' : 'modified',
            stagedStatus: index < 3 ? 'M' : index >= 16 ? '?' : ' ',
            workingTreeStatus: index < 3 ? ' ' : index >= 16 ? '?' : 'M',
            staged: index < 3,
            conflicted: false,
            addedLines: index + 1,
            removedLines: index % 3,
            patch: `@@ -0,0 +1,1 @@\n+Track overflow row ${index + 1}`,
          })),
          lastCommit: {
            hash: '18f0f7a1e04f50',
            shortHash: '18f0f7a',
            summary: 'Prefer scrolling long Git file lists',
            description: '',
            authorName: 'Alex',
            authoredAt: '2026-04-08T10:00:00.000Z',
          },
        },
      })
    })

    await page.goto(appUrl)

    const gitCardShell = page.locator('.card-shell').first()
    const fileList = page.locator('.git-dashboard-file-list').first()
    const firstItem = fileList.locator('.git-dashboard-file-item').first()
    const actionBar = page.locator('.git-dashboard-actions-bar').first()

    await expect(gitCardShell).toBeVisible()
    await expect(fileList).toBeVisible()
    await expect(actionBar).toBeVisible()

    const listMetrics = await fileList.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
      overflowY: getComputedStyle(node).overflowY,
    }))

    expect(listMetrics.overflowY).toBe('auto')
    expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight + 24)

    const [listRect, firstItemFontSize, firstItemLineHeight] = await Promise.all([
      readRect(fileList),
      readComputedValue(firstItem, 'font-size'),
      readComputedValue(firstItem, 'line-height'),
    ])

    expect(Number.parseFloat(firstItemLineHeight)).toBeGreaterThanOrEqual(Number.parseFloat(firstItemFontSize) * 1.45)

    await page.mouse.move(listRect.left + listRect.width / 2, listRect.top + Math.min(40, listRect.height / 2))
    await page.mouse.wheel(0, 320)

    await expect
      .poll(async () => await fileList.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(listMetrics.scrollTop)

    await expect(gitCardShell).toHaveScreenshot(`git-tool-overflow-scroll-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`git tool keeps a full pane layout when multiple tabs stay mounted in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 900 })

    const state = createMultiTabGitPaneState(theme)

    await mockAppApis(page, { state })
    await page.route('**/api/git/status?workspacePath=*', async (route) => {
      await route.fulfill({
        json: {
          workspacePath: 'd:\\Git\\chill-vibe',
          isRepository: true,
          repoRoot: 'd:\\Git\\chill-vibe',
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          hasConflicts: false,
          clean: false,
          summary: {
            staged: 2,
            unstaged: 2,
            untracked: 0,
            conflicted: 0,
          },
          changes: [
            {
              path: 'src/components/PaneView.tsx',
              kind: 'modified',
              stagedStatus: 'M',
              workingTreeStatus: ' ',
              staged: true,
              conflicted: false,
              addedLines: 7,
              removedLines: 1,
              patch: '@@ -680,6 +680,12 @@\n-<div style={{ display: contents }}>\n+<div className="pane-tab-panel is-active">',
            },
            {
              path: 'src/index.css',
              kind: 'modified',
              stagedStatus: ' ',
              workingTreeStatus: 'M',
              staged: false,
              conflicted: false,
              addedLines: 12,
              removedLines: 4,
              patch: '@@ -8235,6 +8235,18 @@\n+.pane-content > .pane-tab-panel { display: flex; }',
            },
            {
              path: 'tests/theme-check.spec.ts',
              kind: 'modified',
              stagedStatus: 'M',
              workingTreeStatus: ' ',
              staged: true,
              conflicted: false,
              addedLines: 18,
              removedLines: 0,
              patch: '@@ -3140,0 +3141,18 @@\n+test(\'git tool keeps a full pane layout when multiple tabs stay mounted\')',
            },
            {
              path: 'tests/pane-tab-preservation.test.ts',
              kind: 'modified',
              stagedStatus: ' ',
              workingTreeStatus: 'M',
              staged: false,
              conflicted: false,
              addedLines: 9,
              removedLines: 2,
              patch: '@@ -95,6 +95,13 @@\n+assert.match(markup, /class="pane-tab-panel is-active"/)',
            },
          ],
          lastCommit: {
            hash: 'abc1234def5678',
            shortHash: 'abc1234',
            summary: 'Keep pane-mounted tabs from breaking Git card layout',
            description: '',
            authorName: 'Alex',
            authoredAt: '2026-04-09T03:00:00.000Z',
          },
        },
      })
    })

    await page.goto(appUrl)

    const paneView = page.locator('.pane-view').first()
    const activePanePanel = paneView.locator('.pane-content > .pane-tab-panel.is-active')
    const hiddenPanePanel = paneView.locator('.pane-content > .pane-tab-panel[hidden]')
    const gitCardShell = activePanePanel.locator('.card-shell').first()
    const gitToolCard = activePanePanel.locator('.git-tool-card').first()
    const summaryTop = activePanePanel.locator('.git-dashboard-summary-top').first()
    const fileList = activePanePanel.locator('.git-dashboard-file-list').first()
    const actionBar = activePanePanel.locator('.git-dashboard-actions-bar').first()

    await expect(paneView.locator('.pane-tab-bar')).toContainText('Git')
    await expect(paneView.locator('.pane-tab-bar')).toContainText('123123')
    await expect(hiddenPanePanel).toHaveCount(1)
    await expect(gitToolCard).toBeVisible()
    await expect(summaryTop).toBeVisible()
    await expect(fileList).toBeVisible()
    await expect(activePanePanel.locator('.git-dashboard-summary-count')).toContainText('4')
    await expect(actionBar).toBeVisible()

    const [panelRect, cardRect, summaryRect, fileListRect, actionBarRect] = await Promise.all([
      readRect(activePanePanel),
      readRect(gitCardShell),
      readRect(summaryTop),
      readRect(fileList),
      readRect(actionBar),
    ])

    expect(Math.abs(panelRect.height - cardRect.height)).toBeLessThanOrEqual(2)
    expect(Math.abs(actionBarRect.top - summaryRect.top)).toBeLessThanOrEqual(20)
    expect(fileListRect.top).toBeGreaterThanOrEqual(summaryRect.bottom - 1)
    expect(actionBarRect.bottom).toBeLessThanOrEqual(cardRect.bottom + 2)

    await expect(paneView).toHaveScreenshot(`git-tool-pane-multitab-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

test('git full dialog header stays compact on a wide light-theme card', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 1420 })

  const state = createMockState()
  state.settings.language = 'zh-CN'
  state.settings.theme = 'light'
  state.columns[0]!.width = 980
  state.columns[0]!.cards[0] = {
    ...state.columns[0]!.cards[0]!,
    title: 'Feature Chat',
    provider: 'codex',
    model: '__git_tool__',
    reasoningEffort: 'medium',
    size: 1180,
  }

  await mockAppApis(page, { state })
  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({
      json: {
        workspacePath: 'd:\\Git\\chill-vibe',
        isRepository: true,
        repoRoot: 'd:\\Git\\chill-vibe',
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasConflicts: false,
        clean: false,
        summary: {
          staged: 0,
          unstaged: 2,
          untracked: 2,
          conflicted: 0,
        },
        changes: [
          {
            path: 'src/index.css',
            kind: 'modified',
            stagedStatus: ' ',
            workingTreeStatus: 'M',
            staged: false,
            conflicted: false,
            addedLines: 8,
            removedLines: 1,
            patch: '@@ -3563,6 +3563,7 @@ body,\n+.git-desktop-topbar { display: flex; }',
          },
          {
            path: 'tests/theme-check.spec.ts',
            kind: 'modified',
            stagedStatus: ' ',
            workingTreeStatus: 'M',
            staged: false,
            conflicted: false,
            addedLines: 9,
            removedLines: 0,
            patch: '@@ -1900,0 +1901,9 @@\n+test(\'git tool topbar stays compact on a wide light-theme card\')',
          },
          {
            path: 'notes/ui-audit.md',
            kind: 'untracked',
            stagedStatus: '?',
            workingTreeStatus: '?',
            staged: false,
            conflicted: false,
            addedLines: 1,
            removedLines: 0,
            patch: '@@ -0,0 +1,1 @@\n+Match GitHub Desktop more closely',
          },
          {
            path: 'notes/git-card-followup.md',
            kind: 'untracked',
            stagedStatus: '?',
            workingTreeStatus: '?',
            staged: false,
            conflicted: false,
            addedLines: 1,
            removedLines: 0,
            patch: '@@ -0,0 +1,1 @@\n+Keep the toolbar compact',
          },
        ],
        lastCommit: {
          hash: '18f0f7a1e04f50',
          shortHash: '18f0f7a',
          summary: 'Tighten Git card chrome',
          description: '',
          authorName: 'Alex',
          authoredAt: '2026-04-05T10:00:00.000Z',
        },
      },
    })
  })

  await page.goto(appUrl)

  await page.getByRole('button', { name: '古法 Git' }).click()

  const topbar = page.locator('.structured-preview-header').first()
  const titleEl = topbar.locator('.structured-preview-title').first()
  const actionsEl = topbar.locator('.structured-preview-actions').first()

  await expect(topbar).toBeVisible()

  const [topbarRect, titleRect, actionsRect] = await Promise.all([
    readRect(topbar),
    readRect(titleEl),
    readRect(actionsEl),
  ])

  expect(topbarRect.height, `Expected a compact toolbar, got ${JSON.stringify(topbarRect)}`).toBeLessThan(80)
  expect(Math.abs(titleRect.top - actionsRect.top)).toBeLessThan(16)
  await expectChildToFitWithinParent(topbar, titleEl, 'git full dialog title row')
  await expectChildToFitWithinParent(topbar, actionsEl, 'git full dialog actions')
  await expect(topbar).toHaveScreenshot('git-tool-topbar-wide-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

for (const theme of ['dark', 'light'] as const) {
  test(`git analysis panel floats inside the card without shifting the stack in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 980 })

    const state = createMockState()
    state.settings.language = 'en'
    state.settings.theme = theme
    state.columns[0]!.width = 520
    const gitCard = {
      ...state.columns[0]!.cards[0]!,
      id: 'git-card',
      title: 'Git analysis',
      provider: 'codex' as const,
      model: '__git_tool__',
      reasoningEffort: 'medium',
      size: 320,
    }
    const chatCard = {
      ...state.columns[0]!.cards[0]!,
      id: 'chat-card',
      title: 'Below chat',
      provider: 'claude' as const,
      model: 'claude-opus-4-6',
      reasoningEffort: 'medium',
      size: 280,
    }

    configureColumnCardsAndLayout(
      state,
      [gitCard, chatCard],
      createSplit(
        'vertical',
        [
          createPane(['git-card'], 'git-card', 'pane-git'),
          createPane(['chat-card'], 'chat-card', 'pane-chat'),
        ],
        [0.56, 0.44],
        'git-analysis-split',
      ),
    )

    await mockAppApis(page, { state })
    await page.route('**/api/git/status?workspacePath=*', async (route) => {
      await route.fulfill({
        json: {
          workspacePath: 'd:\\Git\\chill-vibe',
          isRepository: true,
          repoRoot: 'd:\\Git\\chill-vibe',
          branch: 'feature/git-analysis-panel',
          upstream: 'origin/main',
          ahead: 1,
          behind: 0,
          hasConflicts: false,
          clean: false,
          summary: {
            staged: 1,
            unstaged: 2,
            untracked: 0,
            conflicted: 0,
          },
          changes: [
            {
              path: 'src/components/GitToolCard.tsx',
              kind: 'modified',
              stagedStatus: 'M',
              workingTreeStatus: ' ',
              staged: true,
              conflicted: false,
              addedLines: 12,
              removedLines: 3,
              patch: '@@ -1,4 +1,12 @@\n-export const oldCard = true\n+export const dockedPanel = true',
            },
            {
              path: 'src/index.css',
              kind: 'modified',
              stagedStatus: ' ',
              workingTreeStatus: 'M',
              staged: false,
              conflicted: false,
              addedLines: 18,
              removedLines: 4,
              patch: '@@ -10,6 +10,18 @@\n+.git-agent-panel-shell { position: absolute; }',
            },
            {
              path: 'tests/theme-check.spec.ts',
              kind: 'modified',
              stagedStatus: ' ',
              workingTreeStatus: 'M',
              staged: false,
              conflicted: false,
              addedLines: 24,
              removedLines: 0,
              patch: '@@ -1,0 +1,24 @@\n+test(\'git analysis panel docks to the card bottom\')',
            },
          ],
          lastCommit: {
            hash: 'abc1234def5678',
            shortHash: 'abc1234',
            summary: 'Dock git analysis panel',
            description: '',
            authorName: 'Alex',
            authoredAt: '2026-04-05T03:00:00.000Z',
          },
        },
      })
    })

    await page.goto(appUrl)
    await mockGitAnalysisResult(
      page,
      JSON.stringify({
        summary: 'Keep the Git card compact and layer the analysis over the existing card body.',
        strategies: [
          {
            label: 'Commit all',
            description: 'One commit for the full Git card pass.',
            commits: [
              {
                summary: 'Dock the git analysis panel',
                paths: ['src/components/GitToolCard.tsx', 'src/index.css', 'tests/theme-check.spec.ts'],
              },
            ],
          },
          {
            label: 'Git UI',
            description: 'Card sizing and bottom docking.',
            commits: [
              {
                summary: 'Tighten the git card chrome',
                paths: ['src/components/GitToolCard.tsx', 'src/index.css'],
              },
            ],
          },
          {
            label: 'Regression',
            description: 'Theme coverage for the docked panel.',
            commits: [
              {
                summary: 'Cover the git analysis panel layout',
                paths: ['tests/theme-check.spec.ts'],
              },
            ],
          },
        ],
      }),
    )

    const gitCardShell = page.locator('.card-shell').first()
    const gitToolCard = page.locator('.git-tool-card').first()
    const belowCardShell = page.locator('.card-shell').nth(1)

    await expect(gitCardShell).toBeVisible()

    const [cardBefore, belowBefore] = await Promise.all([
      readRect(gitCardShell),
      readRect(belowCardShell),
    ])

    await gitCardShell.getByRole('button', { name: 'Analyze changes', exact: true }).click()

    const floatingPanelShell = page.locator('.git-agent-panel-shell').first()
    const floatingPanel = page.locator('.git-agent-panel').first()
    await expect(floatingPanel).toBeVisible()
    await expect(floatingPanel).toContainText('Git UI')

    const [cardAfter, toolCardAfter, belowAfter, panelShellRect] = await Promise.all([
      readRect(gitCardShell),
      readRect(gitToolCard),
      readRect(belowCardShell),
      readRect(floatingPanelShell),
    ])

    expect(Math.abs(cardAfter.height - cardBefore.height)).toBeLessThan(2)
    expect(Math.abs(belowAfter.top - belowBefore.top)).toBeLessThan(2)
    expect(panelShellRect.top - toolCardAfter.top).toBeLessThan(24)
    expect(toolCardAfter.right - panelShellRect.right).toBeLessThan(24)
    expect(panelShellRect.bottom).toBeLessThanOrEqual(toolCardAfter.bottom + 1)

    await expect(gitCardShell).toHaveScreenshot(`git-tool-analysis-panel-docked-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

test('git tool card keeps long zh-CN metadata rows fully visible instead of clipping them', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 1065 })

  const state = createMockState()
  state.settings.language = 'zh-CN'
  state.settings.theme = 'dark'
  state.settings.fontScale = 1.35
  state.settings.lineHeightScale = minLineHeightScale
  state.columns[0]!.width = 980
  state.columns[0]!.cards = [
    {
      ...state.columns[0]!.cards[0]!,
      title: '问题2',
      provider: 'codex',
      model: '__git_tool__',
      reasoningEffort: 'medium',
      size: 860,
    },
    {
      ...state.columns[0]!.cards[0]!,
      id: 'card-2',
      title: '问题3',
      provider: 'claude',
      model: 'claude-opus-4-6',
      reasoningEffort: 'medium',
      size: 340,
    },
  ]

  await mockAppApis(page, { state })
  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({
      json: {
        workspacePath: 'd:\\Git\\chill-vibe',
        isRepository: true,
        repoRoot: 'd:\\Git\\chill-vibe',
        branch: 'feature/git-tool-card',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        hasConflicts: false,
        clean: false,
        summary: {
          staged: 0,
          unstaged: 20,
          untracked: 5,
          conflicted: 0,
        },
        changes: Array.from({ length: 25 }, (_, index) => ({
          path:
            index === 0
              ? '.codex/skills/chill-vibe-full-regression/agents/openai.yaml'
              : `src/feature/really/long/path/changed-file-${index}.tsx`,
          kind: index < 20 ? 'modified' : 'untracked',
          stagedStatus: index < 20 ? ' ' : '?',
          workingTreeStatus: index < 20 ? 'M' : '?',
          staged: false,
          conflicted: false,
          addedLines: index === 0 ? 3 : index + 1,
          removedLines: index === 0 ? 0 : Math.max(index - 1, 0),
          patch:
            index === 0
              ? '@@ -1,0 +1,3 @@\n+display_name: Chill Vibe Regression\n+short_description: Run the repo workflow.\n+default_prompt: Run the workflow.'
              : `@@ -${index},1 +${index},2 @@\n-export const oldValue${index} = false\n+export const nextValue${index} = true`,
        })),
        lastCommit: {
          hash: 'abc1234def5678',
          shortHash: 'abc1234',
          summary: '优化看板外框',
          description: '',
          authorName: 'Alex',
          authoredAt: '2026-04-05T03:00:00.000Z',
        },
      },
    })
  })

  await page.goto(appUrl)

  await page.getByRole('button', { name: '古法 Git' }).click()

  const fullDialog = page.locator('.structured-preview-dialog.is-git-full')
  const topbar = page.locator('.structured-preview-header').first()
  const titleRow = topbar.locator('.structured-preview-title').first()
  const actionsEl = topbar.locator('.structured-preview-actions').first()
  const listHeader = page.locator('.git-change-list-header').first()
  const listHeaderMeta = listHeader.locator('span').first()
  const fullDialogCard = page.locator('.structured-preview-card').first()

  await expect(fullDialog).toBeVisible()
  await expect(page.locator('.git-change-row')).toHaveCount(25)
  await expect(listHeader).toContainText('25')

  await expectChildToFitWithinParent(topbar, titleRow, 'git full dialog title row')
  await expectChildToFitWithinParent(topbar, actionsEl, 'git actions')
  await expectChildToFitWithinParent(listHeader, listHeaderMeta, 'git change summary row')
  await expect(fullDialogCard).toHaveScreenshot('git-tool-card-long-path-dark.png', {
    animations: 'disabled',
    caret: 'hide',
  })

  await page.getByRole('button', { name: '关闭' }).click()
  await page.locator('#app-tab-settings').click()
  await page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first().click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.locator('#app-tab-ambience').click()

  await page.getByRole('button', { name: '古法 Git' }).click()
  await expect(fullDialog).toBeVisible()
  await expect(fullDialogCard).toHaveScreenshot('git-tool-card-long-path-light.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('git tool card stacks its commit panel in a narrow column at max font scale', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1280 })

  const state = createMockState()
  state.settings.language = 'zh-CN'
  state.settings.theme = 'light'
  state.settings.fontScale = 1.35
  state.columns[0]!.width = 460
  state.columns[0]!.cards[0] = {
    ...state.columns[0]!.cards[0]!,
    title: 'Git 閺€鐟板З',
    provider: 'codex',
    model: '__git_tool__',
    reasoningEffort: 'medium',
  }

  await mockAppApis(page, { state })
  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({
      json: {
        workspacePath: 'd:\\Git\\chill-vibe',
        isRepository: true,
        repoRoot: 'd:\\Git\\chill-vibe',
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        hasConflicts: false,
        clean: false,
        summary: {
          staged: 0,
          unstaged: 8,
          untracked: 1,
          conflicted: 0,
        },
        changes: [
          {
            path: 'AGENTS.md',
            kind: 'modified',
            stagedStatus: ' ',
            workingTreeStatus: 'M',
            staged: false,
            conflicted: false,
          },
          {
            path: 'package.json',
            kind: 'modified',
            stagedStatus: ' ',
            workingTreeStatus: 'M',
            staged: false,
            conflicted: false,
          },
          {
            path: 'README.md',
            kind: 'modified',
            stagedStatus: ' ',
            workingTreeStatus: 'M',
            staged: false,
            conflicted: false,
          },
        ],
        lastCommit: {
          hash: '4f571b2abcdef0',
          shortHash: '4f571b2',
          summary: '123',
          description: '',
          authorName: 'contributor',
          authoredAt: '2026-04-05T08:35:00+08:00',
        },
      },
    })
  })

  await page.goto(appUrl)

  await page.getByRole('button', { name: '古法 Git' }).click()

  const gitChangeList = page.locator('.git-change-list').first()
  const gitCommitPanel = page.locator('.git-commit-panel').first()

  await expect(page.locator('.git-change-path')).toHaveCount(3)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  const changeListRect = await readRect(gitChangeList)
  const commitPanelRect = await readRect(gitCommitPanel)

  expect(commitPanelRect.top).toBeGreaterThan(changeListRect.bottom - 1)
})

test('git tool card localizes controls and section labels in zh-CN', async ({ page }) => {
  const state = createMockState()
  state.settings.language = 'zh-CN'
  state.columns[0]!.cards[0] = {
    ...state.columns[0]!.cards[0]!,
    title: 'Git 改动',
    provider: 'codex',
    model: '__git_tool__',
    reasoningEffort: 'medium',
  }

  await mockAppApis(page, { state })
  await page.route('**/api/git/status?workspacePath=*', async (route) => {
    await route.fulfill({
      json: {
        workspacePath: 'd:\\Git\\chill-vibe',
        isRepository: true,
        repoRoot: 'd:\\Git\\chill-vibe',
        branch: 'feature/git-tool-card',
        upstream: 'origin/main',
        ahead: 2,
        behind: 1,
        hasConflicts: false,
        clean: false,
        summary: {
          staged: 1,
          unstaged: 1,
          untracked: 1,
          conflicted: 0,
        },
        changes: [
          {
            path: 'src/App.tsx',
            kind: 'modified',
            stagedStatus: 'M',
            workingTreeStatus: ' ',
            staged: true,
            conflicted: false,
          },
          {
            path: 'src/index.css',
            kind: 'modified',
            stagedStatus: ' ',
            workingTreeStatus: 'M',
            staged: false,
            conflicted: false,
          },
          {
            path: 'notes/todo.md',
            kind: 'untracked',
            stagedStatus: '?',
            workingTreeStatus: '?',
            staged: false,
            conflicted: false,
          },
        ],
        lastCommit: {
          hash: 'abc1234def5678',
          shortHash: 'abc1234',
          summary: '优化看板外框',
          description: '',
          authorName: 'Alex',
          authoredAt: '2026-04-05T03:00:00.000Z',
        },
      },
    })
  })

  await page.goto(appUrl)

  const gitToolCard = page.locator('.git-tool-card').first()

  await expect(gitToolCard).toBeVisible()
  await expect(page.getByRole('button', { name: '分析改动' })).toBeVisible()
  await expect(page.getByRole('button', { name: '提交新增' })).toBeVisible()
  await expect(page.getByRole('button', { name: '同步' })).toBeVisible()
  await expect(page.getByRole('button', { name: '古法 Git' })).toBeVisible()

  await page.getByRole('button', { name: '古法 Git' }).click()

  await expect(page.getByRole('button', { name: '刷新' })).toBeVisible()
  await expect(page.getByRole('button', { name: '拉取' })).toBeVisible()
  await expect(page.getByRole('button', { name: '推送' })).toBeVisible()
  await expect(page.getByRole('button', { name: '提交已暂存内容' })).toBeVisible()
  await expect(page.locator('.git-change-list-header')).toContainText('已暂存')
  await expect(page.locator('.git-change-list-header')).toContainText('未暂存')
  await expect(page.locator('.git-change-list-header')).toContainText('未跟踪')
  await expect(page.locator('.git-commit-footer')).toContainText('最近一次提交')
})

test('dragging a tab over another tab shows a drop indicator in both themes', async ({ page }) => {
  const state = createMockState()
  state.columns[0]!.cards = [
    { ...state.columns[0]!.cards[0]!, id: 'card-a', title: 'Card A', size: 280 },
    { ...state.columns[0]!.cards[0]!, id: 'card-b', title: 'Card B', size: 280 },
    { ...state.columns[0]!.cards[0]!, id: 'card-c', title: 'Card C', size: 280 },
  ]
  await mockAppApis(page, { state })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto(appUrl)
  await page.locator('.pane-tab').nth(2).waitFor()

  const sourceTab = page.locator('.pane-tab').first()
  const targetTab = page.locator('.pane-tab').nth(1)

  const settingsTab = page.locator('#app-tab-settings')
  const ambienceTab = page.locator('#app-tab-ambience')
  const lightThemeButton = page.locator('#app-panel-settings .theme-toggle').first().locator('.theme-chip').first()

  const activateTabDrop = async () => {
    const dataTransfer = await page.evaluateHandle(() => {
      const dt = new DataTransfer()
      const payload = JSON.stringify({ type: 'tab', columnId: 'col-1', paneId: 'col-1-pane', tabId: 'card-a' })
      dt.setData('application/x-chill-vibe', payload)
      dt.setData('text/plain', payload)
      return dt
    })

    const targetBox = await targetTab.boundingBox()
    if (!targetBox) throw new Error('Expected target tab to be visible')

    const pointer = {
      clientX: targetBox.x + targetBox.width * 0.25,
      clientY: targetBox.y + targetBox.height * 0.25,
      bubbles: true,
      cancelable: true,
    }

    await sourceTab.dispatchEvent('dragstart', { dataTransfer, ...pointer })
    await targetTab.dispatchEvent('dragenter', { dataTransfer, ...pointer })
    await targetTab.dispatchEvent('dragover', { dataTransfer, ...pointer })

    return dataTransfer
  }

  const clearTabDrop = async (dataTransfer: Awaited<ReturnType<typeof activateTabDrop>>) => {
    await targetTab.dispatchEvent('dragleave', { dataTransfer, bubbles: true, cancelable: true })
    await sourceTab.dispatchEvent('dragend', { dataTransfer, bubbles: true, cancelable: true })
  }

  const expectDropIndicator = async () => {
    await expect(targetTab).toHaveClass(/drop-before/)
    await expect
      .poll(async () =>
        targetTab.evaluate((node) => Number(getComputedStyle(node, '::before').opacity)),
      )
      .toBeGreaterThan(0.95)
  }

  // Dark theme (default)
  const darkDt = await activateTabDrop()
  await expectDropIndicator()
  await clearTabDrop(darkDt)

  // Switch to light theme
  await settingsTab.click()
  await lightThemeButton.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await ambienceTab.click()

  const lightDt = await activateTabDrop()
  await expectDropIndicator()
  await clearTabDrop(lightDt)
})

test('weather tool tabs move across workspaces and inherit the target workspace provider', async ({ page }) => {
  await mockAppApis(page, { state: createCrossWorkspaceWeatherDragState() })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto(appUrl)
  await page.locator('.workspace-column').nth(1).waitFor()

  const sourceColumn = page.locator('.workspace-column').first()
  const targetColumn = page.locator('.workspace-column').nth(1)
  const sourceTab = sourceColumn.locator('.pane-tab', { hasText: 'Weather' })
  const targetTabBar = targetColumn.locator('.pane-tab-bar').first()

  await expect(sourceTab).toBeVisible()
  await expect(targetTabBar).toBeVisible()

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  const tabBox = await sourceTab.boundingBox()
  const targetBox = await targetTabBar.boundingBox()

  if (!tabBox || !targetBox) {
    throw new Error('Expected both source and target tab surfaces to be visible')
  }

  await dataTransfer.evaluate((dt) => {
    const payload = JSON.stringify({ type: 'tab', columnId: 'col-1', paneId: 'col-1-pane', tabId: 'weather-card' })
    dt.setData('application/x-chill-vibe', payload)
    dt.setData('text/plain', payload)
  })

  const sourcePointer = {
    clientX: tabBox.x + tabBox.width / 2,
    clientY: tabBox.y + tabBox.height / 2,
    bubbles: true,
    cancelable: true,
  }
  const targetPointer = {
    clientX: targetBox.x + Math.min(targetBox.width * 0.25, 48),
    clientY: targetBox.y + targetBox.height / 2,
    bubbles: true,
    cancelable: true,
  }

  await sourceTab.dispatchEvent('dragstart', { dataTransfer, ...sourcePointer })
  await targetTabBar.dispatchEvent('dragenter', { dataTransfer, ...targetPointer })
  await targetTabBar.dispatchEvent('dragover', { dataTransfer, ...targetPointer })
  await targetTabBar.dispatchEvent('drop', { dataTransfer, ...targetPointer })

  await expect(sourceColumn.locator('.pane-tab', { hasText: 'Weather' })).toHaveCount(0)
  await expect(targetColumn.locator('.pane-tab', { hasText: 'Weather' })).toHaveCount(1)

  await targetColumn.locator('.pane-tab', { hasText: 'Weather' }).click()
  await expect(targetColumn.locator('[data-weather-card]')).toBeVisible()

  await expect
    .poll(async () => {
      const snapshot = await page.evaluate(async () => {
        const response = await fetch('/api/state')
        return response.json()
      })
      const typedState = createPlaywrightState(snapshot as AppState)
      return typedState.columns[1]?.cards?.['weather-card'] ?? null
    })
    .toMatchObject({
      provider: 'claude',
      model: WEATHER_TOOL_MODEL,
    })
})

test('pane-embedded chats keep the title in tab chrome instead of the content header', async ({ page }) => {
  await mockAppApis(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(appUrl)
  await page.locator('.card-shell').first().waitFor()

  const paneTab = page.locator('.pane-tab').first()
  const contentHeader = page.locator('.pane-content .card-header')
  const composerModelSelect = page.locator('.pane-content .composer-input-row .model-select-shell').first()
  const duplicatedTitles = page.locator('.pane-content .card-title')

  await expect(paneTab).toContainText(/Feature Chat|新会话|New Chat/)
  await expect(contentHeader).toHaveCount(0)
  await expect(composerModelSelect).toBeVisible()
  await expect(duplicatedTitles).toHaveCount(0)
})

for (const theme of ['dark', 'light'] as const) {
  test(`long pane tab titles keep the close affordance clear in ${theme} theme`, async ({ page }) => {
    const state = createMockState()
    state.settings.language = 'zh-CN'
    state.settings.theme = theme
    state.columns[0]!.width = 520
    state.columns[0]!.cards[0] = {
      ...state.columns[0]!.cards[0]!,
      title: 'This is an intentionally very long card title used to verify the header still preserves a safe drag zone.',
    }

    await mockAppApis(page, { state })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(appUrl)

    const paneTab = page.locator('.pane-tab').first()
    const tabLabel = paneTab.locator('.pane-tab-label')
    const tabClose = paneTab.locator('.pane-tab-close')

    await expect(paneTab).toBeVisible()
    await expect(tabLabel).toBeVisible()
    await expect(tabClose).toBeVisible()

    const [tabRect, labelRect, closeRect] = await Promise.all([
      readRect(paneTab),
      readRect(tabLabel),
      readRect(tabClose),
    ])

    expect(labelRect.right).toBeLessThan(closeRect.left + 2)
    expect(closeRect.right).toBeLessThanOrEqual(tabRect.right + 1)

    const safeZoneHit = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
      const closeButton = target instanceof Element ? target.closest('.pane-tab-close') : null
      const tab = target instanceof Element ? target.closest('.pane-tab') : null

      return {
        insideTab: Boolean(tab),
        closeClassName: closeButton instanceof HTMLElement ? closeButton.className : '',
      }
    }, {
      x: closeRect.left + closeRect.width / 2,
      y: closeRect.top + closeRect.height / 2,
    })

    expect(safeZoneHit.insideTab).toBeTruthy()
    expect(safeZoneHit.closeClassName).toContain('pane-tab-close')

    await expect(paneTab).toHaveScreenshot(`pane-tab-title-safe-zone-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`sticky note panes respect split ratios in ${theme} theme`, async ({ page }) => {
    const state = createMockState()
    state.settings.language = 'en'
    state.settings.theme = theme
    const defaultStickyCard = {
      ...state.columns[0]!.cards[0]!,
      id: 'sticky-default',
      model: STICKYNOTE_TOOL_MODEL,
      stickyNote: 'Line 1\nLine 2\nLine 3\nLine 4',
      messages: [],
    }
    const minimumStickyCard = {
      ...state.columns[0]!.cards[0]!,
      id: 'sticky-minimum',
      model: STICKYNOTE_TOOL_MODEL,
      stickyNote: 'Line 1',
      messages: [],
    }

    configureColumnCardsAndLayout(
      state,
      [defaultStickyCard, minimumStickyCard],
      createSplit(
        'vertical',
        [
          createPane(['sticky-default'], 'sticky-default', 'sticky-pane-top'),
          createPane(['sticky-minimum'], 'sticky-minimum', 'sticky-pane-bottom'),
        ],
        [0.64, 0.36],
        'sticky-split',
      ),
    )

    await mockAppApis(page, { state })
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.goto(appUrl)

    const defaultCard = page.locator('.card-shell').nth(0)
    const minimumCard = page.locator('.card-shell').nth(1)
    const defaultTextarea = page.locator('.sticky-note-textarea').nth(0)
    const minimumTextarea = page.locator('.sticky-note-textarea').nth(1)

    await expect(defaultTextarea).toBeVisible()
    await expect(minimumTextarea).toBeVisible()
    await expect(page.locator('.composer textarea')).toHaveCount(0)

    const [
      defaultCardRect,
      minimumCardRect,
      defaultTextareaRect,
      minimumTextareaRect,
      defaultLineHeight,
      minimumLineHeight,
    ] = await Promise.all([
      readRect(defaultCard),
      readRect(minimumCard),
      readRect(defaultTextarea),
      readRect(minimumTextarea),
      readComputedValue(defaultTextarea, 'line-height'),
      readComputedValue(minimumTextarea, 'line-height'),
    ])

    const defaultLineHeightPx = Number.parseFloat(defaultLineHeight)
    const minimumLineHeightPx = Number.parseFloat(minimumLineHeight)

    expect(defaultCardRect.height - minimumCardRect.height).toBeGreaterThan(120)
    expect(defaultTextareaRect.height - minimumTextareaRect.height).toBeGreaterThan(120)
    expect(defaultTextareaRect.height / defaultLineHeightPx).toBeGreaterThan(4)
    expect(minimumTextareaRect.height / minimumLineHeightPx).toBeGreaterThan(3)

    await expect(defaultCard).toHaveScreenshot(`sticky-note-pane-top-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
    await expect(minimumCard).toHaveScreenshot(`sticky-note-pane-bottom-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`brainstorm card keeps answer controls legible in ${theme} theme`, async ({ page }) => {
    const state = createBrainstormToolState(theme)

    await mockAppApis(page, { state })
    await page.setViewportSize({ width: 1280, height: 920 })
    await page.goto(appUrl)

    const brainstormCard = page.locator('[data-brainstorm-card]').first()

    await expect(brainstormCard).toBeVisible()
    await expect(brainstormCard).toContainText('Brainstorm')
    await expect(brainstormCard).toContainText('Answer count')
    await expect(brainstormCard).toContainText('Delete all')

    await expect(brainstormCard).toHaveScreenshot(`brainstorm-card-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`brainstorm card stays compact in ${theme} narrow layout`, async ({ page }) => {
    const state = createBrainstormToolState(theme)

    await mockAppApis(page, { state })
    await page.setViewportSize({ width: 680, height: 920 })
    await page.goto(appUrl)

    const brainstormCard = page.locator('[data-brainstorm-card]').first()

    await expect(brainstormCard).toBeVisible()
    await expect(brainstormCard).toHaveScreenshot(`brainstorm-card-narrow-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`white noise cards launch without extra content header chrome in ${theme} theme`, async ({ page }) => {
    const state = createTopbarToolLauncherState(theme)
    state.settings.language = 'zh-CN'

    await mockAppApis(page, { state })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(appUrl)

    await page.getByRole('button', { name: /White Noise|白噪音/ }).click()

    const paneView = page.locator('.pane-view').first()
    const whiteNoiseCard = paneView.locator('.whitenoise-card').first()

    await expect(whiteNoiseCard).toBeVisible()
    await expect(paneView.locator('.card-header')).toHaveCount(0)
    await expect(paneView.locator('.model-select-shell')).toHaveCount(0)

    await expect(paneView).toHaveScreenshot(`whitenoise-card-header-no-title-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`music card matches tool chrome in ${theme} theme`, async ({ page }) => {
    const state = createMusicToolState(theme)

    await mockAppApis(page, { state })
    await installMockMusicApis(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(appUrl)

    const cardShell = page.locator('.card-shell').first()
    const playlistHeader = page.locator('.music-playlist-header').first()

    await expect(cardShell).toBeVisible()
    await expect(playlistHeader).toBeVisible()

    await playlistHeader.click()
    await expect(page.locator('.music-playlist-card.is-expanded')).toBeVisible()

    const trackRow = page.locator('.music-track-row').first()
    await expect(trackRow).toBeVisible()
    await trackRow.click()

    await expect(cardShell.locator('.music-player-bar')).toBeVisible()
    await expect(cardShell).toHaveScreenshot(`music-card-shell-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`split drop target stays above music playlist content in ${theme} theme`, async ({ page }) => {
    const state = createMusicSplitDropState(theme)

    await mockAppApis(page, { state })
    await installMockMusicApis(page)
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto(appUrl)

    const sourceTab = page.locator('.workspace-column').first().locator('.pane-tab').first()
    const targetColumn = page.locator('.workspace-column').nth(1)
    const targetPaneContent = targetColumn.locator('.pane-content').first()
    const playlistHeader = targetColumn.locator('.music-playlist-header').first()

    await expect(sourceTab).toBeVisible()
    await expect(targetPaneContent).toBeVisible()
    await expect(playlistHeader).toBeVisible()

    await playlistHeader.click()
    await expect(targetColumn.locator('.music-playlist-card.is-expanded')).toBeVisible()
    await expect(targetColumn.locator('.music-track-row').first()).toBeVisible()

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
    const paneBox = await targetPaneContent.boundingBox()

    if (!paneBox) {
      throw new Error('Expected the music pane content to be visible')
    }

    const pointer = {
      clientX: paneBox.x + paneBox.width / 2,
      clientY: paneBox.y + paneBox.height * 0.72,
      bubbles: true,
      cancelable: true,
    }

    await dataTransfer.evaluate((dt) => {
      const payload = JSON.stringify({ type: 'tab', columnId: 'col-1', paneId: 'col-1-pane', tabId: 'card-1' })
      dt.setData('application/x-chill-vibe', payload)
      dt.setData('text/plain', payload)
    })

    await sourceTab.dispatchEvent('dragstart', { dataTransfer, ...pointer })
    await targetPaneContent.dispatchEvent('dragenter', { dataTransfer, ...pointer })
    await targetPaneContent.dispatchEvent('dragover', { dataTransfer, ...pointer })

    await expect(targetPaneContent).toHaveClass(/is-drop-bottom/)
    await expect
      .poll(async () => Number(await targetPaneContent.evaluate((node) => getComputedStyle(node, '::before').opacity)))
      .toBeGreaterThan(0.95)
    await expect
      .poll(() => targetPaneContent.evaluate((node) => getComputedStyle(node, '::before').zIndex))
      .toBe('200')

    await expect(targetPaneContent).toHaveScreenshot(`music-pane-drop-target-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })

    await targetPaneContent.dispatchEvent('dragleave', { dataTransfer, bubbles: true, cancelable: true })
    await sourceTab.dispatchEvent('dragend', { dataTransfer, bubbles: true, cancelable: true })
  })

  test(`sunny weather card glow stays soft in ${theme} theme`, async ({ page }) => {
    const state = createWeatherMenuState(theme)

    await mockAppApis(page, { state })
    await page.addInitScript(() => {
      const fixedNow = new Date('2026-04-05T12:00:00').valueOf()
      const RealDate = Date

      class FixedDate extends RealDate {
        constructor(...args: ConstructorParameters<DateConstructor>) {
          if (args.length === 0) {
            super(fixedNow)
            return
          }

          super(...args)
        }

        static now() {
          return fixedNow
        }
      }

      window.Date = FixedDate as DateConstructor
      window.electronAPI = {
        ...window.electronAPI,
        fetchWeather: async () => ({
          condition: 'sunny',
          city: 'Shanghai',
          temperature: 24,
          isDay: true,
          fetchedAt: '2026-04-05T04:00:00.000Z',
        }),
      }
    })

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(appUrl)

    const weatherCard = page.locator('[data-weather-card]').first()

    await expect(weatherCard).toBeVisible()
    await expect(weatherCard.locator('.weather-sun-glow')).toBeVisible()
    await weatherCard.evaluate((node) => {
      node.classList.remove('is-morning', 'is-evening', 'is-night')
      node.classList.add('is-noon')
    })
    expect(
      isTransparentColor(await readComputedValue(weatherCard, 'background-color')),
      `weather card background should stay opaque in ${theme} theme`,
    ).toBeFalsy()

    await expect(weatherCard).toHaveScreenshot(`weather-card-sunny-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`empty chat quick tool entries stay centered in ${theme} theme`, async ({ page }) => {
    const state = createTopbarToolLauncherState(theme)
    state.settings.language = 'en'

    await mockAppApis(page, { state })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(appUrl)

    const paneView = page.locator('.pane-view').first()
    const toolButtons = paneView.locator('.chat-empty-tool-button')

    await expect(page.locator('.app-topbar-tool-button')).toHaveCount(0)
    await expect(toolButtons).toHaveCount(6)
    await expect(toolButtons.nth(0)).toContainText(/Git/)
    await expect(toolButtons.nth(1)).toContainText(/Files/)
    await expect(toolButtons.nth(2)).toContainText(/Sticky Note/)
    await expect(toolButtons.nth(3)).toContainText(/Weather/)
    await expect(toolButtons.nth(4)).toContainText(/Music/)
    await expect(toolButtons.nth(5)).toContainText(/White Noise/)
    await expect(paneView).toHaveScreenshot(`empty-chat-tool-entries-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`empty chat quick tool entries show full zh-CN descriptions in ${theme} theme`, async ({ page }) => {
    const state = createMockState()
    state.settings.theme = theme

    await mockAppApis(page, { state })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(appUrl)

    const paneView = page.locator('.pane-view').first()
    const toolButtons = paneView.locator('.chat-empty-tool-button')
    const descriptions = paneView.locator('.chat-empty-tool-description')
    const expectedDescriptions = [
      '查看仓库状态，分析改动并继续同步。',
      '打开文件树，快速浏览和跳转工作区内容。',
      '开一张便签，随手记下想法和待办。',
    ]

    await expect(toolButtons).toHaveCount(3)

    for (const [index, expectedDescription] of expectedDescriptions.entries()) {
      const button = toolButtons.nth(index)
      const description = descriptions.nth(index)

      await expect(description).toHaveText(expectedDescription)
      await expectChildToFitWithinParent(button, description, `quick tool description ${index + 1}`)
      await expectTextBlockNotClipped(description, expectedDescription)
    }

    await expect(paneView).toHaveScreenshot(`empty-chat-tool-entries-zh-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`empty chat quick tool entries wrap zh-CN descriptions in a narrow ${theme} theme pane`, async ({
    page,
  }) => {
    const state = createMockState()
    state.settings.theme = theme

    await mockAppApis(page, { state })
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto(appUrl)

    const paneView = page.locator('.pane-view').first()
    const toolButtons = paneView.locator('.chat-empty-tool-button')
    const descriptions = paneView.locator('.chat-empty-tool-description')

    await expect(toolButtons).toHaveCount(3)

    for (const index of [0, 1, 2]) {
      const button = toolButtons.nth(index)
      const description = descriptions.nth(index)

      await expect(description).toBeVisible()
      await expectChildToFitWithinParent(button, description, `narrow quick tool description ${index + 1}`)
      await expectTextBlockNotClipped(description, `narrow quick tool description ${index + 1}`)
    }

    await expect(paneView).toHaveScreenshot(`empty-chat-tool-entries-zh-narrow-${theme}.png`, {
      animations: 'disabled',
      caret: 'hide',
    })
  })

  test(`empty chat quick tool entries hide ambience launchers when one is already open in ${theme} theme`, async ({ page }) => {
    const state = createTopbarToolLauncherState(theme, WEATHER_TOOL_MODEL)
    state.settings.language = 'en'

    await mockAppApis(page, { state })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(appUrl)

    const paneView = page.locator('.pane-view').first()
    const toolButtons = paneView.locator('.chat-empty-tool-button')

    await expect(toolButtons).toHaveCount(3)
    await expect(toolButtons.nth(0)).toContainText(/Git/)
    await expect(toolButtons.nth(1)).toContainText(/Files/)
    await expect(toolButtons.nth(2)).toContainText(/Sticky Note/)
    await expect(toolButtons.filter({ hasText: /Weather/ })).toHaveCount(0)
    await expect(toolButtons.filter({ hasText: /Music/ })).toHaveCount(0)
    await expect(toolButtons.filter({ hasText: /White Noise/ })).toHaveCount(0)
  })
}

