import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AGENT_PENDING_DEFAULT_MINUTES,
  AGENT_PENDING_MAX_MINUTES,
  AGENT_PENDING_MIN_MINUTES,
  buildAgentPendingCheckInPrompt,
  buildAgentPendingInstruction,
  isAgentDeclaredPending,
  parseAgentPendingMarker,
  planAgentPendingDeadlines,
  stripAgentPendingMarkers,
} from '../shared/agent-pending-marker.ts'
import { createCard, createDefaultSettings } from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import type { AppState, ChatCard, ChatRequest } from '../shared/schema.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'
import { ideReducer, selectDockedColumnStatus } from '../src/state.ts'
import { isWakeTimerPeerBackgroundBusy } from '../src/components/wake-timer.ts'
import {
  buildClaudeArgs,
  buildCodexAppServerBaseInstructions,
  buildCodexArgs,
  buildGeminiSystemPrompt,
} from '../server/providers.ts'

const card = (id: string, overrides: Partial<ChatCard> = {}): ChatCard => ({
  ...createCard(`Card ${id}`, undefined, 'codex', DEFAULT_CODEX_MODEL),
  id,
  ...overrides,
})

const buildState = (cards: Record<string, ChatCard>): AppState => ({
  version: 1,
  updatedAt: '2026-11-27T00:00:00.000Z',
  settings: createDefaultSettings(),
  sessionHistory: [],
  stickyNoteArchive: {},
  automationBoards: {},
  columns: [
    {
      id: 'column-1',
      title: 'Workspace',
      provider: 'codex',
      workspacePath: 'D:/repo/one',
      model: DEFAULT_CODEX_MODEL,
      width: undefined,
      layout: {
        type: 'pane',
        id: 'pane-1',
        tabs: Object.keys(cards),
        activeTabId: Object.keys(cards)[0] ?? '',
        tabHistory: Object.keys(cards),
      },
      cards,
    },
  ],
} as unknown as AppState)

describe('parseAgentPendingMarker', () => {
  it('reads the reason and minutes from the last marker', () => {
    const text = [
      '构建已经在后台起来了。',
      '<chill-vibe-pending minutes="5">旧的</chill-vibe-pending>',
      '<chill-vibe-pending minutes="20">等 GitHub CI 跑完 release 构建</chill-vibe-pending>',
    ].join('\n')
    assert.deepEqual(parseAgentPendingMarker(text), {
      reason: '等 GitHub CI 跑完 release 构建',
      minutes: 20,
    })
  })

  it('defaults and clamps minutes', () => {
    assert.equal(
      parseAgentPendingMarker('<chill-vibe-pending>x</chill-vibe-pending>')?.minutes,
      AGENT_PENDING_DEFAULT_MINUTES,
    )
    assert.equal(
      parseAgentPendingMarker('<chill-vibe-pending minutes="0">x</chill-vibe-pending>')?.minutes,
      AGENT_PENDING_MIN_MINUTES,
    )
    assert.equal(
      parseAgentPendingMarker('<chill-vibe-pending minutes="9999">x</chill-vibe-pending>')?.minutes,
      AGENT_PENDING_MAX_MINUTES,
    )
    assert.equal(
      parseAgentPendingMarker("<chill-vibe-pending minutes='abc'>x</chill-vibe-pending>")?.minutes,
      AGENT_PENDING_DEFAULT_MINUTES,
    )
  })

  it('falls back to a generic reason for an empty body', () => {
    assert.ok(parseAgentPendingMarker('<chill-vibe-pending minutes="3">  </chill-vibe-pending>')?.reason)
  })

  it('returns null without a marker', () => {
    assert.equal(parseAgentPendingMarker('全部做完了。'), null)
    assert.equal(parseAgentPendingMarker(''), null)
  })

  it('ignores a marker inside a fenced code block', () => {
    const text = '约定长这样：\n```\n<chill-vibe-pending minutes="5">示例</chill-vibe-pending>\n```\n已完成。'
    assert.equal(parseAgentPendingMarker(text), null)
  })
})

describe('stripAgentPendingMarkers', () => {
  it('removes closed markers and an unclosed streaming tail', () => {
    assert.equal(
      stripAgentPendingMarkers('构建在跑。\n\n<chill-vibe-pending minutes="20">等 CI</chill-vibe-pending>\n'),
      '构建在跑。',
    )
    assert.equal(stripAgentPendingMarkers('构建在跑。\n<chill-vibe-pending minutes="2'), '构建在跑。')
    assert.equal(stripAgentPendingMarkers('没有标记'), '没有标记')
  })
})

