import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createMessage } from '../shared/default-state.ts'
import type { CardStatus, ChatMessage, Provider } from '../shared/schema.ts'
import {
  getCompactMessageWindow,
  markCompactBoundaryMessage,
  shouldAutoCompactCodexConversation,
} from '../src/components/chat-card-compaction.ts'

const makeMessage = (
  id: string,
  role: ChatMessage['role'],
  content: string,
  meta?: ChatMessage['meta'],
): ChatMessage => ({
  id,
  role,
  content,
  createdAt: new Date(`2026-04-11T00:00:0${id.length % 10}.000Z`).toISOString(),
  meta,
})

const getWindow = (
  messages: ChatMessage[],
  provider: Provider = 'claude',
  status: CardStatus = 'idle',
  revealedHiddenMessageCount = 0,
) =>
  getCompactMessageWindow(messages, provider, status, {
    revealedHiddenMessageCount,
  })

describe('chat card compaction window', () => {
  it('keeps the full history when no compact command exists', () => {
    const messages = [
      makeMessage('m1', 'user', 'hello'),
      makeMessage('m2', 'assistant', 'hi'),
    ]

    assert.deepEqual(getWindow(messages), {
      hiddenMessageCount: 0,
      compactMessageId: null,
      hiddenReason: null,
      compactTrigger: null,
      visibleMessages: messages,
    })
  })

  it('shows only the latest compact segment by default once compact has completed', () => {
    const messages = [
      makeMessage('m1', 'user', 'first question'),
      makeMessage('m2', 'assistant', 'first answer'),
      makeMessage('m3', 'user', '/compact'),
      makeMessage('m4', 'assistant', 'compacted'),
      makeMessage('m5', 'user', 'follow-up'),
    ]

    assert.deepEqual(getWindow(messages, 'claude'), {
      hiddenMessageCount: 2,
      compactMessageId: 'm3',
      hiddenReason: 'compact',
      compactTrigger: 'manual',
      visibleMessages: messages.slice(2),
    })
  })

  it('does not hide earlier messages while the latest compact request is still streaming', () => {
    const messages = [
      makeMessage('m1', 'user', 'first question'),
      makeMessage('m2', 'assistant', 'first answer'),
      makeMessage('m3', 'user', '/compact'),
    ]

    assert.deepEqual(getWindow(messages, 'claude', 'streaming'), {
      hiddenMessageCount: 0,
      compactMessageId: null,
      hiddenReason: null,
      compactTrigger: null,
      visibleMessages: messages,
    })
  })

  it('restores the full history when the compact segment is fully revealed', () => {
    const messages = [
      makeMessage('m1', 'user', 'first question'),
      makeMessage('m2', 'assistant', 'first answer'),
      makeMessage('m3', 'user', '/compact'),
      makeMessage('m4', 'assistant', 'compacted'),
    ]

    assert.deepEqual(getWindow(messages, 'claude', 'idle', Number.POSITIVE_INFINITY), {
      hiddenMessageCount: 0,
      compactMessageId: 'm3',
      hiddenReason: 'compact',
      compactTrigger: 'manual',
      visibleMessages: messages,
    })
  })

  it('does not treat /compact text inside a codex chat as a compaction boundary', () => {
    const messages = [
      makeMessage('m1', 'user', 'first question'),
      makeMessage('m2', 'assistant', 'first answer'),
      makeMessage('m3', 'user', '/compact'),
      makeMessage('m4', 'assistant', 'literal response'),
    ]

    assert.deepEqual(getWindow(messages, 'codex'), {
      hiddenMessageCount: 0,
      compactMessageId: null,
      hiddenReason: null,
      compactTrigger: null,
      visibleMessages: messages,
    })
  })

  it('folds codex history when a message carries an explicit compaction marker', () => {
    const messages = [
      makeMessage('m1', 'user', 'first question'),
      makeMessage('m2', 'assistant', 'first answer'),
      makeMessage('m3', 'user', '/compact', { compactBoundary: 'true' }),
      makeMessage('m4', 'assistant', 'compacted'),
      makeMessage('m5', 'user', 'follow-up'),
    ]

    assert.deepEqual(getWindow(messages, 'codex'), {
      hiddenMessageCount: 2,
      compactMessageId: 'm3',
      hiddenReason: 'compact',
      compactTrigger: 'manual',
      visibleMessages: messages.slice(2),
    })
  })

  it('marks auto-compacted codex history distinctly from manual /compact boundaries', () => {
    const messages = [
      makeMessage('m1', 'user', 'first question'),
      makeMessage('m2', 'assistant', 'first answer'),
      makeMessage('m3', 'user', '/compact', {
        compactBoundary: 'true',
        compactTrigger: 'auto',
        compactHidden: 'true',
      }),
      makeMessage('m4', 'assistant', 'automatic compaction summary'),
      makeMessage('m5', 'user', 'follow-up'),
    ]

    assert.deepEqual(getWindow(messages, 'codex'), {
      hiddenMessageCount: 2,
      compactMessageId: 'm3',
      hiddenReason: 'compact',
      compactTrigger: 'auto',
      visibleMessages: messages.slice(2),
    })
  })

  it('reveals compacted history in smaller batches before the full transcript is restored', () => {
    const messages = [
      makeMessage('m1', 'user', 'first question'),
      makeMessage('m2', 'assistant', 'first answer'),
      makeMessage('m3', 'user', '/compact'),
      makeMessage('m4', 'assistant', 'compacted'),
      makeMessage('m5', 'user', 'follow-up'),
    ]

    assert.deepEqual(
      getCompactMessageWindow(messages, 'claude', 'idle', {
        revealedHiddenMessageCount: 1,
      }),
      {
        hiddenMessageCount: 1,
        compactMessageId: 'm3',
        hiddenReason: 'compact',
        compactTrigger: 'manual',
        visibleMessages: messages.slice(1),
      },
    )
  })

  it('temporarily hides older messages in very long chats even without an explicit compact boundary', () => {
    const messages = Array.from({ length: 260 }, (_, index) =>
      makeMessage(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `message ${index + 1}`),
    )

    assert.deepEqual(getWindow(messages, 'codex'), {
      hiddenMessageCount: 120,
      compactMessageId: 'm121',
      hiddenReason: 'performance',
      compactTrigger: null,
      visibleMessages: messages.slice(120),
    })
  })

  it('starts performance windowing earlier for command-heavy chats', () => {
    const messages = Array.from({ length: 100 }, (_, index) =>
      makeMessage(
        `m${index + 1}`,
        'assistant',
        '',
        index < 60 ? { kind: 'command', structuredData: '{"itemId":"cmd","status":"completed"}' } : undefined,
      ),
    )

    assert.deepEqual(getWindow(messages, 'codex'), {
      hiddenMessageCount: 44,
      compactMessageId: 'm45',
      hiddenReason: 'performance',
      compactTrigger: null,
      visibleMessages: messages.slice(44),
    })
  })

  it('restores the full transcript when a performance-windowed long chat is fully revealed', () => {
    const messages = Array.from({ length: 260 }, (_, index) =>
      makeMessage(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `message ${index + 1}`),
    )

    assert.deepEqual(getWindow(messages, 'codex', 'idle', Number.POSITIVE_INFINITY), {
      hiddenMessageCount: 0,
      compactMessageId: 'm121',
      hiddenReason: 'performance',
      compactTrigger: null,
      visibleMessages: messages,
    })
  })

  it('keeps an explicit compact boundary when only the pre-compact history is content-heavy', () => {
    const messages = [
      ...Array.from({ length: 60 }, (_, index) =>
        makeMessage(
          `old-${index + 1}`,
          index % 2 === 0 ? 'user' : 'assistant',
          `older heavy context ${index + 1} ${'x'.repeat(2_200)}`,
        ),
      ),
      makeMessage('compact-1', 'user', '/compact'),
      makeMessage('summary-1', 'assistant', 'Compacted summary.'),
      makeMessage('follow-up-1', 'user', 'Small follow-up after compact.'),
    ]

    assert.deepEqual(getWindow(messages, 'claude'), {
      hiddenMessageCount: 60,
      compactMessageId: 'compact-1',
      hiddenReason: 'compact',
      compactTrigger: 'manual',
      visibleMessages: messages.slice(60),
    })
  })

  it('continues auto-folding when the post-compact segment grows long again', () => {
    const messages = [
      makeMessage('m1', 'user', 'first question'),
      makeMessage('m2', 'assistant', 'first answer'),
      makeMessage('m3', 'user', '/compact'),
      ...Array.from({ length: 260 }, (_, index) =>
        makeMessage(
          `follow-up-${index + 1}`,
          index % 2 === 0 ? 'user' : 'assistant',
          `follow-up message ${index + 1}`,
        ),
      ),
    ]

    const compactWindow = getWindow(messages, 'claude')

    assert.equal(compactWindow.hiddenReason, 'performance')
    assert.equal(compactWindow.compactTrigger, null)
    assert.ok(compactWindow.hiddenMessageCount > 2)
    assert.deepEqual(compactWindow.visibleMessages, messages.slice(compactWindow.hiddenMessageCount))
  })

  it('keeps compact-window semantics when performance windowing is disabled', () => {
    const messages = [
      makeMessage('m1', 'user', 'first question'),
      makeMessage('m2', 'assistant', 'first answer'),
      makeMessage('m3', 'user', '/compact'),
      ...Array.from({ length: 260 }, (_, index) =>
        makeMessage(
          `follow-up-${index + 1}`,
          index % 2 === 0 ? 'user' : 'assistant',
          `follow-up message ${index + 1}`,
        ),
      ),
    ]

    assert.deepEqual(
      getCompactMessageWindow(messages, 'claude', 'idle', {
        allowPerformanceWindowing: false,
      }),
      {
        hiddenMessageCount: 2,
        compactMessageId: 'm3',
        hiddenReason: 'compact',
        compactTrigger: 'manual',
        visibleMessages: messages.slice(2),
      },
    )
  })

  it('fully reveals a performance window stacked on top of a compact boundary', () => {
    const messages = [
      makeMessage('m1', 'user', 'first question'),
      makeMessage('m2', 'assistant', 'first answer'),
      makeMessage('m3', 'user', '/compact'),
      ...Array.from({ length: 260 }, (_, index) =>
        makeMessage(
          `follow-up-${index + 1}`,
          index % 2 === 0 ? 'user' : 'assistant',
          `follow-up message ${index + 1}`,
        ),
      ),
    ]

    const compactWindow = getCompactMessageWindow(messages, 'claude', 'idle', {
      revealedHiddenMessageCount: Number.POSITIVE_INFINITY,
    })

    assert.equal(compactWindow.hiddenMessageCount, 0)
    assert.equal(compactWindow.hiddenReason, 'performance')
    assert.deepEqual(compactWindow.visibleMessages, messages)
  })

  it('auto-folds content-heavy chats before the message-count threshold', () => {
    const messages = Array.from({ length: 80 }, (_, index) =>
      makeMessage(
        `m${index + 1}`,
        index % 2 === 0 ? 'user' : 'assistant',
        `message ${index + 1} ${'x'.repeat(2_000)}`,
      ),
    )

    const compactWindow = getWindow(messages, 'codex')

    assert.equal(compactWindow.hiddenReason, 'performance')
    assert.ok(compactWindow.hiddenMessageCount > 0)
    assert.ok(compactWindow.hiddenMessageCount < messages.length)
    assert.deepEqual(compactWindow.visibleMessages, messages.slice(compactWindow.hiddenMessageCount))
  })

  it('auto-folds metadata-heavy structured chats before the message-count threshold', () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      makeMessage(`m${index + 1}`, 'assistant', '', {
        kind: 'command',
        structuredData: JSON.stringify({
          itemId: `cmd-${index + 1}`,
          status: 'completed',
          output: 'x'.repeat(4_000),
        }),
      }),
    )

    const compactWindow = getWindow(messages, 'codex')

    assert.equal(compactWindow.hiddenReason, 'performance')
    assert.ok(compactWindow.hiddenMessageCount > 0)
    assert.ok(compactWindow.hiddenMessageCount < messages.length)
    assert.deepEqual(compactWindow.visibleMessages, messages.slice(compactWindow.hiddenMessageCount))
  })

  it('can disable performance-only windowing for request seeding and archive derivation', () => {
    const messages = Array.from({ length: 260 }, (_, index) =>
      makeMessage(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `message ${index + 1}`),
    )

    assert.deepEqual(
      getCompactMessageWindow(messages, 'codex', 'idle', {
        allowPerformanceWindowing: false,
      }),
      {
        hiddenMessageCount: 0,
        compactMessageId: null,
        hiddenReason: null,
        compactTrigger: null,
        visibleMessages: messages,
      },
    )
  })

  it('reveals only part of a performance window until the user asks for more history', () => {
    const messages = Array.from({ length: 260 }, (_, index) =>
      makeMessage(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `message ${index + 1}`),
    )

    assert.deepEqual(
      getCompactMessageWindow(messages, 'codex', 'idle', {
        revealedHiddenMessageCount: 32,
      }),
      {
        hiddenMessageCount: 88,
        compactMessageId: 'm121',
        hiddenReason: 'performance',
        compactTrigger: null,
        visibleMessages: messages.slice(88),
      },
    )
  })

  it('does not request automatic compaction for long resumed codex sessions anymore', () => {
    const messages = Array.from({ length: 170 }, (_, index) =>
      makeMessage(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `message ${index + 1}`),
    )

    assert.equal(
      shouldAutoCompactCodexConversation({
        provider: 'codex',
        sessionId: 'codex-session-1',
        messages,
      }),
      false,
    )
  })

  it('does not request automatic compaction for seeded codex chats without a live session', () => {
    const messages = Array.from({ length: 220 }, (_, index) =>
      makeMessage(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `message ${index + 1}`),
    )

    assert.equal(
      shouldAutoCompactCodexConversation({
        provider: 'codex',
        sessionId: undefined,
        messages,
      }),
      false,
    )
  })

  it('keeps automatic compaction disabled even after an older compact boundary exists', () => {
    const messages = [
      ...Array.from({ length: 170 }, (_, index) =>
        makeMessage(`old-${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `older ${index + 1}`),
      ),
      makeMessage('compact-1', 'user', '/compact', {
        compactBoundary: 'true',
        compactTrigger: 'auto',
        compactHidden: 'true',
      }),
      makeMessage('summary-1', 'assistant', 'Automatic compaction summary.'),
      makeMessage('follow-up-1', 'user', 'Fresh work after the compact boundary.'),
      makeMessage('follow-up-2', 'assistant', 'Fresh answer after the compact boundary.'),
    ]

    assert.equal(
      shouldAutoCompactCodexConversation({
        provider: 'codex',
        sessionId: 'codex-session-1',
        messages,
      }),
      false,
    )
  })

  it('marks outgoing compact prompts with an explicit boundary while preserving existing meta', () => {
    const original = createMessage('user', '/compact', {
      imageAttachments: '[{"id":"img-1"}]',
    })

    assert.deepEqual(markCompactBoundaryMessage(original), {
      ...original,
      meta: {
        imageAttachments: '[{"id":"img-1"}]',
        compactBoundary: 'true',
        compactTrigger: 'manual',
      },
    })
  })

  it('can mark an auto-compaction boundary without rendering the raw slash command', () => {
    const original = createMessage('user', '/compact', {
      imageAttachments: '[{"id":"img-1"}]',
    })

    assert.deepEqual(markCompactBoundaryMessage(original, { trigger: 'auto', hidden: true }), {
      ...original,
      meta: {
        imageAttachments: '[{"id":"img-1"}]',
        compactBoundary: 'true',
        compactTrigger: 'auto',
        compactHidden: 'true',
      },
    })
  })
})
