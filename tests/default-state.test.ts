import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createCard,
  createColumn,
  createDefaultState,
  createDefaultSettings,
  getAvailableQuickToolModels,
  getCardDefaultSize,
  getCardMinimumSize,
  getPreferredReasoningEffort,
  maxFontScale,
  maxUiScale,
  minColumnWidth,
  minLineHeightScale,
  normalizeAppSettings,
  normalizeCardSize,
  normalizeColumnWidth,
  rememberModelReasoningEffort,
  titleFromPrompt,
} from '../shared/default-state.ts'
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
} from '../shared/models.ts'
import type { PaneNode } from '../shared/schema.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'

describe('default-state helpers', () => {
  it('normalizes settings into safe persisted values', () => {
    const defaults = createDefaultSettings()
    const next = normalizeAppSettings({
      theme: 'light',
      uiScale: 9,
      fontScale: 9,
      lineHeightScale: 0.1,
      requestModels: {
        codex: 'gpt-4.5',
        claude: '  claude-sonnet-4-6  ',
      },
    })

    assert.deepEqual(next, {
      ...defaults,
      theme: 'light',
      activeTopTab: 'ambience',
      uiScale: maxUiScale,
      fontScale: maxFontScale,
      lineHeightScale: minLineHeightScale,
      resilientProxyEnabled: true,
      cliRoutingEnabled: true,
      resilientProxyStallTimeoutSec: 60,
      resilientProxyMaxRetries: 6,
      resilientProxyFirstByteTimeoutSec: 90,
      musicAlbumCoverEnabled: false,
      gitCardEnabled: true,
      fileTreeCardEnabled: true,
      stickyNoteCardEnabled: true,
      pmCardEnabled: true,
      brainstormCardEnabled: false,
      experimentalMusicEnabled: false,
      experimentalWhiteNoiseEnabled: false,
      experimentalWeatherEnabled: false,
      agentDoneSoundEnabled: false,
      agentDoneSoundVolume: 0.7,
      crossProviderSkillReuseEnabled: true,
      autoUrgeEnabled: false,
      autoUrgeMessage: '你必须百分百验证通过你要解决的问题，才能结束回答，如果确定解决了，回复YES，否则不准停下来',
      autoUrgeSuccessKeyword: 'YES',
      weatherCity: '',
      systemPrompt: defaultSystemPrompt,
      gitAgentModel: 'gpt-5.4 xhigh',
      lastModel: undefined,
      requestModels: {
        codex: DEFAULT_CODEX_MODEL,
        claude: 'claude-sonnet-4-6',
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
      recentWorkspaces: [],
    })
  })

  it('uses the configured provider defaults and preserves explicit default selections on cards', () => {
    assert.equal(createDefaultSettings().language, 'zh-CN')
    assert.equal(createDefaultSettings('en').language, 'en')
    assert.equal(createDefaultSettings().requestModels.claude, DEFAULT_CLAUDE_MODEL)
    assert.deepEqual(createDefaultSettings().modelReasoningEfforts, {
      codex: {},
      claude: {},
    })
    assert.equal(createCard('Chat', 440, 'codex', '').model, '')
    assert.equal(createCard('Chat', 440, 'claude', '').model, '')
  })

  it('stores reasoning preferences by actual model and reuses them for configured defaults', () => {
    const settings = createDefaultSettings()
    const savedPreferences = rememberModelReasoningEffort(settings, 'codex', '', 'high')

    assert.deepEqual(savedPreferences, {
      codex: {
        [DEFAULT_CODEX_MODEL]: 'high',
      },
      claude: {},
    })

    const next = normalizeAppSettings({
      ...settings,
      modelReasoningEfforts: savedPreferences,
    })

    assert.equal(getPreferredReasoningEffort(next, 'codex', ''), 'high')
    assert.equal(getPreferredReasoningEffort(next, 'codex', DEFAULT_CODEX_MODEL), 'high')
    assert.equal(getPreferredReasoningEffort(next, 'claude', DEFAULT_CLAUDE_MODEL), 'max')
  })

  it('preserves lower supported line-height settings', () => {
    assert.equal(normalizeAppSettings({ lineHeightScale: minLineHeightScale }).lineHeightScale, minLineHeightScale)
  })

  it('preserves an overall UI scale setting', () => {
    const next = normalizeAppSettings({ uiScale: 1.2 } as never) as { uiScale?: number }

    assert.equal(next.uiScale, 1.2)
  })

  it('normalizes gitAgentModel with default fallback', () => {
    assert.equal(normalizeAppSettings({}).gitAgentModel, 'gpt-5.4 xhigh')
    assert.equal(normalizeAppSettings({ gitAgentModel: '  o3-pro high  ' }).gitAgentModel, 'o3-pro high')
    assert.equal(normalizeAppSettings({ gitAgentModel: '' }).gitAgentModel, 'gpt-5.4 xhigh')
  })

  it('enables cross-provider skill reuse by default and preserves explicit opt-out', () => {
    assert.equal(createDefaultSettings().crossProviderSkillReuseEnabled, true)
    assert.equal(normalizeAppSettings({}).crossProviderSkillReuseEnabled, true)
    assert.equal(normalizeAppSettings({ crossProviderSkillReuseEnabled: false }).crossProviderSkillReuseEnabled, false)
  })

  it('normalizes the system prompt with the built-in default fallback', () => {
    assert.equal(createDefaultSettings().systemPrompt, defaultSystemPrompt)
    assert.equal(normalizeAppSettings({}).systemPrompt, defaultSystemPrompt)
    assert.equal(normalizeAppSettings({ systemPrompt: '' }).systemPrompt, defaultSystemPrompt)
    assert.equal(
      normalizeAppSettings({ systemPrompt: '  Always verify before claiming success.  ' }).systemPrompt,
      'Always verify before claiming success.',
    )
  })

  it('exposes the default quick tool cards, keeps optional ambience cards opt-in, and leaves archived brainstorm hidden', () => {
    const defaults = createDefaultSettings()

    assert.deepEqual(getAvailableQuickToolModels(defaults), [
      GIT_TOOL_MODEL,
      FILETREE_TOOL_MODEL,
      STICKYNOTE_TOOL_MODEL,
    ])
    assert.deepEqual(
      getAvailableQuickToolModels(
        normalizeAppSettings({
          gitCardEnabled: false,
          brainstormCardEnabled: true,
          experimentalWeatherEnabled: true,
          experimentalMusicEnabled: true,
        }),
      ),
      [
        FILETREE_TOOL_MODEL,
        STICKYNOTE_TOOL_MODEL,
        WEATHER_TOOL_MODEL,
        MUSIC_TOOL_MODEL,
      ],
    )
  })

  it('hides ambience quick tool cards once an ambience tool card is already open', () => {
    const settings = normalizeAppSettings({
      experimentalWeatherEnabled: true,
      experimentalMusicEnabled: true,
      experimentalWhiteNoiseEnabled: true,
    })
    const chatCard = createCard('Chat', undefined, 'codex', DEFAULT_CODEX_MODEL, undefined, 'en')
    const weatherCard = createCard('Weather', undefined, 'codex', WEATHER_TOOL_MODEL, undefined, 'en')
    const column = createColumn({
      cards: {
        [chatCard.id]: chatCard,
        [weatherCard.id]: weatherCard,
      },
      layout: {
        type: 'pane',
        id: 'pane-ambience',
        tabs: [chatCard.id, weatherCard.id],
        activeTabId: chatCard.id,
      },
    }, 'en')

    assert.deepEqual(getAvailableQuickToolModels(settings, [column]), [
      GIT_TOOL_MODEL,
      FILETREE_TOOL_MODEL,
      STICKYNOTE_TOOL_MODEL,
    ])
  })

  it('returns a stable quick tool array when column churn does not change availability', () => {
    const settings = normalizeAppSettings({
      experimentalWeatherEnabled: true,
      experimentalMusicEnabled: true,
      experimentalWhiteNoiseEnabled: true,
    })
    const chatCard = createCard('Chat', undefined, 'codex', DEFAULT_CODEX_MODEL, undefined, 'en')
    const nextChatCard = { ...chatCard, draft: 'still thinking' }
    const layout = {
      type: 'pane' as const,
      id: 'pane-quick-tools',
      tabs: [chatCard.id],
      activeTabId: chatCard.id,
    }
    const columnsBefore = [createColumn({
      cards: {
        [chatCard.id]: chatCard,
      },
      layout,
    }, 'en')]
    const columnsAfter = [createColumn({
      cards: {
        [nextChatCard.id]: nextChatCard,
      },
      layout,
    }, 'en')]

    const quickToolsBefore = getAvailableQuickToolModels(settings, columnsBefore)
    const quickToolsAfter = getAvailableQuickToolModels(settings, columnsAfter)

    assert.equal(
      quickToolsAfter,
      quickToolsBefore,
      'availability did not change, so callers should be able to reuse the same quick-tool array reference',
    )
  })

  it('converts legacy relative card sizes and keeps modern pixel values', () => {
    assert.equal(normalizeCardSize(40), 380)
    assert.equal(normalizeCardSize(520), 520)
    assert.equal(normalizeCardSize(undefined), 440)
  })

  it('uses a reduced default and minimum height for Git cards', () => {
    assert.equal(getCardDefaultSize(GIT_TOOL_MODEL), 100)
    assert.equal(getCardMinimumSize(GIT_TOOL_MODEL), 1)
    assert.equal(
      normalizeCardSize(80, getCardMinimumSize(GIT_TOOL_MODEL), getCardDefaultSize(GIT_TOOL_MODEL)),
      80,
    )
    assert.equal(createCard('Git', undefined, 'codex', GIT_TOOL_MODEL).size, 100)
    assert.equal(createCard('Git', 80, 'codex', GIT_TOOL_MODEL).size, 80)
  })

  it('uses reduced min/default height for white noise cards (35% smaller)', () => {
    assert.equal(getCardMinimumSize(WHITENOISE_TOOL_MODEL), 208)
    assert.equal(normalizeCardSize(150, getCardMinimumSize(WHITENOISE_TOOL_MODEL)), 208)
    assert.equal(createCard('WhiteNoise', undefined, 'codex', WHITENOISE_TOOL_MODEL).size, 286)
  })

  it('normalizes persisted column widths and leaves unset columns flexible', () => {
    assert.equal(normalizeColumnWidth(180), minColumnWidth)
    assert.equal(normalizeColumnWidth(520.4), 520)
    assert.equal(normalizeColumnWidth(undefined), undefined)
  })

  it('builds compact chat titles from prompts', () => {
    assert.equal(titleFromPrompt('   hello   chill   vibe   '), 'hello chill vibe')
    assert.equal(titleFromPrompt('x'.repeat(80)), `${'x'.repeat(38)}...`)
    assert.equal(titleFromPrompt('   ', 'Fallback title'), 'Fallback title')
    assert.equal(
      titleFromPrompt('<command-name>/cost</command-name> <command-message>cost</command-message>'),
      '/cost cost',
    )
  })

  it('creates empty titles before a prompt arrives', () => {
    const zhState = createDefaultState('', 'zh-CN')
    const enState = createDefaultState('', 'en')

    assert.deepEqual(
      zhState.columns.flatMap((column) => Object.values(column.cards).map((card) => card.title)),
      ['', '', ''],
    )
    assert.deepEqual(
      enState.columns.flatMap((column) => Object.values(column.cards).map((card) => card.title)),
      ['', '', ''],
    )
  })

  it('creates each workspace as a single pane whose tabs point into the flat card map', () => {
    const state = createDefaultState('D:/repo')

    for (const column of state.columns) {
      const pane = column.layout as PaneNode
      assert.equal(pane.type, 'pane')
      assert.deepEqual(pane.tabs, Object.keys(column.cards))
      assert.equal(pane.activeTabId, pane.tabs[0] ?? '')
      assert.ok(pane.tabs.every((tabId) => tabId in column.cards))
    }
  })

  it('keys every default card map entry by the underlying card id', () => {
    const state = createDefaultState('D:/repo')

    for (const column of state.columns) {
      assert.deepEqual(
        Object.entries(column.cards).map(([cardId, card]) => cardId === card.id),
        Object.keys(column.cards).map(() => true),
      )
    }
  })
})
