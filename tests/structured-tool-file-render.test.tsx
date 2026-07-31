import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { StructuredToolDetailRow } from '../src/components/StructuredBlocks.tsx'
import { buildToolDetails } from '../src/components/structured-tool-details.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const WORKSPACE = 'D:/Git/chill-vibe'

const renderDetails = (
  toolName: string,
  toolInput: Record<string, string>,
  options: { workspacePath?: string; withHandler?: boolean } = {},
) => {
  const details = buildToolDetails('zh-CN', toolName, toolInput, options.workspacePath ?? WORKSPACE)

  return renderToStaticMarkup(
    <div>
      {details.map((detail) => (
        <StructuredToolDetailRow
          key={detail.label}
          language="zh-CN"
          detail={detail}
          onOpenFile={options.withHandler === false ? undefined : () => {}}
        />
      ))}
    </div>,
  )
}

test('a Read tool file path renders as an open-in-editor button carrying the read offset', () => {
  const html = renderDetails('Read', { file_path: 'src/state.ts', offset: '1800', limit: '120' })

  assert.ok(html.includes('data-open-file-path="src/state.ts"'), html)
  assert.ok(html.includes('data-open-file-line="1800"'), html)
  assert.ok(html.includes('message-file-reference'), html)
})

test('non-file tool details stay plain code with no button', () => {
  const html = renderDetails('Bash', { command: 'pnpm test', description: 'run tests' })

  assert.ok(!html.includes('<button'), html)
  assert.ok(!html.includes('data-open-file-path'), html)
  assert.ok(html.includes('structured-tool-detail-value'), html)
})

test('without an open handler the file path stays plain code', () => {
  const html = renderDetails('Read', { file_path: 'src/state.ts' }, { withHandler: false })

  assert.ok(!html.includes('<button'), html)
  assert.ok(html.includes('src/state.ts'), html)
})

test('without a workspace the file path stays plain code', () => {
  const html = renderDetails('Edit', { file_path: 'src/state.ts' }, { workspacePath: '' })

  assert.ok(!html.includes('<button'), html)
  assert.ok(html.includes('src/state.ts'), html)
})
