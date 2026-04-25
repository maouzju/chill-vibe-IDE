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
})
