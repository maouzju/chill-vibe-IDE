import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { renderMarkdown } from '../src/components/chat-card-rendering.tsx'
import { MessageFileOpenContext } from '../src/components/message-file-open-context.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const WORKSPACE = 'D:/Git/chill-vibe'

const renderWithEditorHost = (content: string, workspacePath: string | undefined = WORKSPACE) =>
  renderToStaticMarkup(
    <MessageFileOpenContext.Provider value={{ open: () => {}, language: 'zh-CN' }}>
      <div>{renderMarkdown(content, workspacePath)}</div>
    </MessageFileOpenContext.Provider>,
  )

const openTargets = (html: string) =>
  Array.from(html.matchAll(/data-open-file-path="([^"]*)"/g)).map((match) => match[1])

test('inline code that names a workspace file becomes an open-in-editor button', () => {
  const html = renderWithEditorHost('真正的 4-5 秒在 `src/state.ts` 里')

  assert.deepEqual(openTargets(html), ['src/state.ts'])
  assert.ok(html.includes('message-file-reference'), html)
  assert.ok(html.includes('<button'), html)
})

test('inline code that is just an identifier stays plain code', () => {
  const html = renderWithEditorHost('用 `writeFileSync` 直接覆盖掉了，占 `2%`')

  assert.deepEqual(openTargets(html), [])
  assert.ok(!html.includes('<button'), html)
  assert.ok(html.includes('<code>writeFileSync</code>'), html)
})

test('line anchors survive into the button payload', () => {
  const html = renderWithEditorHost('见 `src/state.ts:120`')

  assert.deepEqual(openTargets(html), ['src/state.ts'])
  assert.ok(html.includes('data-open-file-line="120"'), html)
})

test('fenced code blocks never become click targets', () => {
  const html = renderWithEditorHost('```ts\nimport x from "src/state.ts"\n```')

  assert.deepEqual(openTargets(html), [])
  assert.ok(!html.includes('<button'), html)
})

test('without an editor host inline paths stay plain code', () => {
  const html = renderToStaticMarkup(<div>{renderMarkdown('见 `src/state.ts`', WORKSPACE)}</div>)

  assert.deepEqual(openTargets(html), [])
  assert.ok(!html.includes('<button'), html)
})

test('without a workspace path inline paths stay plain code', () => {
  const html = renderWithEditorHost('见 `src/state.ts`', '')

  assert.deepEqual(openTargets(html), [])
  assert.ok(!html.includes('<button'), html)
})

test('explicit markdown links keep anchor semantics but carry the editor target', () => {
  const html = renderWithEditorHost('详见 [清理脚本](scripts/clean-stale-dist.mjs)')

  assert.deepEqual(openTargets(html), ['scripts/clean-stale-dist.mjs'])
  assert.ok(html.includes('<a '), html)
  assert.ok(!html.includes('<button'), html)
})

test('external markdown links stay anchors', () => {
  const html = renderWithEditorHost('见 [文档](https://example.com/docs)')

  assert.deepEqual(openTargets(html), [])
  assert.ok(html.includes('href="https://example.com/docs"'), html)
})

test('an unfinished long Windows markdown link cannot block the renderer', () => {
  const moduleUrl = pathToFileURL(
    resolve('src/components/chat-card-rendering.tsx'),
  ).href
  const content = `[artifact](D:\\${'a'.repeat(48)}`
  const script = `
    import * as React from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    const { renderMarkdown } = await import(${JSON.stringify(moduleUrl)})
    globalThis.React = React
    renderToStaticMarkup(
      React.createElement('div', null, renderMarkdown(${JSON.stringify(content)}, ${JSON.stringify(WORKSPACE)})),
    )
  `
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { encoding: 'utf8', timeout: 4_000 },
  )
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code

  assert.equal(
    errorCode,
    undefined,
    `markdown render exceeded 4s: ${result.error?.message ?? ''}`,
  )
  assert.equal(result.status, 0, result.stderr)
})
