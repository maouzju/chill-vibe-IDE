import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { attachImagesToMessageMeta } from '../shared/chat-attachments.ts'
import type { ChatMessage, ImageAttachment } from '../shared/schema.ts'
import {
  buildSeededChatPrompt,
  collectSeededChatAttachments,
  hasSeededChatTranscript,
} from '../src/chat-request-seeding.ts'

const timestamp = '2026-04-11T10:00:00.000Z'

const createMessage = (
  id: string,
  role: ChatMessage['role'],
  content: string,
  meta?: ChatMessage['meta'],
): ChatMessage => ({
  id,
  role,
  content,
  createdAt: timestamp,
  meta,
})

const imageAttachment: ImageAttachment = {
  id: 'attachment-1.png',
  fileName: 'wireframe.png',
  mimeType: 'image/png',
  sizeBytes: 1024,
}

const secondImageAttachment: ImageAttachment = {
  id: 'attachment-2.png',
  fileName: 'state-machine.png',
  mimeType: 'image/png',
  sizeBytes: 2048,
}

describe('chat request seeding', () => {
  it('detects when a transcript needs to be replayed into a fresh session', () => {
    assert.equal(
      hasSeededChatTranscript({
        sessionId: undefined,
        messages: [createMessage('user-1', 'user', 'Walk me through the reducer.')],
      }),
      true,
    )

    assert.equal(
      hasSeededChatTranscript({
        sessionId: 'session-123',
        messages: [createMessage('user-1', 'user', 'Walk me through the reducer.')],
      }),
      false,
    )

    assert.equal(
      hasSeededChatTranscript({
        sessionId: undefined,
        messages: [createMessage('sys-1', 'system', 'Local CLI unavailable.')],
      }),
      false,
    )
  })

  it('replays user and assistant turns while skipping system noise and keeping structured activity', () => {
    const prompt = buildSeededChatPrompt({
      language: 'en',
      prompt: 'Now fork from the assistant answer and add tests.',
      attachments: [],
      messages: [
        createMessage('user-1', 'user', 'Find the reducer bug.'),
        createMessage('assistant-1', 'assistant', 'The stale tab history lives in state.ts.'),
        createMessage('log-1', 'assistant', 'pnpm test', { kind: 'log', provider: 'codex' }),
        createMessage('tool-1', 'assistant', '', {
          kind: 'tool',
          provider: 'codex',
          structuredData: '{"tool":"Read"}',
        }),
        createMessage('system-1', 'system', 'The local CLI is unavailable.'),
      ],
    })

    assert.match(prompt, /Continue this conversation in a new session/i)
    assert.match(prompt, /User:\s+Find the reducer bug\./i)
    assert.match(prompt, /Assistant:\s+The stale tab history lives in state\.ts\./i)
    assert.match(prompt, /Latest user message:\s+Now fork from the assistant answer and add tests\./i)
    assert.doesNotMatch(prompt, /Local CLI unavailable/i)
    assert.doesNotMatch(prompt, /pnpm test/i)
    assert.match(prompt, /Structured tool data:/i)
    assert.match(prompt, /Read/i)
  })

  it('includes attachment context for replayed turns and image-only latest turns', () => {
    const prompt = buildSeededChatPrompt({
      language: 'en',
      prompt: '',
      attachments: [imageAttachment],
      messages: [
        createMessage(
          'user-1',
          'user',
          'Compare this sketch with the current layout.',
          attachImagesToMessageMeta([imageAttachment]),
        ),
      ],
    })

    assert.match(prompt, /wireframe\.png/i)
    assert.match(prompt, /latest user turn includes 1 attached image/i)
  })

  it('turns a blank continuation into an explicit continue instruction instead of "no text"', () => {
    const messages = [
      createMessage('user-1', 'user', 'Fix the reducer bug.'),
      createMessage('assistant-1', 'assistant', 'I found the bug but have not verified the fix yet.'),
    ]

    const englishPrompt = buildSeededChatPrompt({
      language: 'en',
      prompt: '',
      attachments: [],
      messages,
    })
    assert.doesNotMatch(englishPrompt, /includes no text/i)
    assert.match(englishPrompt, /Please continue\./)

    const chinesePrompt = buildSeededChatPrompt({
      language: 'zh-CN',
      prompt: '',
      attachments: [],
      messages,
    })
    assert.doesNotMatch(chinesePrompt, /没有文本内容/)
    assert.match(chinesePrompt, /请继续。/)
  })

  it('replays historical image attachments into the first forked request', () => {
    const attachments = collectSeededChatAttachments({
      messages: [
        createMessage(
          'user-1',
          'user',
          'Compare this earlier sketch with the live board.',
          attachImagesToMessageMeta([imageAttachment]),
        ),
        createMessage(
          'assistant-1',
          'assistant',
          'The earlier sketch is calmer.',
          attachImagesToMessageMeta([secondImageAttachment]),
        ),
      ],
      attachments: [secondImageAttachment],
    })

    assert.deepEqual(
      attachments.map((attachment) => attachment.id),
      ['attachment-1.png', 'attachment-2.png'],
    )
  })

  it('keeps only visible-segment attachments after a compact boundary', () => {
    const attachments = collectSeededChatAttachments({
      provider: 'codex',
      status: 'idle',
      messages: [
        createMessage(
          'user-1',
          'user',
          'Older hidden image context.',
          attachImagesToMessageMeta([imageAttachment]),
        ),
        createMessage('compact-1', 'user', '/compact', {
          provider: 'codex',
          compactBoundary: 'true',
        }),
        createMessage(
          'assistant-1',
          'assistant',
          'Visible image context after compact.',
          attachImagesToMessageMeta([secondImageAttachment]),
        ),
      ],
      attachments: [],
    })

    assert.deepEqual(
      attachments.map((attachment) => attachment.id),
      ['attachment-2.png'],
    )
  })

  it('replays structured agent activity with its full details', () => {
    const prompt = buildSeededChatPrompt({
      language: 'en',
      prompt: 'Continue from that branch and finish the fix.',
      attachments: [],
      messages: [
        createMessage('user-1', 'user', 'Please inspect the failing reducer path.'),
        createMessage('tool-1', 'assistant', '', {
          kind: 'tool',
          provider: 'codex',
          structuredData: JSON.stringify({
            itemId: 'tool-1',
            kind: 'tool',
            status: 'completed',
            toolName: 'Read',
            summary: 'Inspected src/state.ts',
            toolInput: {
              file_path: 'src/state.ts',
              offset: '1740',
              limit: '80',
            },
          }),
        }),
        createMessage('command-1', 'assistant', '', {
          kind: 'command',
          provider: 'codex',
          structuredData: JSON.stringify({
            itemId: 'command-1',
            status: 'completed',
            command: 'pnpm test -- --test-name-pattern forkConversation',
            output: '9 tests passed',
            exitCode: 0,
          }),
        }),
        createMessage('reasoning-1', 'assistant', '', {
          kind: 'reasoning',
          provider: 'codex',
          structuredData: JSON.stringify({
            itemId: 'reasoning-1',
            text: 'The reducer already forks the card, but the next request loses tool context.',
          }),
        }),
        createMessage('todo-1', 'assistant', '', {
          kind: 'todo',
          provider: 'codex',
          structuredData: JSON.stringify({
            itemId: 'todo-1',
            status: 'completed',
            items: [
              {
                id: 'todo-item-1',
                content: 'Carry structured tool history into the fork seed',
                activeForm: 'Carrying structured tool history into the fork seed',
                status: 'in_progress',
                priority: 'high',
              },
            ],
          }),
        }),
        createMessage('edits-1', 'assistant', '', {
          kind: 'edits',
          provider: 'codex',
          structuredData: JSON.stringify({
            itemId: 'edits-1',
            status: 'completed',
            files: [
              {
                path: 'src/App.tsx',
                kind: 'modified',
                addedLines: 12,
                removedLines: 1,
                patch: '@@ -2330,6 +2330,17 @@\n+const requestPrompt = buildSeededChatPrompt(...)',
              },
            ],
          }),
        }),
        createMessage('ask-user-1', 'assistant', '', {
          kind: 'ask-user',
          provider: 'codex',
          structuredData: JSON.stringify({
            itemId: 'ask-user-1',
            question: 'Should the fork inherit the full tool transcript?',
            options: [
              { label: 'Yes, full context', description: 'Keep the full structured history.' },
              { label: 'No, text only', description: 'Only replay visible prose.' },
            ],
          }),
        }),
      ],
    })

    assert.match(prompt, /Tool: Read/i)
    assert.match(prompt, /file_path: src\/state\.ts/i)
    assert.match(prompt, /Command: pnpm test -- --test-name-pattern forkConversation/i)
    assert.match(prompt, /9 tests passed/i)
    assert.match(prompt, /Exit code: 0/i)
    assert.match(prompt, /Reasoning:/i)
    assert.match(prompt, /loses tool context/i)
    assert.match(prompt, /Todo:/i)
    assert.match(prompt, /Carry structured tool history into the fork seed/i)
    assert.match(prompt, /Edits:/i)
    assert.match(prompt, /src\/App\.tsx/i)
    assert.match(prompt, /buildSeededChatPrompt/i)
    assert.match(prompt, /Ask user:/i)
    assert.match(prompt, /Yes, full context/i)
  })

  it('prefers the latest compacted transcript segment when a compact boundary exists', () => {
    const prompt = buildSeededChatPrompt({
      language: 'en',
      provider: 'codex',
      status: 'idle',
      prompt: 'Keep going from the compacted branch.',
      attachments: [],
      messages: [
        createMessage('user-1', 'user', 'Older context that should stay hidden after compact.'),
        createMessage('assistant-1', 'assistant', 'Older answer that should stay hidden after compact.'),
        createMessage('compact-1', 'user', '/compact', {
          provider: 'codex',
          compactBoundary: 'true',
        }),
        createMessage('assistant-2', 'assistant', 'Compacted summary of the earlier work.'),
        createMessage('user-2', 'user', 'Visible follow-up after compact.'),
      ],
    })

    assert.doesNotMatch(prompt, /Older context that should stay hidden/i)
    assert.doesNotMatch(prompt, /Older answer that should stay hidden/i)
    assert.match(prompt, /Compacted summary of the earlier work\./i)
    assert.match(prompt, /Visible follow-up after compact\./i)
  })

  it('does not replay hidden auto-compact boundary commands into seeded prompts', () => {
    const prompt = buildSeededChatPrompt({
      language: 'en',
      provider: 'codex',
      status: 'idle',
      prompt: 'Continue from the compacted branch.',
      attachments: [],
      messages: [
        createMessage('user-1', 'user', 'Older context that should stay hidden after compact.'),
        createMessage('assistant-1', 'assistant', 'Older answer that should stay hidden after compact.'),
        createMessage('compact-1', 'user', '/compact', {
          provider: 'codex',
          compactBoundary: 'true',
          compactTrigger: 'auto',
          compactHidden: 'true',
        }),
        createMessage('assistant-2', 'assistant', 'Compacted summary of the earlier work.'),
        createMessage('user-2', 'user', 'Visible follow-up after compact.'),
      ],
    })

    assert.doesNotMatch(prompt, /User:\s+Content:\s+\/compact/i)
    assert.match(prompt, /Compacted summary of the earlier work\./i)
    assert.match(prompt, /Visible follow-up after compact\./i)
  })

  it('skips transient reconnect placeholders when replaying a fresh-session prompt', () => {
    const prompt = buildSeededChatPrompt({
      language: 'en',
      provider: 'codex',
      status: 'streaming',
      prompt: 'Please continue.',
      attachments: [],
      messages: [
        createMessage('user-1', 'user', 'Finish the repair.'),
        createMessage('assistant-1', 'assistant', 'Reconnecting... 1/5'),
        createMessage('assistant-2', 'assistant', 'Reconnecting 2/5'),
      ],
    })

    assert.match(prompt, /Finish the repair\./i)
    assert.doesNotMatch(prompt, /Reconnecting/i)
  })

  it('keeps post-compact history available for seeded requests when the UI adds a performance window', () => {
    const prompt = buildSeededChatPrompt({
      language: 'en',
      provider: 'claude',
      status: 'idle',
      prompt: 'Continue from the visible branch.',
      attachments: [],
      messages: [
        createMessage('old-user', 'user', 'Older context that should stay hidden after compact.'),
        createMessage('old-assistant', 'assistant', 'Older answer that should stay hidden after compact.'),
        createMessage('compact-1', 'user', '/compact'),
        ...Array.from({ length: 260 }, (_, index) =>
          createMessage(
            `follow-up-${index + 1}`,
            index % 2 === 0 ? 'user' : 'assistant',
            index === 0
              ? 'First post-compact detail must stay available for seeded requests.'
              : index === 259
                ? 'Latest post-compact detail stays available too.'
                : '',
          ),
        ),
      ],
    })

    assert.doesNotMatch(prompt, /Older context that should stay hidden after compact\./i)
    assert.match(prompt, /First post-compact detail must stay available for seeded requests\./i)
    assert.match(prompt, /Latest post-compact detail stays available too\./i)
  })

  it('keeps long-chat history available for seeded requests when UI hides older messages for performance', () => {
    const prompt = buildSeededChatPrompt({
      language: 'en',
      provider: 'codex',
      status: 'idle',
      prompt: 'Continue from the existing work.',
      attachments: [],
      messages: Array.from({ length: 260 }, (_, index) =>
        createMessage(
          `message-${index + 1}`,
          index % 2 === 0 ? 'user' : 'assistant',
          index === 0
            ? 'Older context should still be replayed into the seeded request.'
            : index === 259
              ? 'Most recent context remains visible.'
              : '',
        ),
      ),
    })

    assert.match(prompt, /Older context should still be replayed into the seeded request\./i)
    assert.match(prompt, /Most recent context remains visible\./i)
  })

  it('compacts long fork transcripts to stay under the Windows command-line limit', () => {
    const prompt = buildSeededChatPrompt({
      language: 'en',
      prompt: 'Retry from the user prompt with a different solution.',
      attachments: [],
      messages: Array.from({ length: 18 }, (_, index) =>
        createMessage(
          `assistant-${index}`,
          index % 2 === 0 ? 'user' : 'assistant',
          `Transcript chunk ${index}: ${'x'.repeat(620)}`,
        ),
      ),
    })

    assert.ok(prompt.length <= 6_000, `expected seeded prompt to stay compact, got ${prompt.length}`)
    assert.match(prompt, /Latest user message:\s+Retry from the user prompt with a different solution\./i)
    assert.match(prompt, /Transcript chunk 17/i)
    assert.doesNotMatch(prompt, /Transcript chunk 1:/i)
  })

  it('keeps the full latest historical user prompt when seeding a fresh session', () => {
    const longPrompt = Array.from({ length: 1000 }, (_, index) =>
      index === 999
        ? 'line 1000: KEEP_THIS_TAIL_SENTINEL'
        : `line ${index + 1}: context detail`,
    ).join('\n')

    const prompt = buildSeededChatPrompt({
      language: 'en',
      prompt: 'What did I ask at the very end of my previous message?',
      attachments: [],
      messages: [
        createMessage('user-long', 'user', longPrompt),
        createMessage('assistant-ack', 'assistant', 'I will use the full request as context.'),
      ],
    })

    for (let index = 1; index <= 1000; index += 1) {
      const expectedLine = index === 1000
        ? 'line 1000: KEEP_THIS_TAIL_SENTINEL'
        : `line ${index}: context detail`
      assert.ok(prompt.includes(expectedLine), `missing replayed prompt line ${index}`)
    }
    assert.doesNotMatch(prompt, /Fork transcript truncated/i)
  })

  it('keeps a protected long user prompt even when earlier omitted messages need a notice', () => {
    const longPrompt = Array.from({ length: 1000 }, (_, index) =>
      index === 999
        ? 'line 1000: KEEP_PROTECTED_WITH_OMISSION_NOTICE'
        : `line ${index + 1}: protected context detail`,
    ).join('\n')

    const prompt = buildSeededChatPrompt({
      language: 'en',
      prompt: 'Continue from the preserved long request.',
      attachments: [],
      messages: [
        createMessage('older-assistant-1', 'assistant', `older assistant context ${'x'.repeat(3500)}`),
        createMessage('older-assistant-2', 'assistant', `another older assistant context ${'y'.repeat(3500)}`),
        createMessage('user-long', 'user', longPrompt),
      ],
    })

    assert.match(prompt, /Earlier transcript omitted:/i)
    assert.match(prompt, /line 1: protected context detail/i)
    assert.match(prompt, /line 1000: KEEP_PROTECTED_WITH_OMISSION_NOTICE/i)
    assert.doesNotMatch(prompt, /Fork transcript truncated/i)
  })

  it('keeps the full meaningful dialogue when transferring a long conversation to another model', () => {
    const messages: ChatMessage[] = [
      createMessage('foundational-user', 'user', 'FOUNDATIONAL GOAL: preserve the simulation design pillars.'),
      createMessage(
        'foundational-assistant',
        'assistant',
        `FOUNDATIONAL DECISION: the city simulation must stay event-driven. ${'decision-detail '.repeat(120)}`,
      ),
      ...Array.from({ length: 80 }, (_, index) =>
        createMessage(`command-${index + 1}`, 'assistant', '', {
          kind: 'command',
          structuredData: JSON.stringify({
            itemId: `command-${index + 1}`,
            kind: 'command',
            status: 'completed',
            command: `inspect-${index + 1}`,
            output: `late command output ${index + 1} ${'x'.repeat(900)}`,
            exitCode: 0,
          }),
        }),
      ),
      createMessage('latest-user', 'user', 'Continue from every decision above.'),
    ]

    const fallbackPrompt = buildSeededChatPrompt({
      language: 'en',
      prompt: 'Continue.',
      attachments: [],
      messages,
      provider: 'claude',
      status: 'idle',
    })
    const transferPrompt = buildSeededChatPrompt({
      language: 'en',
      prompt: 'Continue.',
      attachments: [],
      messages,
      provider: 'claude',
      status: 'idle',
      mode: 'model-transfer',
    })

    assert.doesNotMatch(fallbackPrompt, /FOUNDATIONAL DECISION/)
    assert.match(transferPrompt, /FOUNDATIONAL GOAL/)
    assert.match(transferPrompt, /FOUNDATIONAL DECISION/)
    assert.match(transferPrompt, /Continue from every decision above/)
  })

})
