import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { resolveLocalImageRequestTarget } from '../electron/local-image-protocol.ts'
import { getLocalImageProtocolUrl, localImageProtocolScheme } from '../shared/local-image-protocol.ts'
import { renderMarkdown } from '../src/components/chat-card-rendering.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const localImageScheme = localImageProtocolScheme

const renderMarkdownHtml = (content: string, workspacePath?: string) =>
  renderToStaticMarkup(<div>{renderMarkdown(content, workspacePath)}</div>)

const extractImgSrc = (html: string) => {
  const match = html.match(/<img[^>]*\bsrc="([^"]*)"/)
  return match?.[1]?.replace(/&amp;/g, '&')
}

test('renderMarkdown rewrites a workspace-relative image path to the local image protocol', () => {
  const html = renderMarkdownHtml('![预览](screenshots/preview.png)', 'D:\\proj')
  const src = extractImgSrc(html)

  assert.ok(src, `expected an <img> in: ${html}`)
  assert.ok(
    src.startsWith(`${localImageScheme}://`),
    `expected local image protocol src, got: ${src}`,
  )

  const parsed = new URL(src)
  assert.equal(parsed.searchParams.get('src'), 'screenshots/preview.png')
  assert.equal(parsed.searchParams.get('workspace'), 'D:\\proj')
})

test('renderMarkdown rewrites an absolute Windows image path to the local image protocol', () => {
  // CommonMark would eat single backslashes in the destination, so the
  // renderer normalizes them to forward slashes before parsing.
  const html = renderMarkdownHtml('![预览](D:\\proj\\shot.png)')
  const src = extractImgSrc(html)

  assert.ok(src, `expected an <img> in: ${html}`)
  assert.ok(src.startsWith(`${localImageScheme}://`), `expected local image protocol src, got: ${src}`)
  assert.equal(new URL(src).searchParams.get('src'), 'D:/proj/shot.png')
})

test('resolveLocalImageRequestTarget resolves a forward-slash Windows image path', () => {
  const requestUrl = getLocalImageProtocolUrl('D:/proj/shot.png')
  assert.equal(resolveLocalImageRequestTarget(requestUrl), 'D:\\proj\\shot.png')
})

test('renderMarkdown rewrites a file:// image URL to the local image protocol', () => {
  const html = renderMarkdownHtml('![shot](file:///D:/proj/shot.png)')
  const src = extractImgSrc(html)

  assert.ok(src, `expected an <img> in: ${html}`)
  assert.ok(src.startsWith(`${localImageScheme}://`), `expected local image protocol src, got: ${src}`)
  assert.equal(new URL(src).searchParams.get('src'), 'file:///D:/proj/shot.png')
})

test('renderMarkdown keeps http(s), data and attachment image sources untouched', () => {
  for (const passthrough of [
    'https://example.com/a.png',
    'data:image/png;base64,AAAA',
    'chill-vibe-attachment://local/att-1',
  ]) {
    const html = renderMarkdownHtml(`![x](${passthrough})`)
    const src = extractImgSrc(html)
    assert.equal(src, passthrough, `expected passthrough for ${passthrough}, got: ${src}`)
  }
})

test('renderMarkdown keeps the image alt text', () => {
  const html = renderMarkdownHtml('![预览](screenshots/preview.png)', 'D:\\proj')
  assert.ok(html.includes('alt="预览"'), `expected alt to survive: ${html}`)
})

test('resolveLocalImageRequestTarget resolves a workspace-relative image path', () => {
  const requestUrl = getLocalImageProtocolUrl('screenshots/preview.png', 'D:\\proj')
  assert.equal(resolveLocalImageRequestTarget(requestUrl), 'D:\\proj\\screenshots\\preview.png')
})

test('resolveLocalImageRequestTarget resolves an absolute Windows image path', () => {
  const requestUrl = getLocalImageProtocolUrl('D:\\proj\\shot.png')
  assert.equal(resolveLocalImageRequestTarget(requestUrl), 'D:\\proj\\shot.png')
})

test('resolveLocalImageRequestTarget resolves a file:// image URL', () => {
  const requestUrl = getLocalImageProtocolUrl('file:///D:/proj/shot.png')
  assert.equal(resolveLocalImageRequestTarget(requestUrl), 'D:\\proj\\shot.png')
})

test('resolveLocalImageRequestTarget rejects non-image extensions', () => {
  const requestUrl = getLocalImageProtocolUrl('D:\\proj\\notes.txt')
  assert.equal(resolveLocalImageRequestTarget(requestUrl), null)
})

test('resolveLocalImageRequestTarget rejects malformed or empty requests', () => {
  assert.equal(resolveLocalImageRequestTarget('not a url'), null)
  assert.equal(resolveLocalImageRequestTarget(`${localImageScheme}://local/?src=`), null)
  assert.equal(resolveLocalImageRequestTarget(`${localImageScheme}://local/`), null)
})
