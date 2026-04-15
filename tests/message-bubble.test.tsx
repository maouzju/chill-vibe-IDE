import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { MessageBubble } from '../src/components/MessageBubble.tsx'
import { areMessageBubblePropsEqual } from '../src/components/message-bubble-memo.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

test('MessageBubble wraps sticky user prompts in a top-anchor shell', () => {
  const markup = renderToStaticMarkup(
    <MessageBubble
      language="en"
      message={{
        id: 'user-sticky-1',
        role: 'user',
        content: 'Keep this prompt visible while the reply streams.',
        createdAt: '2026-04-11T10:00:00.000Z',
      }}
      workspacePath="D:\\Git\\chill-vibe"
      answeredOption={null}
      onSelectAskUserOption={() => undefined}
      isStickyToTop
    />,
  )

  assert.match(markup, /class="message-entry message-entry-user"/)
  assert.match(markup, /class="message-entry-shell message-sticky-shell"/)
  assert.match(markup, /data-sticky-message-id="user-sticky-1"/)
  assert.match(markup, /class="message message-user is-sticky-anchor"/)
})

test('MessageBubble renders an external icon-only fork action for user prompts', () => {
  const markup = renderToStaticMarkup(
    <MessageBubble
      language="en"
      message={{
        id: 'user-fork-1',
        role: 'user',
        content: 'Branch from this prompt.',
        createdAt: '2026-04-11T10:05:00.000Z',
      }}
      workspacePath="D:\\Git\\chill-vibe"
      answeredOption={null}
      onSelectAskUserOption={() => undefined}
      onForkFromHere={() => undefined}
    />,
  )

  assert.match(markup, /class="message-entry message-entry-user"/)
  assert.match(markup, /class="message-actions message-actions-outside"/)
  assert.match(markup, /class="message-fork-btn"/)
  assert.match(markup, /title="Fork from here"/)
  assert.doesNotMatch(markup, /message-fork-label/)
  assert.match(markup, /<\/article><div class="message-actions message-actions-outside">/)
})

test('MessageBubble hides fork actions on structured assistant messages', () => {
  const markup = renderToStaticMarkup(
    <MessageBubble
      language="en"
      message={{
        id: 'assistant-todo-1',
        role: 'assistant',
        content: '',
        createdAt: '2026-04-11T10:05:00.000Z',
        meta: {
          kind: 'todo',
          provider: 'codex',
          structuredData: JSON.stringify({
            itemId: 'todo-1',
            status: 'completed',
            items: [
              {
                id: 'task-1',
                content: 'Carry forward the full fork transcript',
                status: 'completed',
              },
            ],
          }),
        },
      }}
      workspacePath="D:\\Git\\chill-vibe"
      answeredOption={null}
      onSelectAskUserOption={() => undefined}
      onForkFromHere={() => undefined}
    />,
  )

  assert.doesNotMatch(markup, /message-fork-btn/)
})

test('MessageBubble memo comparator ignores callback churn for unchanged message payloads', () => {
  const sharedMessage = {
    id: 'user-memo-1',
    role: 'user' as const,
    content: 'Stable message payload',
    createdAt: '2026-04-11T10:10:00.000Z',
  }

  const previousProps = {
    language: 'en' as const,
    message: sharedMessage,
    workspacePath: 'D:\\Git\\chill-vibe',
    answeredOption: null,
    onSelectAskUserOption: () => undefined,
    onForkFromHere: () => undefined,
    entryRef: () => undefined,
    isStickyToTop: false,
  }

  const nextProps = {
    ...previousProps,
    onSelectAskUserOption: () => undefined,
    onForkFromHere: () => undefined,
    entryRef: () => undefined,
  }

  assert.equal(areMessageBubblePropsEqual(previousProps, nextProps), true)
  assert.equal(
    areMessageBubblePropsEqual(previousProps, {
      ...nextProps,
      onOpenFile: () => undefined,
    }),
    false,
  )
  assert.equal(
    areMessageBubblePropsEqual(previousProps, {
      ...nextProps,
      message: {
        ...sharedMessage,
        content: 'Updated payload',
      },
    }),
    false,
  )
  assert.equal(
    areMessageBubblePropsEqual(previousProps, {
      ...nextProps,
      isStickyToTop: true,
    }),
    false,
  )
})
