import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  StructuredEditsCard,
} from '../src/components/StructuredBlocks.tsx'
import {
  buildStructuredDiffPreviewLines,
  structuredDiffPreviewMaxRows,
} from '../src/components/structured-diff-preview.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const createPatch = (lineCount: number) => [
  'diff --git a/src/large.ts b/src/large.ts',
  '--- a/src/large.ts',
  '+++ b/src/large.ts',
  '@@ -1,1 +1,1 @@',
  ...Array.from({ length: lineCount }, (_, index) => `+preview-line-${index}`),
].join('\n')

test('large structured diff previews stop after the bounded visible row budget', () => {
  const patch = createPatch(160)
  const rows = buildStructuredDiffPreviewLines(patch)

  assert.equal(structuredDiffPreviewMaxRows, 80)
  assert.equal(rows.length, structuredDiffPreviewMaxRows)
  assert.equal(rows[0]?.content, 'preview-line-0')
  assert.equal(rows.at(-1)?.content, 'preview-line-79')
  assert.ok(patch.includes('preview-line-159'), 'preview selection must not mutate the full source patch')
})

test('small structured diff previews preserve every non-metadata row', () => {
  assert.deepEqual(
    buildStructuredDiffPreviewLines(createPatch(3)).map((row) => row.content),
    ['preview-line-0', 'preview-line-1', 'preview-line-2'],
  )
})

test('structured edit cards do not mount the hidden tail of a large inline diff', () => {
  const patch = createPatch(160)
  const markup = renderToStaticMarkup(
    <StructuredEditsCard
      language="en"
      workspacePath="D:\\Git\\chill-vibe"
      data={{
        itemId: 'large-edit',
        status: 'completed',
        files: [{
          path: 'src/large.ts',
          kind: 'modified',
          addedLines: 160,
          removedLines: 0,
          patch,
        }],
      }}
    />,
  )

  assert.match(markup, /preview-line-0/)
  assert.match(markup, /preview-line-79/)
  assert.doesNotMatch(markup, /preview-line-80/)
  assert.doesNotMatch(markup, /preview-line-159/)
  assert.ok(patch.includes('preview-line-159'), 'the full patch remains available for the details dialog')
})
