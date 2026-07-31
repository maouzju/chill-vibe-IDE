import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveMessageLinkAction } from '../src/components/message-file-reference.ts'

const WORKSPACE = 'D:/Git/chill-vibe'

test('opens workspace files in the built-in editor when a handler is available', () => {
  assert.deepEqual(
    resolveMessageLinkAction({ href: 'src/state.ts', workspacePath: WORKSPACE, canOpenInEditor: true }),
    { kind: 'open-editor', openPath: 'src/state.ts', line: undefined },
  )
  assert.deepEqual(
    resolveMessageLinkAction({
      href: 'D:\\Git\\chill-vibe\\src\\state.ts#L42',
      workspacePath: WORKSPACE,
      canOpenInEditor: true,
    }),
    { kind: 'open-editor', openPath: 'src/state.ts', line: 42 },
  )
})

test('alt-click keeps the reveal-in-explorer escape hatch', () => {
  assert.deepEqual(
    resolveMessageLinkAction({
      href: 'src/state.ts',
      workspacePath: WORKSPACE,
      canOpenInEditor: true,
      altKey: true,
    }),
    { kind: 'reveal', href: 'src/state.ts' },
  )
})

test('falls back to reveal when the target is not an openable file', () => {
  assert.deepEqual(
    resolveMessageLinkAction({ href: 'docs/specs', workspacePath: WORKSPACE, canOpenInEditor: true }),
    { kind: 'reveal', href: 'docs/specs' },
  )
  assert.deepEqual(
    resolveMessageLinkAction({ href: 'src/state.ts', workspacePath: '', canOpenInEditor: true }),
    { kind: 'reveal', href: 'src/state.ts' },
  )
})

test('keeps the current reveal behaviour when no editor handler is mounted', () => {
  assert.deepEqual(
    resolveMessageLinkAction({ href: 'src/state.ts', workspacePath: WORKSPACE, canOpenInEditor: false }),
    { kind: 'reveal', href: 'src/state.ts' },
  )
})

test('routes external links and ignores empty or anchor-only hrefs', () => {
  assert.deepEqual(
    resolveMessageLinkAction({ href: 'https://example.com', workspacePath: WORKSPACE, canOpenInEditor: true }),
    { kind: 'external', href: 'https://example.com' },
  )
  assert.deepEqual(
    resolveMessageLinkAction({ href: '  ', workspacePath: WORKSPACE, canOpenInEditor: true }),
    { kind: 'none' },
  )
  assert.deepEqual(
    resolveMessageLinkAction({ href: '#section', workspacePath: WORKSPACE, canOpenInEditor: true }),
    { kind: 'none' },
  )
})
