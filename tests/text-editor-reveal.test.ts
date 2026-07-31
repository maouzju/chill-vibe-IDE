import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearPendingEditorReveals,
  consumePendingEditorReveal,
  PENDING_EDITOR_REVEAL_LIMIT,
  PENDING_EDITOR_REVEAL_TTL_MS,
  setPendingEditorReveal,
} from '../src/components/text-editor-reveal.ts'

const WORKSPACE = 'D:/Git/chill-vibe'

test('a queued reveal is delivered once and then forgotten', () => {
  clearPendingEditorReveals()
  setPendingEditorReveal(WORKSPACE, 'src/state.ts', 120)

  assert.equal(consumePendingEditorReveal(WORKSPACE, 'src/state.ts'), 120)
  assert.equal(consumePendingEditorReveal(WORKSPACE, 'src/state.ts'), null)
})

test('reveals are scoped to the workspace and file pair', () => {
  clearPendingEditorReveals()
  setPendingEditorReveal(WORKSPACE, 'src/state.ts', 12)

  assert.equal(consumePendingEditorReveal('D:/other', 'src/state.ts'), null)
  assert.equal(consumePendingEditorReveal(WORKSPACE, 'src/App.tsx'), null)
  assert.equal(consumePendingEditorReveal(WORKSPACE, 'src/state.ts'), 12)
})

test('a reveal that no card ever claimed expires instead of firing later', () => {
  clearPendingEditorReveals()
  setPendingEditorReveal(WORKSPACE, 'src/state.ts', 12, 1_000)

  assert.equal(
    consumePendingEditorReveal(WORKSPACE, 'src/state.ts', 1_000 + PENDING_EDITOR_REVEAL_TTL_MS + 1),
    null,
  )
})

test('the registry stays bounded when reveals are queued but never claimed', () => {
  clearPendingEditorReveals()

  for (let index = 0; index < PENDING_EDITOR_REVEAL_LIMIT + 5; index += 1) {
    setPendingEditorReveal(WORKSPACE, `src/file-${index}.ts`, index + 1)
  }

  assert.equal(consumePendingEditorReveal(WORKSPACE, 'src/file-0.ts'), null)
  assert.equal(
    consumePendingEditorReveal(WORKSPACE, `src/file-${PENDING_EDITOR_REVEAL_LIMIT + 4}.ts`),
    PENDING_EDITOR_REVEAL_LIMIT + 5,
  )
})

test('non-positive lines are ignored rather than queued', () => {
  clearPendingEditorReveals()
  setPendingEditorReveal(WORKSPACE, 'src/state.ts', 0)
  setPendingEditorReveal(WORKSPACE, 'src/other.ts', Number.NaN)

  assert.equal(consumePendingEditorReveal(WORKSPACE, 'src/state.ts'), null)
  assert.equal(consumePendingEditorReveal(WORKSPACE, 'src/other.ts'), null)
})