describe('isAgentDeclaredPending / planAgentPendingDeadlines', () => {
  const now = Date.parse('2026-11-27T10:00:00.000Z')

  it('only counts idle cards that still carry backgroundWorkPending and a deadline', () => {
    assert.equal(
      isAgentDeclaredPending({ status: 'idle', backgroundWorkPending: true, agentPendingUntil: '2026-11-27T10:10:00.000Z' }),
      true,
    )
    assert.equal(isAgentDeclaredPending({ status: 'idle', backgroundWorkPending: true }), false)
    assert.equal(
      isAgentDeclaredPending({ status: 'idle', backgroundWorkPending: false, agentPendingUntil: '2026-11-27T10:10:00.000Z' }),
      false,
    )
  })

  it('returns due cards and the next future deadline', () => {
    const plan = planAgentPendingDeadlines(
      [
        { id: 'due', status: 'idle', backgroundWorkPending: true, agentPendingUntil: '2026-11-27T09:59:00.000Z' },
        { id: 'later', status: 'idle', backgroundWorkPending: true, agentPendingUntil: '2026-11-27T10:05:00.000Z' },
        { id: 'streaming', status: 'streaming', backgroundWorkPending: true, agentPendingUntil: '2026-11-27T09:00:00.000Z' },
        { id: 'plain', status: 'idle' },
      ],
      now,
    )
    assert.deepEqual(plan.due, ['due'])
    assert.equal(plan.nextAt, Date.parse('2026-11-27T10:05:00.000Z'))
  })
})

describe('reducer keeps declared pending fields tied to backgroundWorkPending', () => {
  it('drops agentPendingReason/Until whenever backgroundWorkPending stops being true', () => {
    const state = buildState({
      a: card('a', {
        backgroundWorkPending: true,
        agentPendingReason: '等 CI',
        agentPendingUntil: '2026-11-27T10:10:00.000Z',
      }),
    })
    const next = ideReducer(state, {
      type: 'updateCard',
      columnId: 'column-1',
      cardId: 'a',
      patch: { status: 'idle', backgroundWorkPending: false },
    })
    const updated = next.columns[0]!.cards.a!
    assert.equal(updated.agentPendingReason, undefined)
    assert.equal(updated.agentPendingUntil, undefined)
  })

  it('docked chip treats an agent-declared pending card as running', () => {
    const status = selectDockedColumnStatus({
      cards: {
        a: card('a', {
          backgroundWorkPending: true,
          agentPendingReason: '等 CI',
          agentPendingUntil: '2026-11-27T10:10:00.000Z',
        }),
      },
      layout: { type: 'pane', id: 'p', tabs: ['a'], activeTabId: 'a', tabHistory: ['a'] },
    } as never)
    assert.equal(status.running, true)
  })
})

describe('wake timer peer busy', () => {
  it('counts a peer with an agent-declared pending marker as busy', () => {
    assert.equal(
      isWakeTimerPeerBackgroundBusy({
        messages: [],
        backgroundWorkPending: true,
        agentPendingUntil: '2026-11-27T10:10:00.000Z',
      }),
      true,
    )
    assert.equal(isWakeTimerPeerBackgroundBusy({ messages: [], backgroundWorkPending: true }), false)
  })
})

describe('system prompts carry the convention for every provider', () => {
  const request = (provider: ChatRequest['provider']): ChatRequest => ({
    provider,
    workspacePath: 'D:/repo/one',
    model: provider === 'claude' ? 'claude-opus-5' : DEFAULT_CODEX_MODEL,
    reasoningEffort: 'medium',
    thinkingEnabled: true,
    planMode: false,
    language: 'zh-CN',
    systemPrompt: defaultSystemPrompt,
    modelPromptRules: [],
    crossProviderSkillReuseEnabled: true,
    prompt: 'hi',
    attachments: [],
  } as ChatRequest)

  it('includes the marker tag in Claude, Codex exec, Codex app-server and Gemini prompts', () => {
    assert.match(buildClaudeArgs(request('claude'), [], {}).join(' '), /chill-vibe-pending/)
    assert.match(buildCodexArgs(request('codex'), []).join(' '), /chill-vibe-pending/)
    assert.match(buildCodexAppServerBaseInstructions(request('codex')), /chill-vibe-pending/)
    assert.match(buildGeminiSystemPrompt(request('gemini')), /chill-vibe-pending/)
  })

  it('has both languages and a check-in prompt naming the reason', () => {
    assert.match(buildAgentPendingInstruction('en'), /chill-vibe-pending/)
    assert.match(buildAgentPendingInstruction('zh-CN'), /chill-vibe-pending/)
    assert.match(buildAgentPendingCheckInPrompt('等 CI', 'zh-CN'), /等 CI/)
  })
})
